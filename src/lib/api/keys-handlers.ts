import { z } from "zod";
import type { HttpTemplate } from "@/lib/data/repositories";
import { authenticate } from "@/lib/auth/session";
import { UnsafeUrlError, assertSafeBaseUrl } from "@/lib/net/public-url";
import { httpTemplateSchema, normaliseHttpTemplate } from "@/lib/providers/adapters/generic-http";
import { CUSTOM_PREFIX } from "@/lib/providers/adapters/openai-compatible";
import { credentialContext } from "@/lib/security/credential-context";
import { apiError, internalError, json, parseJson, unauthorized } from "./http";
import type { ApiDeps } from "./handlers";
import { enforceRate } from "./rate-limit";

const providerId = z.string().regex(/^[a-z0-9][a-z0-9_-]{1,63}$/, "Invalid provider id");

// ciphertext column is 4096 chars; 2000 plaintext chars stays well under it.
const apiKey = z
  .string()
  .trim()
  .min(8)
  .max(2000)
  .regex(/^\S+$/, "API key must not contain whitespace");

const modelId = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][\w.\-:/@]{0,127}$/, "Invalid model id")
  .refine((m) => !m.includes("://"), "Enter the model id (as listed in the provider's catalog), not a web address")
  .refine((m) => !m.split("/").some((seg) => seg === ".." || seg === "."), "Invalid model id");

/** Settings of a user-defined OpenAI-compatible provider. */
const customSchema = z.object({
  label: z.string().trim().min(2).max(64),
  baseUrl: z.string().trim().min(8).max(300),
  models: z.array(modelId).min(1).max(10),
  /** Optional per-image price guess. Without it every request asks for consent with an "unknown price" notice. */
  estimatedCostUsd: z.number().min(0.0001).max(100).optional(),
  /** Present for a "custom HTTP" provider; absent for an OpenAI-compatible one. */
  http: httpTemplateSchema.optional()
});

export const createKeySchema = z
  .object({ providerId: providerId.optional(), apiKey, custom: customSchema.optional() })
  .superRefine((v, ctx) => {
    if (v.custom && v.providerId) ctx.addIssue({ code: "custom", path: ["providerId"], message: "Do not send providerId for a custom provider" });
    if (!v.custom && !v.providerId) ctx.addIssue({ code: "custom", path: ["providerId"], message: "providerId is required" });
    if (!v.custom && v.providerId?.startsWith(CUSTOM_PREFIX)) ctx.addIssue({ code: "custom", path: ["providerId"], message: "Reserved prefix" });
  });

/** `custom-<slug>` derived from the label, so two labels that differ only in punctuation collide (and are rejected). */
export function customProviderId(label: string): string | null {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/g, "");
  return slug.length >= 2 ? `${CUSTOM_PREFIX}${slug}` : null;
}
export const updateKeySchema = z.object({ apiKey });

/** Editing a custom provider changes only what it offers and costs, never where the key is sent. */
export const updateCustomSchema = z.object({
  models: z.array(modelId).min(1).max(10),
  estimatedCostUsd: z.number().min(0.0001).max(100).nullable()
}).strict();

/** Reveal at most 4 trailing characters, and only when that is a small fraction of the key. */
export function maskLast4(secret: string): string | null {
  return secret.length >= 16 ? secret.slice(-4) : null;
}

function publicKey(meta: { providerId: string; last4: string | null; validationStatus: string; createdAt: string; updatedAt: string; custom: { label: string; baseUrl: string; models: string[]; estimatedCostUsd: number | null; http?: HttpTemplate | null } | null }) {
  return {
    providerId: meta.providerId,
    custom: meta.custom ? { label: meta.custom.label, baseUrl: meta.custom.baseUrl, models: meta.custom.models, estimatedCostUsd: meta.custom.estimatedCostUsd, http: meta.custom.http ?? null } : null,
    masked: meta.last4 ? `••••${meta.last4}` : "••••",
    validationStatus: meta.validationStatus,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt
  };
}

async function seal(deps: ApiDeps, ownerId: string, provider: string, secret: string) {
  const ciphertext = await deps.vault.encrypt(secret, credentialContext(ownerId, provider));
  return { ciphertext, keyId: ciphertext.split(".")[1], last4: maskLast4(secret) };
}

export async function postKey(request: Request, deps: ApiDeps): Promise<Response> {
  try {
    const user = await authenticate(request, deps.verifyToken);
    if (!user) return unauthorized();
    const limited = enforceRate(deps.limiter, "keys", user.userId);
    if (limited) return limited;
    const body = await parseJson(request, createKeySchema);
    if (!body.ok) return body.response;
    const { apiKey: secret, custom } = body.data;
    let provider = body.data.providerId as string;
    let customConfig: { label: string; baseUrl: string; models: string[]; estimatedCostUsd: number | null; http: HttpTemplate | null } | undefined;
    if (custom) {
      const id = customProviderId(custom.label);
      if (!id) return apiError(422, "validation_failed", "Choose a name with at least two letters or digits.");
      let url: URL;
      try {
        url = await assertSafeBaseUrl(custom.baseUrl, deps.lookup);
      } catch (error) {
        if (error instanceof UnsafeUrlError) return apiError(422, "invalid_base_url", error.message);
        throw error;
      }
      provider = id;
      customConfig = { label: custom.label, baseUrl: url.href.replace(/\/$/, ""), models: [...new Set(custom.models)], estimatedCostUsd: custom.estimatedCostUsd ?? null, http: custom.http ? normaliseHttpTemplate(custom.http) : null };
    }
    const sealed = await seal(deps, user.userId, provider, secret);
    const meta = await deps.keys.create({ ownerId: user.userId, providerId: provider, ...sealed, ...(customConfig ? { custom: customConfig } : {}) });
    if (!meta) return apiError(409, "key_exists", "A key for this provider already exists. Use PUT to rotate it.");
    return json(201, { key: publicKey(meta) });
  } catch (error) {
    return internalError(error);
  }
}

export async function getKeys(request: Request, deps: ApiDeps): Promise<Response> {
  try {
    const user = await authenticate(request, deps.verifyToken);
    if (!user) return unauthorized();
    const limited = enforceRate(deps.limiter, "keys", user.userId);
    if (limited) return limited;
    return json(200, { keys: (await deps.keys.list(user.userId)).map(publicKey) });
  } catch (error) {
    return internalError(error);
  }
}

export async function getKey(request: Request, deps: ApiDeps, provider: string): Promise<Response> {
  try {
    const user = await authenticate(request, deps.verifyToken);
    if (!user) return unauthorized();
    const limited = enforceRate(deps.limiter, "keys", user.userId);
    if (limited) return limited;
    if (!providerId.safeParse(provider).success) return apiError(404, "not_found", "Key not found.");
    const meta = await deps.keys.get(user.userId, provider);
    return meta ? json(200, { key: publicKey(meta) }) : apiError(404, "not_found", "Key not found.");
  } catch (error) {
    return internalError(error);
  }
}

/** Rotate: replaces the stored secret (re-encrypted under the active key) and resets validation. */
export async function putKey(request: Request, deps: ApiDeps, provider: string): Promise<Response> {
  try {
    const user = await authenticate(request, deps.verifyToken);
    if (!user) return unauthorized();
    const limited = enforceRate(deps.limiter, "keys", user.userId);
    if (limited) return limited;
    if (!providerId.safeParse(provider).success) return apiError(404, "not_found", "Key not found.");
    const body = await parseJson(request, updateKeySchema);
    if (!body.ok) return body.response;
    const sealed = await seal(deps, user.userId, provider, body.data.apiKey);
    const meta = await deps.keys.replace({ ownerId: user.userId, providerId: provider, ...sealed });
    return meta ? json(200, { key: publicKey(meta) }) : apiError(404, "not_found", "Key not found.");
  } catch (error) {
    return internalError(error);
  }
}

/** Edit a custom provider's models and price estimate. The address and the key stay as they are. */
export async function patchKey(request: Request, deps: ApiDeps, provider: string): Promise<Response> {
  try {
    const user = await authenticate(request, deps.verifyToken);
    if (!user) return unauthorized();
    const limited = enforceRate(deps.limiter, "keys", user.userId);
    if (limited) return limited;
    if (!providerId.safeParse(provider).success || !provider.startsWith(CUSTOM_PREFIX)) return apiError(404, "not_found", "Custom provider not found.");
    const body = await parseJson(request, updateCustomSchema);
    if (!body.ok) return body.response;
    const meta = await deps.keys.updateCustom({ ownerId: user.userId, providerId: provider, models: [...new Set(body.data.models)], estimatedCostUsd: body.data.estimatedCostUsd });
    return meta ? json(200, { key: publicKey(meta) }) : apiError(404, "not_found", "Custom provider not found.");
  } catch (error) {
    return internalError(error);
  }
}

export async function deleteKey(request: Request, deps: ApiDeps, provider: string): Promise<Response> {
  try {
    const user = await authenticate(request, deps.verifyToken);
    if (!user) return unauthorized();
    const limited = enforceRate(deps.limiter, "keys", user.userId);
    if (limited) return limited;
    if (!providerId.safeParse(provider).success) return apiError(404, "not_found", "Key not found.");
    return (await deps.keys.delete(user.userId, provider)) ? json(200, { deleted: true }) : apiError(404, "not_found", "Key not found.");
  } catch (error) {
    return internalError(error);
  }
}
