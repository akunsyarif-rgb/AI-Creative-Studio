import type { CustomProviderConfig } from "@/lib/data/repositories";

/** The user's own price for one model: its override if it has one (own property only), else the provider-wide estimate. */
export function userPriceFor(cfg: Pick<CustomProviderConfig, "estimatedCostUsd" | "modelPrices">, modelId: string | undefined): number | null {
  const prices = cfg.modelPrices;
  if (modelId && prices && Object.hasOwn(prices, modelId)) {
    const v = prices[modelId];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  }
  return cfg.estimatedCostUsd;
}
