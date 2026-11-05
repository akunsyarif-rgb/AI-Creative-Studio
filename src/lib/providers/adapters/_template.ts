/**
 * TEMPLATE for a new provider adapter (e.g. OpenRouter, Anthropic, Replicate).
 * It is type-checked but deliberately NOT registered.
 *
 * To add a provider:
 *   1. Copy this file to `adapters/<provider>.ts` and rename `createTemplateAdapter`.
 *   2. Fill in `config` (id must match /^[a-z0-9][a-z0-9_-]{1,63}$/), models and parameters.
 *      The UI builds its provider/model/parameter pickers from this config alone.
 *   3. Implement the methods below. Rules every adapter must follow:
 *        - `validateRequest`: reject unsupported parameters BEFORE any network call.
 *        - `estimateCost`: return null only for genuinely free models. Never infer "free"
 *          from a model name; leave `pricingVerifiedAt` unset until verified.
 *        - `executeJob`: make at most ONE billable call and never retry it. Throw
 *          `ProviderError(code, safeMessage, outcomeKnown)`; `outcomeKnown` is false whenever
 *          the provider may have processed (and billed) the request (timeouts, 5xx).
 *        - Never put the secret, prompts or provider payloads in error messages or logs.
 *        - Use a fixed base URL; never accept a URL from user input (SSRF).
 *   4. Register it in `src/lib/providers/index.ts` and add a test next to it
 *      (mock `fetch`; see `openai.test.ts`).
 */
import {
  ProviderError,
  type ProviderAdapter,
  type ProviderConfig
} from "../types";

const config: ProviderConfig = {
  id: "template",
  name: "Template Provider",
  description: "Describe the provider and how it is billed.",
  availableModels: [
    {
      modelId: "template-model",
      displayName: "Template Model",
      capabilities: ["text_to_image"],
      parameters: [{ key: "size", label: "Size", default: "1024x1024", options: [{ value: "1024x1024", label: "Square" }] }]
    }
  ]
};

export function createTemplateAdapter(): ProviderAdapter {
  return {
    config,
    getCapabilities: () => [...new Set(config.availableModels.flatMap((m) => m.capabilities))],
    validateRequest() {
      throw new ProviderError("invalid_request", "Template adapter is not implemented.", true);
    },
    async testKey() {
      throw new ProviderError("unavailable", "Template adapter is not implemented.", true);
    },
    async estimateCost() {
      return null;
    },
    async executeJob() {
      throw new ProviderError("unavailable", "Template adapter is not implemented.", true);
    }
  };
}
