/** Authenticated caller. `userId` is the Appwrite user id and the data owner key. */
export interface AuthUser {
  userId: string;
  /** Lower-cased account email, when the identity provider supplies one. */
  email?: string;
}

/** Verifies a bearer token and returns the user, or null if invalid. Never throws on bad tokens. */
export type TokenVerifier = (token: string) => Promise<AuthUser | null>;

/**
 * Thrown by a verifier when the token is valid but the account is not permitted to use this app.
 * Handlers turn it into a 403 (distinct from 401, which means "not signed in").
 */
export class AccessDeniedError extends Error {
  constructor(public readonly email?: string) {
    super("access_denied");
    this.name = "AccessDeniedError";
  }
}

const BEARER = /^Bearer ([A-Za-z0-9._~+/=-]{20,4096})$/;

export async function authenticate(request: Request, verify: TokenVerifier): Promise<AuthUser | null> {
  const match = BEARER.exec(request.headers.get("authorization") ?? "");
  if (!match) return null;
  return verify(match[1]);
}
