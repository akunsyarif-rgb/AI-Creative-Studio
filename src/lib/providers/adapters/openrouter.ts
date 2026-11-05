import { z } from "zod";
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
 * OpenRouter adapter: image generation/editing through the chat-completions
 * endpoint with `modalities: ["image","text"]`; the image comes back as a
 * base64 data URL in `choices[0].message.images[0].image_url.url`.
 *
 * UNVERIFIED: this was written without live access to openrouter.ai. Model ids,
 * the response shape and the key-check endpoint follow OpenRouter's public docs
 * as understood at the time and MUST be confirmed with a real key before
 * relying on them. A wrong model id fails safely with a 4xx (outcome known,
 * nothing billed). Prices below are rough placeholders, never "free".
 */

const BASE_URL = "https://openrouter.ai/api/v1";
const REQUEST_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 25 * 1024 * 1024;

export const OPENROUTER_GEMINI_FLASH_IMAGE = "google/gemini-2.5-flash-image";
export const OPENROUTER_GPT_IMAGE_MINI = "openai/gpt-5-image-mini";

interface ModelSpec {
  model: ProviderModel;
  /** Strict parameter schema (prompt + this model's tunables). */
  schema: z.ZodType<{ prompt: string; aspect_ratio?: string }>;
  priceUsd: number;
  priceNote: string;
}

const prompt = z.string().trim().min(1).max(4000);
const ASPECTS = ["1:1", "2:3", "3:2", "9:16", "16:9"] as const;

const SPECS: ModelSpec[] = [
  {
    model: {
      modelId: OPENROUTER_GEMINI_FLASH_IMAGE,
      displayName: "Gemini 2.5 Flash Image",
      capabilities: ["text_to_image", "image_to_image"],
      isFreeTier: false,
      parameters: [
        {
          key: "aspect_ratio", label: "Aspect ratio", default: "1:1",
          options: [
            { value: "1:1", label: "Square 1:1" }, { value: "2:3", label: "Portrait 2:3" }, { value: "3:2", label: "Landscape 3:2" },
            { value: "9:16", label: "Tall 9:16" }, { value: "16:9", label: "Wide 16:9" }
          ]
        }
      ]
    },
    schema: z.object({ prompt, aspect_ratio: z.enum(ASPECTS).default("1:1") }).strict(),
    priceUsd: 0.039,
    priceNote: "Roughly $0.04 per image (placeholder; verify on OpenRouter)."
  },
  {
    model: {
      modelId: OPENROUTER_GPT_IMAGE_MINI,
      displayName: "GPT-5 Image Mini",
      capabilities: ["text_to_image", "image_to_image"],
      isFreeTier: false
    },
    schema: z.object({ prompt }).strict(),
    priceUsd: 0.1,
    priceNote: "Price unknown: this is a conservative upper bound, not a quote. Actual billing is token-based."
  }
];

export const OPENROUTER_CONFIG: ProviderConfig = {
  id: "openrouter",
  name: "OpenRouter",
  description: "One key, many image models. Billed per use to your own OpenRouter account.",
  availableModels: SPECS.map((s) => s.model)
};

type Fetch = typeof fetch;

const DATA_URL = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/;

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
      const parsed = s.schema.safeParse(request.parameters);
      if (!parsed.success) {
        throw new ProviderError("invalid_request", `Invalid parameters: ${parsed.error.issues.map((i) => i.path.join(".") || "request").join(", ")}`, true);
      }
      const edit = request.capability === "image_to_image";
      if (edit && request.inputAssetIds.length !== 1) throw new ProviderError("invalid_request", "image_to_image requires exactly one input image.", true);
      if (!edit && request.inputAssetIds.length > 0) throw new ProviderError("invalid_request", "text_to_image does not accept input images.", true);
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
      const s = spec(request.modelId);
      if (!s) throw new ProviderError("invalid_request", "Unsupported model.", true);
      const params = s.schema.parse(request.parameters);

      const content: unknown =
        request.capability === "image_to_image"
          ? [
              { type: "text", text: params.prompt },
              {
                type: "image_url",
                image_url: { url: `data:${context.inputFiles[0]?.contentType};base64,${Buffer.from(context.inputFiles[0]?.data ?? []).toString("base64")}` }
              }
            ]
          : params.prompt;
      if (request.capability === "image_to_image" && !context.inputFiles[0]) {
        throw new ProviderError("invalid_request", "Missing input image.", true);
      }

      // One attempt only; a billable call is never retried automatically.
      const res = await call("/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: request.modelId,
          messages: [{ role: "user", content }],
          modalities: ["image", "text"],
          ...(params.aspect_ratio ? { image_config: { aspect_ratio: params.aspect_ratio } } : {})
        }),
        secret: context.secret
      });
      if (!res.ok) throw mapStatus(res.status);

      const body = (await res.json().catch(() => null)) as {
        error?: unknown;
        choices?: { message?: { images?: { image_url?: { url?: string } }[] } }[];
      } | null;
      // A 200 carrying an error object may still have consumed tokens.
      if (!body || body.error) throw new ProviderError("unavailable", "The provider returned an error response.", false);

      const url = body.choices?.[0]?.message?.images?.[0]?.image_url?.url;
      const match = url ? DATA_URL.exec(url) : null;
      // Remote image URLs are deliberately not fetched (SSRF); only inline data URLs are accepted.
      if (!match) throw new ProviderError("unknown", "The provider returned no usable image.", false);
      const data = Uint8Array.from(Buffer.from(match[2], "base64"));
      if (data.length === 0 || data.length > MAX_OUTPUT_BYTES) throw new ProviderError("unknown", "The provider returned an invalid image.", false);
      return { status: "validating", outputFiles: [{ contentType: match[1], data }] };
    }
  };
}
