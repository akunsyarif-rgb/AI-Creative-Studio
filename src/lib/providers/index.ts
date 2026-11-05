import { createOpenAIAdapter } from "./adapters/openai";
import { createProviderRegistry } from "./registry";

/**
 * The application's provider registry, and the ONE place to plug in a new
 * provider: copy `adapters/_template.ts`, implement it, then add it below.
 * API routes and job execution resolve adapters by id and need no changes.
 */
export const providerRegistry = createProviderRegistry([
  createOpenAIAdapter()
  // createOpenRouterAdapter(),   // <- see adapters/_template.ts
]);

export { ProviderRegistry, createProviderRegistry } from "./registry";
export * from "./types";
