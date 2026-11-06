import type { CustomProviderConfig } from "@/lib/data/repositories";
import { createGenericHttpAdapter } from "./adapters/generic-http";
import { createOpenAICompatibleAdapter } from "./adapters/openai-compatible";
import { createSpicyApiAdapter, isSpicyBaseUrl } from "./adapters/spicyapi";
import type { SafeIODeps } from "./adapters/safe-io";
import type { ProviderAdapter } from "./types";

/**
 * Chooses the adapter style for a user's custom provider: their own HTTP template, SpicyAPI's native task API
 * (recognised by its API host), or OpenAI-compatible.
 */
export function buildCustomAdapter(config: CustomProviderConfig, deps: SafeIODeps = {}): ProviderAdapter {
  if (config.http) return createGenericHttpAdapter({ ...config, http: config.http }, deps);
  if (isSpicyBaseUrl(config.baseUrl)) return createSpicyApiAdapter(config, deps);
  return createOpenAICompatibleAdapter(config, deps);
}
