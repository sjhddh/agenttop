import blessed from "blessed";
import contrib from "blessed-contrib";
import { MetricEvent, MetricsBus } from "./events.js";

type Dashboard = {
  stop: () => void;
};

const HISTORY_SECONDS = 60;
const LATENCY_WINDOW = 30;

function formatMoney(value: number): string {
  return value.toFixed(4);
}

export function startDashboard(metricsBus: MetricsBus): Dashboard {
  const screen = blessed.screen({
    smartCSR: true,
    title: "AgentTop",
    fullUnicode: true,
    dockBorders: true,
  });

  screen.key(["escape", "q", "C-c"], () => {
    process.emit("SIGINT");
  });

  const grid = new contrib.grid({ rows: 12, cols: 12, screen });

  const tokensLine = grid.set(0, 0, 5, 7, contrib.line, {
    label: " Token Throughput (Tokens/s) ",
    showLegend: false,
    minY: 0,
    wholeNumbersOnly: true,
    style: {
      line: "green",
      text: "white",
      baseline: "magenta",
    },
  });

  const costBar = grid.set(0, 7, 5, 3, contrib.bar, {
    label: " Cost by Model (USD) ",
    barWidth: 5,
    barSpacing: 1,
    xOffset: 1,
    maxHeight: 10,
    barBgColor: "magenta",
    barFgColor: "black",
  });

  const latencySpark = grid.set(0, 10, 5, 2, contrib.sparkline, {
    label: " Latency (ms) ",
    tags: true,
    style: {
      fg: "yellow",
    },
  });

  const requestLog = grid.set(5, 0, 5, 7, contrib.log, {
    label: " Intercepted Requests ",
    fg: "green",
    selectedFg: "white",
  });

  const modelTable = grid.set(5, 7, 5, 3, contrib.table, {
    label: " Top Models ",
    keys: false,
    fg: "white",
    columnSpacing: 2,
    columnWidth: [11, 8],
  });

  const totalCostLcd = grid.set(5, 10, 5, 2, contrib.lcd, {
    label: " Total Session Cost ($) ",
    color: "green",
    segmentWidth: 0.08,
    segmentInterval: 0.03,
    strokeWidth: 0.1,
    elements: 8,
    display: "0.0000",
  });

  const hud = grid.set(10, 0, 2, 12, blessed.box, {
    tags: true,
    border: { type: "line" },
    style: {
      fg: "white",
      border: { fg: "cyan" },
    },
    content: "",
  });

  let totalSessionCost = 0;
  let requestsSeen = 0;
  const perSecondTokens = new Map<number, number>();
  const modelCostTotals = new Map<string, number>();
  const latencySamples: number[] = [];

  const renderTokens = (): void => {
    const nowSec = Math.floor(Date.now() / 1000);
    const x: string[] = [];
    const y: number[] = [];

    for (let i = HISTORY_SECONDS - 1; i >= 0; i -= 1) {
      const second = nowSec - i;
      const value = perSecondTokens.get(second) ?? 0;
      x.push(new Date(second * 1000).toLocaleTimeString("en-US", { minute: "2-digit", second: "2-digit" }));
      y.push(value);
    }

    tokensLine.setData([{ title: "tokens/s", x, y }]);
  };

  const renderModelCost = (): void => {
    const sorted = [...modelCostTotals.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6);

    if (sorted.length === 0) {
      costBar.setData({ titles: ["no-data"], data: [0] });
      return;
    }

    costBar.setData({
      titles: sorted.map(([model]) => model.slice(0, 10)),
      data: sorted.map(([, cost]) => Number(cost.toFixed(4))),
    });
  };

  const renderModelTable = (): void => {
    const rows = [...modelCostTotals.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([model, cost]) => [model.slice(0, 10), `$${cost.toFixed(4)}`]);

    modelTable.setData({
      headers: ["Model", "Cost"],
      data: rows.length > 0 ? rows : [["n/a", "$0.0000"]],
    });
  };

  const renderLatency = (): void => {
    latencySpark.setData(["latency"], [latencySamples]);
  };

  const renderTotalCost = (): void => {
    totalCostLcd.setDisplay(formatMoney(totalSessionCost));
  };

  const renderHud = (): void => {
    const avgLatency =
      latencySamples.length > 0
        ? latencySamples.reduce((sum, value) => sum + value, 0) / latencySamples.length
        : 0;
    const hottest = [...modelCostTotals.entries()].sort((a, b) => b[1] - a[1])[0];
    const hotModel = hottest ? hottest[0] : "n/a";

    hud.setContent(
      `{bold}AgentTop{/bold}  |  req: {green-fg}${requestsSeen}{/green-fg}  |  avg-latency: {yellow-fg}${avgLatency.toFixed(0)}ms{/yellow-fg}  |  top-model: {magenta-fg}${hotModel}{/magenta-fg}  |  {gray-fg}press{/gray-fg} {bold}q{/bold} {gray-fg}to exit{/gray-fg}`,
    );
  };

  const onMetric = (event: MetricEvent): void => {
    const nowSec = Math.floor(event.timestamp / 1000);
    requestsSeen += 1;
    const currentTokens = perSecondTokens.get(nowSec) ?? 0;
    perSecondTokens.set(nowSec, currentTokens + event.totalTokens);

    for (const second of [...perSecondTokens.keys()]) {
      if (second < nowSec - HISTORY_SECONDS) {
        perSecondTokens.delete(second);
      }
    }

    totalSessionCost += event.costUsd;
    const modelTotal = modelCostTotals.get(event.model) ?? 0;
    modelCostTotals.set(event.model, modelTotal + event.costUsd);
    latencySamples.push(event.latencyMs);
    if (latencySamples.length > LATENCY_WINDOW) {
      latencySamples.shift();
    }

    requestLog.log(
      `[${event.statusCode} OK] ${event.model} - ${(event.latencyMs / 1000).toFixed(2)}s - ${event.totalTokens} tokens - $${event.costUsd.toFixed(4)} - ${event.method} ${event.path}`,
    );

    renderTokens();
    renderModelCost();
    renderModelTable();
    renderLatency();
    renderTotalCost();
    renderHud();
    screen.render();
  };

  metricsBus.onMetric(onMetric);
  renderTokens();
  renderModelCost();
  renderModelTable();
  renderLatency();
  renderTotalCost();
  renderHud();
  screen.render();

  const refreshTicker = setInterval(() => {
    renderTokens();
    screen.render();
  }, 1000);

  return {
    stop: () => {
      clearInterval(refreshTicker);
      metricsBus.off("metric", onMetric);
      screen.destroy();
    },
  };
}
