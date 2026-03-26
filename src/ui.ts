import blessed from "blessed";
import contrib from "blessed-contrib";
import { MetricEvent, MetricsBus } from "./events.js";

type Dashboard = {
  stop: () => void;
};

const HISTORY_SECONDS = 60;

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

  const tokensLine = grid.set(0, 0, 5, 8, contrib.line, {
    label: " Token Throughput (Tokens/s) ",
    showLegend: false,
    minY: 0,
    wholeNumbersOnly: true,
    style: {
      line: "magenta",
      text: "white",
      baseline: "cyan",
    },
  });

  const costBar = grid.set(0, 8, 5, 4, contrib.bar, {
    label: " Cost by Model (USD) ",
    barWidth: 7,
    barSpacing: 2,
    xOffset: 1,
    maxHeight: 10,
    barBgColor: "blue",
    barFgColor: "black",
  });

  const requestLog = grid.set(5, 0, 5, 8, contrib.log, {
    label: " Intercepted Requests ",
    fg: "green",
    selectedFg: "white",
  });

  const totalCostLcd = grid.set(5, 8, 5, 4, contrib.lcd, {
    label: " Total Session Cost ($) ",
    color: "cyan",
    segmentWidth: 0.08,
    segmentInterval: 0.03,
    strokeWidth: 0.1,
    elements: 8,
    display: "0.0000",
  });

  const footer = grid.set(10, 0, 2, 12, blessed.box, {
    tags: true,
    align: "center",
    valign: "middle",
    content:
      "{bold}AgentTop{/bold}  {gray-fg}::{/gray-fg}  monitor mode active  {gray-fg}::{/gray-fg}  press {bold}q{/bold} to exit",
    border: { type: "line" },
    style: { fg: "white", border: { fg: "magenta" } },
  });
  void footer;

  let totalSessionCost = 0;
  const perSecondTokens = new Map<number, number>();
  const modelCostTotals = new Map<string, number>();

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

  const renderTotalCost = (): void => {
    totalCostLcd.setDisplay(formatMoney(totalSessionCost));
  };

  const onMetric = (event: MetricEvent): void => {
    const nowSec = Math.floor(event.timestamp / 1000);
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

    requestLog.log(
      `[${event.statusCode}] ${event.model} | ${event.latencyMs}ms | ${event.totalTokens} tokens | $${event.costUsd.toFixed(4)} | ${event.method} ${event.path}`,
    );

    renderTokens();
    renderModelCost();
    renderTotalCost();
    screen.render();
  };

  metricsBus.onMetric(onMetric);
  renderTokens();
  renderModelCost();
  renderTotalCost();
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
