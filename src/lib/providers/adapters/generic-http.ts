import { z } from "zod";
import { readLimited } from "@/lib/net/public-url";
import type { CustomProviderConfig, HttpTemplate } from "@/lib/data/repositories";
import { sniffMime } from "@/lib/storage/sniff";
import { MAX_IMAGE_BYTES, createSafeIO, mapStatus, type SafeIODeps } from "./safe-io";
import { userPriceFor } from "../pricing";
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
 * "Custom HTTP" provider: the user describes one JSON request and where the image is in the answer, so
 * services with their own (synchronous) API style can be tried without a dedicated adapter.
 *
 *   POST {baseUrl}{path}   body = the user's JSON template with {{prompt}}, {{model}}, {{size}}, {{width}}, {{height}}
 *   answer = JSON (the image at `responsePath`: base64, a data: URL, or an https link) or raw image bytes
 *
 * Not supported: multipart bodies, query-string keys, and asynchronous APIs that need polling.
 * All user-supplied pieces are validated; the network rules are those of `safe-io.ts`.
 */

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const MAX_JSON_BYTES = 40 * 1024 * 1024;
const PLACEHOLDER = /\{\{(\w+)\}\}/g;
const ALLOWED_PLACEHOLDERS = new Set(["prompt", "model", "size", "width", "height"]);
const NUMERIC_PLACEHOLDERS = new Set(["width", "height"]);

const SIZES = ["512x512", "768x768", "1024x1024", "1024x1536", "1536x1024"] as const;
const SIZE_PARAM = {
  key: "size", label: "Size", default: "1024x1024",
  options: [
    { value: "512x512", label: "Small 512×512" },
    { value: "768x768", label: "Medium 768×768" },
    { value: "1024x1024", label: "Square 1024×1024" },
    { value: "1024x1536", label: "Portrait 1024×1536" },
    { value: "1536x1024", label: "Landscape 1536×1024" }
  ]
};

const paramsSchema = z
  .object({ prompt: z.string().trim().min(1).max(4000), size: z.enum(SIZES).default("1024x1024") })
  .strict();

export class TemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateError";
  }
}

const BLOCKED_HEADERS = /^(host|content-length|content-type|transfer-encoding|connection|upgrade|te|trailer|expect|cookie|set-cookie|origin|referer|user-agent|accept|accept-encoding|proxy-.*|sec-.*|x-forwarded-.*)$/i;

/** What a client may send for a custom HTTP provider. Normalised into `HttpTemplate` by the API. */
export const httpTemplateSchema = z
  .object({
    path: z.string().trim().regex(/^\/[A-Za-z0-9/_\-.:{}]{0,199}$/, "Path must start with / and use only letters, digits and / _ - . : {{model}}")
      .refine((p) => !p.split("/").some((seg) => seg === ".." || seg === "."), "Path must not contain . or .. segments"),
    authHeader: z.string().trim().regex(/^[A-Za-z][A-Za-z0-9-]{0,40}$/, "Invalid header name").refine((h) => !BLOCKED_HEADERS.test(h), "That header cannot be set").default("Authorization"),
    authScheme: z.string().trim().regex(/^[A-Za-z]{0,20}$/, "Use letters only (for example Bearer), or leave empty").default("Bearer"),
    body: z.string().min(2).max(4000),
    responseKind: z.enum(["json", "binary"]),
    responsePath: z.string().trim().regex(/^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/, "Use a dotted path such as data.0.b64_json").max(200).nullish(),
    testPath: z.string().trim().regex(/^\/[A-Za-z0-9/_\-.:{}]{0,199}$/).refine((p) => !p.split("/").some((seg) => seg === ".." || seg === "."), "Invalid path").nullish()
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.responseKind === "json" && !v.responsePath) ctx.addIssue({ code: "custom", path: ["responsePath"], message: "Tell us where the image is in the answer" });
    try {
      parseBodyTemplate(v.body);
    } catch (error) {
      ctx.addIssue({ code: "custom", path: ["body"], message: error instanceof TemplateError ? error.message : "Invalid request body" });
    }
  });

export function normaliseHttpTemplate(input: z.infer<typeof httpTemplateSchema>): HttpTemplate {
  return {
    path: input.path,
    authHeader: input.authHeader,
    authScheme: input.authScheme,
    body: input.body,
    responseKind: input.responseKind,
    responsePath: input.responseKind === "json" ? (input.responsePath ?? null) : null,
    testPath: input.testPath ?? null
  };
}

function walkStrings(value: unknown, visit: (s: string) => void, depth = 0): void {
  if (depth > 8) throw new TemplateError("The request body is nested too deeply.");
  if (typeof value === "string") visit(value);
  else if (Array.isArray(value)) value.forEach((v) => walkStrings(v, visit, depth + 1));
  else if (value && typeof value === "object") Object.values(value).forEach((v) => walkStrings(v, visit, depth + 1));
}

/** Parses and validates the user's JSON body template. */
export function parseBodyTemplate(text: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new TemplateError("The request body is not valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new TemplateError("The request body must be a JSON object.");
  const seen = new Set<string>();
  walkStrings(parsed, (s) => {
    for (const m of s.matchAll(PLACEHOLDER)) {
      if (!ALLOWED_PLACEHOLDERS.has(m[1])) throw new TemplateError(`Unknown placeholder {{${m[1]}}}. Allowed: prompt, model, size, width, height.`);
      seen.add(m[1]);
    }
  });
  if (!seen.has("prompt")) throw new TemplateError("The request body must contain {{prompt}}.");
  return parsed as Record<string, unknown>;
}

type Values = { prompt: string; model: string; size: string; width: number; height: number };

/** Substitutes placeholders in string values only (never in keys), so user text cannot change the JSON structure. */
export function renderTemplate(template: unknown, values: Values): unknown {
  if (typeof template === "string") {
    const whole = /^\{\{(\w+)\}\}$/.exec(template);
    if (whole && NUMERIC_PLACEHOLDERS.has(whole[1])) return values[whole[1] as "width" | "height"];
    return template.replace(PLACEHOLDER, (_m, name: keyof Values) => String(values[name]));
  }
  if (Array.isArray(template)) return template.map((v) => renderTemplate(v, values));
  if (template && typeof template === "object") {
    return Object.fromEntries(Object.entries(template).map(([k, v]) => [k, renderTemplate(v, values)]));
  }
  return template;
}

/** Own-property lookup along a dotted path (numeric segments index arrays). */
export function getByPath(value: unknown, path: string): unknown {
  let current: unknown = value;
  for (const segment of path.split(".")) {
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(segment)) return undefined;
      current = current[Number(segment)];
    } else if (current && typeof current === "object" && Object.prototype.hasOwnProperty.call(current, segment)) {
      current = (current as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

const DATA_URL = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/=\s]+)$/;

function customHttpConfig(cfg: CustomProviderConfig): ProviderConfig {
  let host = "custom endpoint";
  try {
    host = new URL(cfg.baseUrl).hostname;
  } catch {
    /* keep default */
  }
  return {
    id: cfg.providerId,
    name: cfg.label,
    description: `Custom HTTP endpoint (${host}). Billed by that provider${cfg.estimatedCostUsd === null ? "; price unknown, you confirm each request" : "; costs shown are your own estimate"}.`,
    availableModels: cfg.models.map((modelId) => ({
      modelId, displayName: modelId, capabilities: ["text_to_image" as const], isFreeTier: false, parameters: [SIZE_PARAM]
    }))
  };
}

/** Model ids may contain "/" (kept as path separators) but are percent-encoded otherwise. */
const encodeModelPath = (model: string) => model.split("/").map(encodeURIComponent).join("/");

export function createGenericHttpAdapter(cfg: CustomProviderConfig & { http: HttpTemplate }, deps: SafeIODeps = {}): ProviderAdapter {
  const http = cfg.http;
  const config = customHttpConfig(cfg);
  const io = createSafeIO(cfg.baseUrl, deps);

  const authHeaders = (secret: string): Record<string, string> => ({
    [http.authHeader]: `${http.authScheme ? `${http.authScheme} ` : ""}${secret}`
  });

  async function imageFromValue(value: unknown): Promise<Uint8Array> {
    if (typeof value !== "string" || !value) throw new ProviderError("unknown", "The answer did not contain an image at the configured path.", false);
    const dataUrl = DATA_URL.exec(value);
    if (dataUrl) return Uint8Array.from(Buffer.from(dataUrl[1], "base64"));
    if (/^https?:\/\//i.test(value)) return io.downloadImage(value);
    if (/^[A-Za-z0-9+/=\s]{16,}$/.test(value)) return Uint8Array.from(Buffer.from(value, "base64")); // the real bytes are sniffed afterwards
    throw new ProviderError("unknown", "The answer did not contain a usable image.", false);
  }

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
      if (!http.testPath) {
        throw new ProviderError("invalid_request", "No key-check address is configured for this provider. Try a small generation to confirm the key.", true);
      }
      const res = await io.call(http.testPath, { method: "GET", headers: authHeaders(secret) });
      if (res.ok) return { valid: true };
      if (res.status === 401 || res.status === 403) return { valid: false, message: "The provider rejected this API key." };
      throw mapStatus(res.status);
    },

    async estimateCost(request?: ProviderJobRequest): Promise<CostEstimate | null> {
      const price = userPriceFor(cfg, request?.modelId);
      return price === null
        ? { amount: null, currency: "USD", isEstimate: true, notes: "The price is unknown. The provider will charge its own price to your account." }
        : { amount: price, currency: "USD", isEstimate: true, notes: "Your own estimate for this provider; actual billing may differ." };
    },

    async executeJob(request: ProviderJobRequest, _idempotencyKey: string, context: ProviderExecutionContext): Promise<ProviderJobResult> {
      const params = paramsSchema.parse(request.parameters);
      const [width, height] = params.size.split("x").map(Number);
      const body = renderTemplate(parseBodyTemplate(http.body), { prompt: params.prompt, model: request.modelId, size: params.size, width, height });
      if (request.modelId.split("/").some((seg) => seg === ".." || seg === ".")) {
        throw new ProviderError("invalid_request", "Unsupported model name.", true);
      }
      const path = http.path.replace(/\{\{model\}\}/g, encodeModelPath(request.modelId));

      // One attempt only; a billable call is never retried automatically.
      const res = await io.call(path, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: http.responseKind === "binary" ? "image/*" : "application/json", ...authHeaders(context.secret) },
        body: JSON.stringify(body)
      });
      if (!res.ok) throw mapStatus(res.status);

      let data: Uint8Array;
      try {
        if (http.responseKind === "binary") {
          data = await readLimited(res, MAX_IMAGE_BYTES);
        } else {
          const text = new TextDecoder().decode(await readLimited(res, MAX_JSON_BYTES));
          let json: unknown;
          try {
            json = JSON.parse(text);
          } catch {
            throw new ProviderError("unknown", "The provider's answer was not JSON.", false);
          }
          data = await imageFromValue(getByPath(json, http.responsePath ?? ""));
        }
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        // Oversized or unreadable answer: the provider may already have billed.
        throw new ProviderError("unknown", "The provider's answer could not be read safely.", false);
      }

      if (data.length === 0 || data.length > MAX_IMAGE_BYTES) throw new ProviderError("unknown", "The provider returned an invalid image.", false);
      const contentType = sniffMime(data);
      if (!contentType || !IMAGE_TYPES.has(contentType)) throw new ProviderError("unknown", "The provider returned an unsupported image type.", false);
      return { status: "validating", outputFiles: [{ contentType, data }] };
    }
  };
}
