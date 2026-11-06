/** Authenticated caller. `userId` is the Appwrite user id and the data owner key. */
export interface AuthUser {
  userId: string;
  /** Lower-cased account email, when the identity provider supplies one. */
  email?: string;
}

/** Verifies a bearer token and returns the user, or null if invalid. Never throws on bad tokens. */
export type TokenVerifier = (token: string) => Promise<AuthUser | null>;

const BEARER = /^Bearer ([A-Za-z0-9._~+/=-]{20,4096})$/;

export async function authenticate(request: Request, verify: TokenVerifier): Promise<AuthUser | null> {
  const match = BEARER.exec(request.headers.get("authorization") ?? "");
  if (!match) return null;
  return verify(match[1]);
}
