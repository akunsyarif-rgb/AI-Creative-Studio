import { z } from "zod";
import { authenticate } from "@/lib/auth/session";
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

export const createKeySchema = z.object({ providerId, apiKey });
export const updateKeySchema = z.object({ apiKey });

/** Reveal at most 4 trailing characters, and only when that is a small fraction of the key. */
export function maskLast4(secret: string): string | null {
  return secret.length >= 16 ? secret.slice(-4) : null;
}

function publicKey(meta: { providerId: string; last4: string | null; validationStatus: string; createdAt: string; updatedAt: string }) {
  return {
    providerId: meta.providerId,
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
    const { providerId: provider, apiKey: secret } = body.data;
    const sealed = await seal(deps, user.userId, provider, secret);
    const meta = await deps.keys.create({ ownerId: user.userId, providerId: provider, ...sealed });
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
