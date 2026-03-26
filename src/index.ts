#!/usr/bin/env node
import chalk from "chalk";
import { Command } from "commander";
import { MetricsBus } from "./events.js";
import { startProxy } from "./proxy.js";
import { startDashboard } from "./ui.js";

const DEFAULT_PORT = 8080;

async function runStart(port: number): Promise<void> {
  const bus = new MetricsBus();
  const dashboard = startDashboard(bus);
  const proxy = startProxy({ port, metricsBus: bus });

  const printExitInstructions = (): void => {
    process.stdout.write(
      `\n${chalk.bold("To monitor your agents, set your AI dev tool's BASE_URL to http://localhost:8080/v1")}\n`,
    );
  };

  const shutdown = async (): Promise<void> => {
    process.removeListener("SIGINT", shutdown);
    process.removeListener("SIGTERM", shutdown);
    try {
      await proxy.close();
    } finally {
      dashboard.stop();
      printExitInstructions();
      process.exit(0);
    }
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  process.stdout.write(
    `${chalk.cyanBright("AgentTop")} ${chalk.gray("running")} ${chalk.green(`http://localhost:${port}`)} ${chalk.gray(`(prometheus: /metrics)`)}` + "\n",
  );
}

const program = new Command();

program
  .name("agenttop")
  .description("htop for AI Agents - token, cost, and latency monitor")
  .version("0.1.0");

program
  .command("start")
  .description("Start the AgentTop proxy and dashboard")
  .option("-p, --port <port>", "proxy port", String(DEFAULT_PORT))
  .action(async (options: { port: string }) => {
    const parsedPort = Number(options.port);
    const port = Number.isFinite(parsedPort) ? parsedPort : DEFAULT_PORT;
    await runStart(port);
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${chalk.red("AgentTop failed:")} ${message}\n`);
  process.exit(1);
});
