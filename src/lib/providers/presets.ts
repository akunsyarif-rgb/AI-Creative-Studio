import type { CustomProviderConfig } from "@/lib/data/repositories";

/**
 * Built-in slots for OpenAI-compatible services (`POST {baseUrl}/images/generations`).
 *
 * To fill or change a slot, edit `baseUrl` and `models` here: nothing else needs to change. Each preset becomes
 * a registered provider (see `providers/index.ts`), so it shows up on the API keys page and in the Studio's
 * Provider/Model dropdowns, and is saved/used exactly like OpenAI (key encrypted per user).
 *
 * `estimatedCostUsd: null` means the price is unknown: every request then asks for explicit "price unknown"
 * consent. Set a number to show it and enforce the spend ceiling.
 *
 * Presets are NOT verified against the real services: confirm the address, model names and response format with a
 * real key before relying on them. A wrong address fails safely (nothing is billed when the host is unreachable).
 */
export interface OpenAICompatiblePreset extends CustomProviderConfig {
  /** Shown on the API keys page. */
  description: string;
}

export const SPICYAPI_PRESET: OpenAICompatiblePreset = {
  providerId: "spicyapi",
  label: "SpicyAPI",
  baseUrl: "https://api.spicyapi.com/v1",
  models: ["spicy-image-1"],
  estimatedCostUsd: null,
  http: null,
  description: "Preset for an OpenAI-compatible service (api.spicyapi.com). Not verified: price unknown, you confirm each request."
};

export const OPENAI_COMPATIBLE_PRESETS: OpenAICompatiblePreset[] = [SPICYAPI_PRESET];
