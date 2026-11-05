import type { Capability, ProviderAdapter, ProviderConfig, ProviderModel } from "./types";

const PROVIDER_ID = /^[a-z0-9][a-z0-9_-]{1,63}$/;

/**
 * Holds the provider adapters the app can use. Core code (API routes, job
 * execution) only ever resolves adapters by `providerId` through this registry,
 * so adding a provider never requires touching them.
 */
export class ProviderRegistry {
  private readonly adapters = new Map<string, ProviderAdapter>();

  register(adapter: ProviderAdapter): this {
    const { id, availableModels } = adapter.config;
    if (!PROVIDER_ID.test(id)) throw new Error(`Invalid provider id "${id}".`);
    if (this.adapters.has(id)) throw new Error(`Provider "${id}" is already registered.`);
    if (!availableModels.length) throw new Error(`Provider "${id}" declares no models.`);
    const seen = new Set<string>();
    for (const model of availableModels) {
      if (!model.modelId || seen.has(model.modelId)) throw new Error(`Provider "${id}" has a missing or duplicate model id.`);
      if (!model.capabilities.length) throw new Error(`Model "${model.modelId}" declares no capabilities.`);
      seen.add(model.modelId);
    }
    this.adapters.set(id, adapter);
    return this;
  }

  get(providerId: string): ProviderAdapter | undefined {
    return this.adapters.get(providerId);
  }

  has(providerId: string): boolean {
    return this.adapters.has(providerId);
  }

  list(): ProviderAdapter[] {
    return [...this.adapters.values()];
  }

  configs(): ProviderConfig[] {
    return this.list().map((a) => a.config);
  }

  findModel(providerId: string, modelId: string): ProviderModel | undefined {
    return this.get(providerId)?.config.availableModels.find((m) => m.modelId === modelId);
  }

  /** True only if the provider is registered AND the model declares the capability. */
  supports(providerId: string, modelId: string, capability: Capability): boolean {
    return this.findModel(providerId, modelId)?.capabilities.includes(capability) ?? false;
  }
}

export function createProviderRegistry(adapters: ProviderAdapter[] = []): ProviderRegistry {
  const registry = new ProviderRegistry();
  for (const adapter of adapters) registry.register(adapter);
  return registry;
}
