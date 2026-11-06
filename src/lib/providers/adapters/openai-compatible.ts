import { z } from "zod";
import { sniffMime } from "@/lib/storage/sniff";
import { MAX_IMAGE_BYTES, createSafeIO, mapStatus, type SafeIODeps } from "./safe-io";
import type { CustomProviderConfig } from "@/lib/data/repositories";
import {
  ProviderError,
  type CostEstimate,
  type ProviderAdapter,
  type ProviderConfig,
  type ProviderExecutionContext,
  type ProviderJobRequest,
  type ProviderJobResult
} from "../types";

/**
 * Adapter for any provider that implements the OpenAI images API:
 *   POST {baseUrl}/images/generations  ->  { data: [{ b64_json | url }] }
 *   GET  {baseUrl}/models              (used only to check the key)
 * It is built per request from the user's saved settings. The user chooses the base URL, so every
 * request re-validates it (https, public host) and refuses redirects; image URLs returned by the
 * provider get the same treatment and are size-capped.
 */

export const CUSTOM_PREFIX = "custom-";

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

const SIZE_PARAM = {
  key: "size", label: "Size", default: "default",
  options: [
    { value: "default", label: "Provider default" },
    { value: "1024x1024", label: "Square 1024×1024" },
    { value: "1024x1536", label: "Portrait 1024×1536" },
    { value: "1536x1024", label: "Landscape 1536×1024" }
  ]
};

const paramsSchema = z
  .object({
    prompt: z.string().trim().min(1).max(4000),
    size: z.enum(["default", "1024x1024", "1024x1536", "1536x1024"]).default("default")
  })
  .strict();

export type CompatDeps = SafeIODeps;

export function customProviderConfig(cfg: CustomProviderConfig): ProviderConfig {
  let host = "custom endpoint";
  try {
    host = new URL(cfg.baseUrl).hostname;
  } catch {
    /* keep default */
  }
  return {
    id: cfg.providerId,
    name: cfg.label,
    description: `Custom OpenAI-compatible endpoint (${host}). Billed by that provider${cfg.estimatedCostUsd === null ? "; price unknown, you confirm each request" : "; costs shown are your own estimate"}.`,
    availableModels: cfg.models.map((modelId) => ({
      modelId, displayName: modelId, capabilities: ["text_to_image" as const], isFreeTier: false, parameters: [SIZE_PARAM]
    }))
  };
}

export function createOpenAICompatibleAdapter(cfg: CustomProviderConfig, deps: CompatDeps = {}): ProviderAdapter {
  const config = customProviderConfig(cfg);
  const io = createSafeIO(cfg.baseUrl, deps);

  const call = (path: string, init: RequestInit & { secret: string }): Promise<Response> => {
    const { secret, headers, ...rest } = init;
    return io.call(path, { ...rest, headers: { ...(headers as Record<string, string>), Authorization: `Bearer ${secret}` } });
  };
  const downloadImage = io.downloadImage;

  return {
    config,
    getCapabilities: () => ["text_to_image"],

    validateRequest(request) {
      if (!cfg.models.includes(request.modelId) || request.capability !== "text_to_image") {
        throw new ProviderError("invalid_request", "Unsupported model or capability.", true);
      }
      const parsed = paramsSchema.safeParse(request.parameters);
      if (!parsed.success) {
        throw new ProviderError("invalid_request", `Invalid parameters: ${parsed.error.issues.map((i) => i.path.join(".") || "request").join(", ")}`, true);
      }
      if (request.inputAssetIds.length > 0) throw new ProviderError("invalid_request", "This provider does not accept input images.", true);
    },

    async testKey(secret) {
      const res = await call("/models", { method: "GET", secret });
      if (res.ok) return { valid: true };
      if (res.status === 401 || res.status === 403) return { valid: false, message: "The provider rejected this API key." };
      if (res.status === 404 || res.status === 405 || res.status === 501) {
        throw new ProviderError("invalid_request", "This provider has no key-check endpoint. Try a small generation to confirm the key.", true);
      }
      throw mapStatus(res.status);
    },

    async estimateCost(): Promise<CostEstimate | null> {
      // Never a null *estimate*: an unknown price must still go through the confirmation gate. With no user
      // estimate the amount is null, which the API turns into an explicit "price unknown" consent step.
      return cfg.estimatedCostUsd === null
        ? { amount: null, currency: "USD", isEstimate: true, notes: "The price is unknown. The provider will charge its own price to your account." }
        : { amount: cfg.estimatedCostUsd, currency: "USD", isEstimate: true, notes: "Your own estimate for this provider; actual billing may differ." };
    },

    async executeJob(request: ProviderJobRequest, _idempotencyKey: string, context: ProviderExecutionContext): Promise<ProviderJobResult> {
      const params = paramsSchema.parse(request.parameters);
      // One attempt only; a billable call is never retried automatically.
      const res = await call("/images/generations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: request.modelId, prompt: params.prompt, n: 1, ...(params.size === "default" ? {} : { size: params.size }) }),
        secret: context.secret
      });
      if (!res.ok) {
        if (res.status === 400) {
          const body = (await res.json().catch(() => null)) as { error?: { code?: string } } | null;
          if (body?.error?.code === "moderation_blocked") throw new ProviderError("content_policy", "The request was blocked by the provider's content policy.", true);
        }
        throw mapStatus(res.status);
      }
      const body = (await res.json().catch(() => null)) as { error?: unknown; data?: { b64_json?: string; url?: string }[] } | null;
      if (!body || body.error) throw new ProviderError("unavailable", "The provider returned an error response.", false);

      const item = body.data?.[0];
      let data: Uint8Array;
      if (item?.b64_json && /^[A-Za-z0-9+/=\s]+$/.test(item.b64_json)) data = Uint8Array.from(Buffer.from(item.b64_json, "base64"));
      else if (item?.url) data = await downloadImage(item.url);
      else throw new ProviderError("unknown", "The provider returned no usable image.", false);

      if (data.length === 0 || data.length > MAX_IMAGE_BYTES) throw new ProviderError("unknown", "The provider returned an invalid image.", false);
      const contentType = sniffMime(data);
      if (!contentType || !IMAGE_TYPES.has(contentType)) throw new ProviderError("unknown", "The provider returned an unsupported image type.", false);
      return { status: "validating", outputFiles: [{ contentType, data }] };
    }
  };
}
