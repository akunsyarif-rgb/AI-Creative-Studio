import { z } from "zod";
import { sniffMime } from "@/lib/storage/sniff";
import {
  ProviderError,
  type CostEstimate,
  type ProviderAdapter,
  type ProviderConfig,
  type ProviderExecutionContext,
  type ProviderJobRequest,
  type ProviderJobResult,
  type ProviderModel
} from "../types";

/**
 * OpenRouter adapter using the standard text-to-image request shape:
 * `POST /images/generations` with `{ model, prompt, n, size, response_format: "b64_json" }`,
 * answered with `{ data: [{ b64_json, media_type? }] }`.
 *
 * UNVERIFIED: written without live access to openrouter.ai. Whether these model
 * ids exist on OpenRouter, the exact endpoint path and the accepted parameters
 * MUST be confirmed with a real key. A wrong model id, path or parameter fails
 * safely with a 4xx (outcome known, nothing billed). Prices are rough
 * placeholders (deliberately on the high side), never "free".
 */

const BASE_URL = "https://openrouter.ai/api/v1";
const REQUEST_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 25 * 1024 * 1024;

export const OPENROUTER_FLUX_SCHNELL = "black-forest-labs/flux-schnell";
export const OPENROUTER_SD3 = "stabilityai/stable-diffusion-3";

const SIZES = ["1024x1024", "1024x1536", "1536x1024"] as const;
const SIZE_PARAM = {
  key: "size", label: "Size", default: "1024x1024",
  options: [
    { value: "1024x1024", label: "Square 1024×1024" },
    { value: "1024x1536", label: "Portrait 1024×1536" },
    { value: "1536x1024", label: "Landscape 1536×1024" }
  ]
};

const paramsSchema = z
  .object({
    prompt: z.string().trim().min(1).max(4000),
    size: z.enum(SIZES).default("1024x1024")
  })
  .strict();

interface ModelSpec {
  model: ProviderModel;
  priceUsd: number;
  priceNote: string;
}

const SPECS: ModelSpec[] = [
  {
    model: {
      modelId: OPENROUTER_FLUX_SCHNELL,
      displayName: "FLUX.1 schnell (fast)",
      capabilities: ["text_to_image"],
      isFreeTier: false,
      parameters: [SIZE_PARAM]
    },
    priceUsd: 0.01,
    priceNote: "Rough upper estimate (this model is usually well under a cent); not verified against OpenRouter pricing."
  },
  {
    model: {
      modelId: OPENROUTER_SD3,
      displayName: "Stable Diffusion 3",
      capabilities: ["text_to_image"],
      isFreeTier: false,
      parameters: [SIZE_PARAM]
    },
    priceUsd: 0.07,
    priceNote: "Rough estimate; not verified against OpenRouter pricing."
  }
];

export const OPENROUTER_CONFIG: ProviderConfig = {
  id: "openrouter",
  name: "OpenRouter",
  description: "One key, many image models. Billed per use to your own OpenRouter account.",
  availableModels: SPECS.map((s) => s.model)
};

type Fetch = typeof fetch;

const BASE64 = /^[A-Za-z0-9+/=\s]+$/;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

function mapStatus(status: number): ProviderError {
  if (status === 401) return new ProviderError("auth", "The provider rejected the API key.", true);
  if (status === 402) return new ProviderError("insufficient_funds", "Your OpenRouter account has insufficient credits.", true);
  if (status === 403) return new ProviderError("auth", "The provider rejected the key or blocked the request.", true);
  if (status === 429) return new ProviderError("rate_limited", "The provider rate limit was reached.", true);
  if (status === 400 || status === 404 || status === 422) return new ProviderError("invalid_request", "The provider rejected the request.", true);
  // 408/5xx: the request may have been processed (and billed).
  return new ProviderError("unavailable", "The provider is temporarily unavailable.", false);
}

export function createOpenRouterAdapter(fetchImpl: Fetch = fetch): ProviderAdapter {
  const spec = (modelId: string) => SPECS.find((s) => s.model.modelId === modelId);

  async function call(path: string, init: RequestInit & { secret: string }): Promise<Response> {
    const { secret, headers, ...rest } = init;
    try {
      return await fetchImpl(`${BASE_URL}${path}`, {
        ...rest,
        headers: { ...(headers as Record<string, string>), Authorization: `Bearer ${secret}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
    } catch (error) {
      const name = (error as { name?: string }).name;
      if (name === "TimeoutError" || name === "AbortError") {
        throw new ProviderError("timeout", "The provider did not respond in time. The request may still have been billed.", false);
      }
      throw new ProviderError("unavailable", "Could not reach the provider.", false);
    }
  }

  return {
    config: OPENROUTER_CONFIG,
    getCapabilities: () => [...new Set(SPECS.flatMap((s) => s.model.capabilities))],

    validateRequest(request) {
      const s = spec(request.modelId);
      if (!s || !s.model.capabilities.includes(request.capability)) {
        throw new ProviderError("invalid_request", "Unsupported model or capability.", true);
      }
      const parsed = paramsSchema.safeParse(request.parameters);
      if (!parsed.success) {
        throw new ProviderError("invalid_request", `Invalid parameters: ${parsed.error.issues.map((i) => i.path.join(".") || "request").join(", ")}`, true);
      }
      if (request.inputAssetIds.length > 0) throw new ProviderError("invalid_request", "This model does not accept input images.", true);
    },

    async testKey(secret) {
      const res = await call("/auth/key", { method: "GET", secret });
      if (res.ok) return { valid: true };
      if (res.status === 401 || res.status === 403) return { valid: false, message: "The provider rejected this API key." };
      throw mapStatus(res.status);
    },

    async estimateCost(request: ProviderJobRequest): Promise<CostEstimate | null> {
      const s = spec(request.modelId);
      if (!s) return null;
      // Never null for a paid model: null would skip the confirmation gate.
      return { amount: s.priceUsd, currency: "USD", isEstimate: true, notes: s.priceNote };
    },

    async executeJob(request: ProviderJobRequest, _idempotencyKey: string, context: ProviderExecutionContext): Promise<ProviderJobResult> {
      if (!spec(request.modelId)) throw new ProviderError("invalid_request", "Unsupported model.", true);
      const params = paramsSchema.parse(request.parameters);

      // One attempt only; a billable call is never retried automatically.
      const res = await call("/images/generations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: request.modelId, prompt: params.prompt, n: 1, size: params.size, response_format: "b64_json" }),
        secret: context.secret
      });
      if (!res.ok) throw mapStatus(res.status);

      const body = (await res.json().catch(() => null)) as { error?: unknown; data?: { b64_json?: string; media_type?: string }[] } | null;
      // A 200 carrying an error object may still have been billed.
      if (!body || body.error) throw new ProviderError("unavailable", "The provider returned an error response.", false);

      // Only inline base64 is accepted; remote image URLs are deliberately never fetched (SSRF).
      const item = body.data?.[0];
      const b64 = item?.b64_json;
      if (!b64 || !BASE64.test(b64)) throw new ProviderError("unknown", "The provider returned no usable image.", false);
      const data = Uint8Array.from(Buffer.from(b64, "base64"));
      if (data.length === 0 || data.length > MAX_OUTPUT_BYTES) throw new ProviderError("unknown", "The provider returned an invalid image.", false);
      // Trust the bytes, not the label: sniff the real type, falling back to the reported one only if it is accepted.
      const sniffed = sniffMime(data);
      const contentType = sniffed && IMAGE_TYPES.has(sniffed) ? sniffed : item.media_type && IMAGE_TYPES.has(item.media_type) ? item.media_type : null;
      if (!contentType) throw new ProviderError("unknown", "The provider returned an unsupported image type.", false);
      return { status: "validating", outputFiles: [{ contentType, data }] };
    }
  };
}
