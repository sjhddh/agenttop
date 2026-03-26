import { EventEmitter } from "node:events";

export type Provider = "openai" | "anthropic" | "unknown";

export interface MetricEvent {
  provider: Provider;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  latencyMs: number;
  statusCode: number;
  timestamp: number;
  method: string;
  path: string;
}

interface MetricsEvents {
  metric: (event: MetricEvent) => void;
}

export class MetricsBus extends EventEmitter {
  emitMetric(event: MetricEvent): boolean {
    return this.emit("metric", event);
  }

  onMetric(listener: MetricsEvents["metric"]): this {
    return this.on("metric", listener);
  }
}
