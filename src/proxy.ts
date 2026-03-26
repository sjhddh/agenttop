import type { IncomingMessage, ServerResponse } from "node:http";
import type { Application } from "express";
import express from "express";
import {
  createProxyMiddleware,
  responseInterceptor,
} from "http-proxy-middleware";
import { MetricsBus, Provider } from "./events.js";
import { calculateCostUsd } from "./pricing.js";

const OPENAI_TARGET = "https://api.openai.com";
const ANTHROPIC_TARGET = "https://api.anthropic.com";
const DEFAULT_PORT = 8080;

type UsageShape = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

type StartProxyOptions = {
  port?: number;
  metricsBus: MetricsBus;
};

type StartedProxy = {
  app: Application;
  close: () => Promise<void>;
};

type ProxyCounters = {
  requestsTotal: number;
  promptTokensTotal: number;
  completionTokensTotal: number;
  totalTokensTotal: number;
  totalCostUsd: number;
  latencyMsSum: number;
  latencyMsCount: number;
  perModelCost: Map<string, number>;
};

function detectProvider(req: IncomingMessage): Provider {
  const rawUrl = req.url ?? "";
  const lowerUrl = rawUrl.toLowerCase();
  const anthropicVersion = req.headers["anthropic-version"];
  const providerHeader = String(req.headers["x-agenttop-provider"] ?? "").toLowerCase();
  const hostHeader = String(req.headers.host ?? "").toLowerCase();

  if (
    providerHeader === "anthropic" ||
    typeof anthropicVersion === "string" ||
    lowerUrl.startsWith("/anthropic") ||
    lowerUrl.startsWith("/v1/messages") ||
    hostHeader.includes("anthropic")
  ) {
    return "anthropic";
  }

  if (
    providerHeader === "openai" ||
    lowerUrl.startsWith("/openai") ||
    lowerUrl.startsWith("/v1/chat/completions") ||
    lowerUrl.startsWith("/v1/responses") ||
    hostHeader.includes("openai")
  ) {
    return "openai";
  }

  return "openai";
}

export function parseUsage(payload: Record<string, unknown>, provider: Provider): UsageShape {
  const usageRaw = payload.usage as Record<string, unknown> | undefined;
  if (!usageRaw) {
    return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  }

  if (provider === "anthropic") {
    const promptTokens = Number(usageRaw.input_tokens ?? 0);
    const completionTokens = Number(usageRaw.output_tokens ?? 0);
    return {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
    };
  }

  const promptTokens = Number(usageRaw.prompt_tokens ?? 0);
  const completionTokens = Number(usageRaw.completion_tokens ?? 0);
  const totalTokens = Number(usageRaw.total_tokens ?? promptTokens + completionTokens);
  return { promptTokens, completionTokens, totalTokens };
}

export function parseModel(payload: Record<string, unknown>): string {
  const directModel = payload.model;
  if (typeof directModel === "string" && directModel.length > 0) {
    return directModel;
  }

  const message = payload.message as Record<string, unknown> | undefined;
  if (message && typeof message.model === "string" && message.model.length > 0) {
    return message.model;
  }

  return "unknown";
}

function shouldInspectResponse(proxyRes: IncomingMessage): boolean {
  const contentType = String(proxyRes.headers["content-type"] ?? "").toLowerCase();
  return contentType.includes("application/json");
}

function parseSseUsage(rawBody: string, provider: Provider): UsageShape {
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;

  const lines = rawBody.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) {
      continue;
    }

    const chunk = trimmed.slice(5).trim();
    if (chunk.length === 0 || chunk === "[DONE]") {
      continue;
    }

    try {
      const payload = JSON.parse(chunk) as Record<string, unknown>;
      const usage = parseUsage(payload, provider);
      promptTokens = Math.max(promptTokens, usage.promptTokens);
      completionTokens = Math.max(completionTokens, usage.completionTokens);
      totalTokens = Math.max(totalTokens, usage.totalTokens);

      // Anthropic streaming reports usage in nested message_delta payloads.
      const delta = payload.delta as Record<string, unknown> | undefined;
      const deltaUsage = delta?.usage as Record<string, unknown> | undefined;
      if (provider === "anthropic" && deltaUsage) {
        const deltaOutput = Number(deltaUsage.output_tokens ?? 0);
        completionTokens = Math.max(completionTokens, deltaOutput);
      }
    } catch {
      // Ignore malformed event chunks and continue parsing remaining stream events.
    }
  }

  if (totalTokens === 0) {
    totalTokens = promptTokens + completionTokens;
  }

  return { promptTokens, completionTokens, totalTokens };
}

function parseModelFromSse(rawBody: string): string {
  const lines = rawBody.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) {
      continue;
    }
    const chunk = trimmed.slice(5).trim();
    if (chunk.length === 0 || chunk === "[DONE]") {
      continue;
    }

    try {
      const payload = JSON.parse(chunk) as Record<string, unknown>;
      const model = parseModel(payload);
      if (model !== "unknown") {
        return model;
      }
    } catch {
      // Ignore malformed event chunks.
    }
  }

  return "unknown";
}

function incrementCounters(counters: ProxyCounters, model: string, usage: UsageShape, costUsd: number, latencyMs: number): void {
  counters.requestsTotal += 1;
  counters.promptTokensTotal += usage.promptTokens;
  counters.completionTokensTotal += usage.completionTokens;
  counters.totalTokensTotal += usage.totalTokens;
  counters.totalCostUsd += costUsd;
  counters.latencyMsSum += latencyMs;
  counters.latencyMsCount += 1;
  counters.perModelCost.set(model, (counters.perModelCost.get(model) ?? 0) + costUsd);
}

function renderPrometheusMetrics(counters: ProxyCounters): string {
  const lines: string[] = [
    "# HELP agenttop_requests_total Total intercepted API responses.",
    "# TYPE agenttop_requests_total counter",
    `agenttop_requests_total ${counters.requestsTotal}`,
    "# HELP agenttop_tokens_total Total token usage by type.",
    "# TYPE agenttop_tokens_total counter",
    `agenttop_tokens_total{type=\"prompt\"} ${counters.promptTokensTotal}`,
    `agenttop_tokens_total{type=\"completion\"} ${counters.completionTokensTotal}`,
    `agenttop_tokens_total{type=\"all\"} ${counters.totalTokensTotal}`,
    "# HELP agenttop_cost_usd_total Total estimated spend in USD.",
    "# TYPE agenttop_cost_usd_total counter",
    `agenttop_cost_usd_total ${counters.totalCostUsd}`,
    "# HELP agenttop_request_latency_ms_sum Sum of response latencies in milliseconds.",
    "# TYPE agenttop_request_latency_ms_sum counter",
    `agenttop_request_latency_ms_sum ${counters.latencyMsSum}`,
    "# HELP agenttop_request_latency_ms_count Number of responses included in latency metrics.",
    "# TYPE agenttop_request_latency_ms_count counter",
    `agenttop_request_latency_ms_count ${counters.latencyMsCount}`,
  ];

  for (const [model, modelCost] of counters.perModelCost.entries()) {
    const escapedModel = model.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
    lines.push(`agenttop_model_cost_usd_total{model="${escapedModel}"} ${modelCost}`);
  }

  return `${lines.join("\n")}\n`;
}

function emitAndTrack(
  options: StartProxyOptions,
  counters: ProxyCounters,
  eventBase: Omit<Parameters<MetricsBus["emitMetric"]>[0], "timestamp">,
): void {
  const event = { ...eventBase, timestamp: Date.now() };
  options.metricsBus.emitMetric(event);
  incrementCounters(
    counters,
    event.model,
    {
      promptTokens: event.promptTokens,
      completionTokens: event.completionTokens,
      totalTokens: event.totalTokens,
    },
    event.costUsd,
    event.latencyMs,
  );
}

export function startProxy(options: StartProxyOptions): StartedProxy {
  const app = express();
  const port = options.port ?? DEFAULT_PORT;
  const startTimes = new WeakMap<IncomingMessage, number>();
  const counters: ProxyCounters = {
    requestsTotal: 0,
    promptTokensTotal: 0,
    completionTokensTotal: 0,
    totalTokensTotal: 0,
    totalCostUsd: 0,
    latencyMsSum: 0,
    latencyMsCount: 0,
    perModelCost: new Map<string, number>(),
  };

  app.get("/metrics", (_req, res) => {
    res.setHeader("content-type", "text/plain; version=0.0.4");
    res.status(200).send(renderPrometheusMetrics(counters));
  });

  app.use(
    "/",
    createProxyMiddleware({
      target: OPENAI_TARGET,
      changeOrigin: true,
      selfHandleResponse: true,
      router: (req) => (detectProvider(req) === "anthropic" ? ANTHROPIC_TARGET : OPENAI_TARGET),
      pathRewrite: (path) => path.replace(/^\/(openai|anthropic)\b/i, ""),
      on: {
        proxyReq: (proxyReq, req) => {
          startTimes.set(req, Date.now());

          const provider = detectProvider(req);
          proxyReq.setHeader("x-agenttop-provider", provider);
        },
        proxyRes: responseInterceptor(async (responseBuffer, proxyRes, req) => {
          const start = startTimes.get(req) ?? Date.now();
          const latencyMs = Math.max(0, Date.now() - start);
          const provider = detectProvider(req);
          const statusCode = proxyRes.statusCode ?? 0;
          const method = req.method ?? "GET";
          const path = req.url ?? "/";

          if (responseBuffer.length === 0) {
            emitAndTrack(options, counters, {
              provider,
              model: "unknown",
              promptTokens: 0,
              completionTokens: 0,
              totalTokens: 0,
              costUsd: 0,
              latencyMs,
              statusCode,
              method,
              path,
            });
            return responseBuffer;
          }

          const contentType = String(proxyRes.headers["content-type"] ?? "").toLowerCase();
          if (shouldInspectResponse(proxyRes)) {
            try {
              const payload = JSON.parse(responseBuffer.toString("utf8")) as Record<string, unknown>;
              const usage = parseUsage(payload, provider);
              const model = parseModel(payload);
              const costUsd = calculateCostUsd(model, usage.promptTokens, usage.completionTokens);

              emitAndTrack(options, counters, {
                provider,
                model,
                promptTokens: usage.promptTokens,
                completionTokens: usage.completionTokens,
                totalTokens: usage.totalTokens,
                costUsd,
                latencyMs,
                statusCode,
                method,
                path,
              });
            } catch {
              emitAndTrack(options, counters, {
                provider,
                model: "unknown",
                promptTokens: 0,
                completionTokens: 0,
                totalTokens: 0,
                costUsd: 0,
                latencyMs,
                statusCode,
                method,
                path,
              });
            }
          } else if (contentType.includes("text/event-stream")) {
            const rawBody = responseBuffer.toString("utf8");
            const usage = parseSseUsage(rawBody, provider);
            const model = parseModelFromSse(rawBody);
            const costUsd = calculateCostUsd(model, usage.promptTokens, usage.completionTokens);

            emitAndTrack(options, counters, {
              provider,
              model,
              promptTokens: usage.promptTokens,
              completionTokens: usage.completionTokens,
              totalTokens: usage.totalTokens,
              costUsd,
              latencyMs,
              statusCode,
              method,
              path,
            });
          } else {
            emitAndTrack(options, counters, {
              provider,
              model: "unknown",
              promptTokens: 0,
              completionTokens: 0,
              totalTokens: 0,
              costUsd: 0,
              latencyMs,
              statusCode,
              method,
              path,
            });
          }

          return responseBuffer;
        }),
        error: (_err, _req, res) => {
          const typedRes = res as ServerResponse;
          if (!typedRes.headersSent) {
            typedRes.writeHead(502, { "content-type": "application/json" });
          }
          typedRes.end(JSON.stringify({ error: "AgentTop proxy upstream failure" }));
        },
      },
    }),
  );

  const server = app.listen(port);

  return {
    app,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
}
