import { z } from "zod";
import {
  ProviderError,
  type CostEstimate,
  type ProviderAdapter,
  type ProviderExecutionContext,
  type ProviderJobRequest,
  type ProviderJobResult,
  type ProviderModel
} from "./types";

const BASE_URL = "https://api.openai.com/v1";
const REQUEST_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 25 * 1024 * 1024;

export const OPENAI_IMAGE_MODEL = "gpt-image-1";

/**
 * Approximate list prices in USD per image (square / portrait-landscape).
 * NOT verified against OpenAI's live pricing page: `pricingVerifiedAt` is left
 * unset on purpose. Treat as an estimate and confirm with the provider.
 */
const PRICE_USD: Record<string, Record<string, number>> = {
  low: { "1024x1024": 0.011, "1024x1536": 0.016, "1536x1024": 0.016 },
  medium: { "1024x1024": 0.042, "1024x1536": 0.063, "1536x1024": 0.063 },
  high: { "1024x1024": 0.167, "1024x1536": 0.25, "1536x1024": 0.25 }
};

export const imageParamsSchema = z
  .object({
    prompt: z.string().trim().min(1).max(4000),
    size: z.enum(["1024x1024", "1024x1536", "1536x1024"]).default("1024x1024"),
    quality: z.enum(["low", "medium", "high"]).default("medium")
  })
  .strict();

const MODELS: ProviderModel[] = [
  {
    providerId: "openai",
    modelId: OPENAI_IMAGE_MODEL,
    displayName: "GPT Image 1",
    capabilities: ["text_to_image", "image_to_image"],
    isFreeTier: false
  }
];

type Fetch = typeof fetch;

function mapStatus(status: number): ProviderError {
  if (status === 401 || status === 403) return new ProviderError("auth", "The provider rejected the API key.", true);
  if (status === 429) return new ProviderError("rate_limited", "The provider rate limit or quota was reached.", true);
  if (status === 400 || status === 404 || status === 422) {
    return new ProviderError("invalid_request", "The provider rejected the request.", true);
  }
  // 5xx: the request may or may not have been processed (and billed).
  return new ProviderError("unavailable", "The provider is temporarily unavailable.", false);
}

export function createOpenAIAdapter(fetchImpl: Fetch = fetch): ProviderAdapter {
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
    providerId: "openai",
    displayName: "OpenAI",
    models: () => MODELS,
    async capabilities() {
      return [...new Set(MODELS.flatMap((m) => m.capabilities))];
    },

    validateRequest(request) {
      const model = MODELS.find((m) => m.modelId === request.modelId);
      if (!model || !model.capabilities.includes(request.capability)) {
        throw new ProviderError("invalid_request", "Unsupported model or capability.", true);
      }
      const parsed = imageParamsSchema.safeParse(request.parameters);
      if (!parsed.success) {
        throw new ProviderError("invalid_request", `Invalid parameters: ${parsed.error.issues.map((i) => i.path.join(".") || "prompt").join(", ")}`, true);
      }
      const needsImage = request.capability === "image_to_image";
      if (needsImage && request.inputAssetIds.length !== 1) {
        throw new ProviderError("invalid_request", "image_to_image requires exactly one input image.", true);
      }
      if (!needsImage && request.inputAssetIds.length > 0) {
        throw new ProviderError("invalid_request", "text_to_image does not accept input images.", true);
      }
    },

    async validateCredentials(secret) {
      const res = await call("/models", { method: "GET", secret });
      if (res.ok) return { valid: true };
      if (res.status === 401 || res.status === 403) return { valid: false, message: "The provider rejected this API key." };
      throw mapStatus(res.status);
    },

    async estimateCost(request): Promise<CostEstimate | null> {
      const parsed = imageParamsSchema.safeParse(request.parameters);
      if (!parsed.success) return null;
      const amount = PRICE_USD[parsed.data.quality]?.[parsed.data.size];
      if (amount === undefined) return null;
      return {
        amount,
        currency: "USD",
        isEstimate: true,
        notes: "Approximate per-image list price; not verified against live provider pricing. Prompt/input tokens may add cost."
      };
    },

    async submitJob(request: ProviderJobRequest, _idempotencyKey: string, context: ProviderExecutionContext): Promise<ProviderJobResult> {
      // OpenAI offers no idempotency key for images, so a single attempt is made and never retried.
      const params = imageParamsSchema.parse(request.parameters);
      let res: Response;
      if (request.capability === "image_to_image") {
        const input = context.inputFiles[0];
        if (!input) throw new ProviderError("invalid_request", "Missing input image.", true);
        const form = new FormData();
        form.set("model", request.modelId);
        form.set("prompt", params.prompt);
        form.set("size", params.size);
        form.set("quality", params.quality);
        form.set("image", new Blob([input.data as BlobPart], { type: input.contentType }), "input");
        res = await call("/images/edits", { method: "POST", body: form, secret: context.secret });
      } else {
        res = await call("/images/generations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: request.modelId, prompt: params.prompt, size: params.size, quality: params.quality, n: 1 }),
          secret: context.secret
        });
      }

      if (!res.ok) {
        // Moderation blocks are reported as 400 with a code; surface only a fixed message.
        if (res.status === 400) {
          const body = (await res.json().catch(() => null)) as { error?: { code?: string } } | null;
          if (body?.error?.code === "moderation_blocked") {
            throw new ProviderError("content_policy", "The request was blocked by the provider's content policy.", true);
          }
        }
        throw mapStatus(res.status);
      }

      const body = (await res.json().catch(() => null)) as { data?: { b64_json?: string }[] } | null;
      const b64 = body?.data?.[0]?.b64_json;
      if (!b64) throw new ProviderError("unknown", "The provider returned no image.", false);
      const data = Uint8Array.from(Buffer.from(b64, "base64"));
      if (data.length === 0 || data.length > MAX_OUTPUT_BYTES) throw new ProviderError("unknown", "The provider returned an invalid image.", false);
      return { status: "validating", outputFiles: [{ contentType: "image/png", data }] };
    }
  };
}
