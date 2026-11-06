import { z } from "zod";
import { AccessDeniedError } from "@/lib/auth/session";

const MAX_BODY_BYTES = 64 * 1024;

export function json(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export function apiError(status: number, code: string, message: string, details?: unknown): Response {
  return json(status, { error: { code, message, ...(details ? { details } : {}) } });
}

export const unauthorized = () => apiError(401, "unauthorized", "Authentication required.");

/** Parses a JSON body with a hard size cap and a zod schema. */
export async function parseJson<T extends z.ZodType>(
  request: Request,
  schema: T
): Promise<{ ok: true; data: z.infer<T> } | { ok: false; response: Response }> {
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    return { ok: false, response: apiError(415, "unsupported_media_type", "Content-Type must be application/json.") };
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
    return { ok: false, response: apiError(413, "payload_too_large", "Request body is too large.") };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, response: apiError(400, "invalid_json", "Request body is not valid JSON.") };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
    return { ok: false, response: apiError(422, "validation_failed", "Request validation failed.", issues) };
  }
  return { ok: true, data: parsed.data };
}

/** Logs only the error name, never message/stack (may carry provider or secret data). */
export function internalError(error: unknown): Response {
  if (error instanceof AccessDeniedError) {
    // The caller holds a valid sign-in for this very address, so echoing it back reveals nothing new
    // and makes allowlist typos easy to spot.
    console.warn("access_denied");
    const who = error.email ? ` (${error.email})` : "";
    return apiError(403, "forbidden", `You are signed in, but this account${who} is not allowed to use this app. The owner must add it to ALLOWED_USER_EMAILS.`);
  }
  console.error("api_error", error instanceof Error ? error.name : "unknown");
  return apiError(500, "internal_error", "Something went wrong.");
}
