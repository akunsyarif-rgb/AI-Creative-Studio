import type { CustomProviderConfig, KeysRepository } from "@/lib/data/repositories";
import { CUSTOM_PREFIX } from "./adapters/openai-compatible";
import type { ProviderRegistry } from "./registry";
import type { Capability, ProviderAdapter } from "./types";

export interface ResolveDeps {
  providers: ProviderRegistry;
  keys: Pick<KeysRepository, "getCustomConfig">;
  /** Builds the adapter for a user's custom provider. */
  buildCustomAdapter: (config: CustomProviderConfig) => ProviderAdapter;
}

/**
 * Finds the adapter for `providerId`: a built-in one from the registry, or, for `custom-*` ids, one
 * built from the owner's saved settings. A user can only ever resolve their own custom providers.
 */
export async function resolveAdapter(deps: ResolveDeps, ownerId: string, providerId: string): Promise<ProviderAdapter | undefined> {
  const builtin = deps.providers.get(providerId);
  if (builtin) return builtin;
  if (!providerId.startsWith(CUSTOM_PREFIX)) return undefined;
  const config = await deps.keys.getCustomConfig(ownerId, providerId);
  return config ? deps.buildCustomAdapter(config) : undefined;
}

export function adapterSupports(adapter: ProviderAdapter, modelId: string, capability: Capability): boolean {
  return adapter.config.availableModels.some((m) => m.modelId === modelId && m.capabilities.includes(capability));
}
