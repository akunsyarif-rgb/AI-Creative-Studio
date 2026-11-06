import type { CustomProviderConfig } from "@/lib/data/repositories";
import { createGenericHttpAdapter } from "./adapters/generic-http";
import { createOpenAICompatibleAdapter } from "./adapters/openai-compatible";
import type { SafeIODeps } from "./adapters/safe-io";
import type { ProviderAdapter } from "./types";

/** Chooses the adapter style for a user's custom provider: their own HTTP template, or OpenAI-compatible. */
export function buildCustomAdapter(config: CustomProviderConfig, deps: SafeIODeps = {}): ProviderAdapter {
  return config.http ? createGenericHttpAdapter({ ...config, http: config.http }, deps) : createOpenAICompatibleAdapter(config, deps);
}
