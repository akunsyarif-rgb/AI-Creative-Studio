import { AccessDeniedError, type AuthUser, type TokenVerifier } from "./session";

/**
 * Access allowlist. An Appwrite project's user pool is shared by every app in
 * it, so any account in the project can obtain a valid JWT. Only accounts listed
 * in ALLOWED_USER_EMAILS and/or ALLOWED_USER_IDS may use this app's API.
 * With neither set, nobody is allowed (fail closed).
 */
export interface Allowlist {
  emails: ReadonlySet<string>;
  ids: ReadonlySet<string>;
}

const list = (raw: string | undefined) =>
  new Set((raw ?? "").split(",").map((v) => v.trim()).filter(Boolean));

export function parseAllowlist(env: Record<string, string | undefined>): Allowlist {
  return {
    emails: new Set([...list(env.ALLOWED_USER_EMAILS)].map((e) => e.toLowerCase())),
    ids: list(env.ALLOWED_USER_IDS)
  };
}

export const allowlistConfigured = (a: Allowlist) => a.emails.size + a.ids.size > 0;

export function isAllowed(user: AuthUser, allowlist: Allowlist): boolean {
  return allowlist.ids.has(user.userId) || (!!user.email && allowlist.emails.has(user.email.toLowerCase()));
}

/**
 * Wraps a verifier so signed-in users outside the allowlist are rejected with AccessDeniedError
 * (a 403), while invalid tokens still yield null (a 401).
 */
export function withAllowlist(verify: TokenVerifier, allowlist: Allowlist): TokenVerifier {
  return async (token) => {
    const user = await verify(token);
    if (!user) return null;
    if (!isAllowed(user, allowlist)) throw new AccessDeniedError(user.email);
    return user;
  };
}
