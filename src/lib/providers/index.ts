import { createOpenAIAdapter } from "./adapters/openai";
import { createOpenAICompatibleAdapter } from "./adapters/openai-compatible";
import { createOpenRouterAdapter } from "./adapters/openrouter";
import { OPENAI_COMPATIBLE_PRESETS } from "./presets";
import { createProviderRegistry } from "./registry";

/**
 * The application's provider registry, and the ONE place to plug in a new
 * provider: copy `adapters/_template.ts`, implement it, then add it below.
 * API routes and job execution resolve adapters by id and need no changes.
 */
export const providerRegistry = createProviderRegistry([
  createOpenAIAdapter(),
  createOpenRouterAdapter(),
  // OpenAI-compatible slots (SpicyAPI, ...): configure them in `presets.ts`.
  ...OPENAI_COMPATIBLE_PRESETS.map((preset) => createOpenAICompatibleAdapter(preset, {}, { description: preset.description }))
  // createYourAdapter(),   // <- copy adapters/_template.ts
]);

export { ProviderRegistry, createProviderRegistry } from "./registry";
export * from "./types";
