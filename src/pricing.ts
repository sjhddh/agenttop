export type ModelPricing = {
  promptPerMillionUsd: number;
  completionPerMillionUsd: number;
};

export const MODEL_PRICING: Record<string, ModelPricing> = {
  "gpt-4o": { promptPerMillionUsd: 5, completionPerMillionUsd: 15 },
  "gpt-4o-mini": { promptPerMillionUsd: 0.15, completionPerMillionUsd: 0.6 },
  "claude-3-5-sonnet": { promptPerMillionUsd: 3, completionPerMillionUsd: 15 },
  "claude-3-5-haiku": { promptPerMillionUsd: 0.8, completionPerMillionUsd: 4 },
};

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
