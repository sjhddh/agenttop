import type { IncomingMessage, ServerResponse } from "node:http";
import type { Application } from "express";
import express from "express";
import {
  createProxyMiddleware,
  responseInterceptor,
} from "http-proxy-middleware";
import { MetricsBus, Provider } from "./events.js";

const OPENAI_TARGET = "https://api.openai.com";
const ANTHROPIC_TARGET = "https://api.anthropic.com";
const DEFAULT_PORT = 8080;

type ModelPricing = {
  promptPerMillionUsd: number;
  completionPerMillionUsd: number;
};

const MODEL_PRICING: Record<string, ModelPricing> = {
  "gpt-4o": { promptPerMillionUsd: 5, completionPerMillionUsd: 15 },
  "gpt-4o-mini": { promptPerMillionUsd: 0.15, completionPerMillionUsd: 0.6 },
  "claude-3-5-sonnet": { promptPerMillionUsd: 3, completionPerMillionUsd: 15 },
  "claude-3-5-haiku": { promptPerMillionUsd: 0.8, completionPerMillionUsd: 4 },
};

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

function resolvePricing(model: string): ModelPricing | null {
  const normalized = model.toLowerCase();
  const direct = MODEL_PRICING[normalized];
  if (direct) {
    return direct;
  }

  const prefixMatch = Object.entries(MODEL_PRICING).find(([prefix]) =>
    normalized.startsWith(prefix),
  );
  return prefixMatch ? prefixMatch[1] : null;
}

export function calculateCostUsd(
  model: string,
  promptTokens: number,
  completionTokens: number,
): number {
  const pricing = resolvePricing(model);
  if (!pricing) {
    return 0;
  }

  const promptCost = (promptTokens / 1_000_000) * pricing.promptPerMillionUsd;
  const completionCost = (completionTokens / 1_000_000) * pricing.completionPerMillionUsd;
  return promptCost + completionCost;
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

export function startProxy(options: StartProxyOptions): StartedProxy {
  const app = express();
  const port = options.port ?? DEFAULT_PORT;
  const startTimes = new WeakMap<IncomingMessage, number>();

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

          if (!shouldInspectResponse(proxyRes) || responseBuffer.length === 0) {
            options.metricsBus.emitMetric({
              provider,
              model: "unknown",
              promptTokens: 0,
              completionTokens: 0,
              totalTokens: 0,
              costUsd: 0,
              latencyMs,
              statusCode,
              timestamp: Date.now(),
              method,
              path,
            });
            return responseBuffer;
          }

          try {
            const payload = JSON.parse(responseBuffer.toString("utf8")) as Record<string, unknown>;
            const usage = parseUsage(payload, provider);
            const model = parseModel(payload);
            const costUsd = calculateCostUsd(model, usage.promptTokens, usage.completionTokens);

            options.metricsBus.emitMetric({
              provider,
              model,
              promptTokens: usage.promptTokens,
              completionTokens: usage.completionTokens,
              totalTokens: usage.totalTokens,
              costUsd,
              latencyMs,
              statusCode,
              timestamp: Date.now(),
              method,
              path,
            });
          } catch {
            options.metricsBus.emitMetric({
              provider,
              model: "unknown",
              promptTokens: 0,
              completionTokens: 0,
              totalTokens: 0,
              costUsd: 0,
              latencyMs,
              statusCode,
              timestamp: Date.now(),
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
