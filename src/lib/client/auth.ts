import { Account, Client, ID } from "appwrite";

/** Public (non-secret) Appwrite settings; safe to ship to the browser. */
const endpoint = process.env.NEXT_PUBLIC_APPWRITE_ENDPOINT;
const projectId = process.env.NEXT_PUBLIC_APPWRITE_PROJECT_ID;

export const authConfigured = Boolean(endpoint && projectId);

let account: Account | undefined;
function acct(): Account {
  if (!authConfigured) throw new Error("Authentication is not configured.");
  account ??= new Account(new Client().setEndpoint(endpoint as string).setProject(projectId as string));
  return account;
}

export interface SessionUser {
  id: string;
  email: string;
}

export async function currentUser(): Promise<SessionUser | null> {
  if (!authConfigured) return null;
  try {
    const u = await acct().get();
    return { id: u.$id, email: u.email };
  } catch {
    return null;
  }
}

export async function signIn(email: string, password: string): Promise<void> {
  await acct().createEmailPasswordSession({ email, password });
}

export async function signUp(email: string, password: string): Promise<void> {
  await acct().create({ userId: ID.unique(), email, password });
  await signIn(email, password);
}

export async function signOut(): Promise<void> {
  jwtCache = undefined;
  try {
    await acct().deleteSession({ sessionId: "current" });
  } catch {
    /* already signed out */
  }
}

// Appwrite JWTs live 15 minutes; refresh a little early.
let jwtCache: { token: string; expires: number } | undefined;
export async function getJwt(): Promise<string> {
  if (jwtCache && jwtCache.expires > Date.now()) return jwtCache.token;
  const { jwt } = await acct().createJWT();
  jwtCache = { token: jwt, expires: Date.now() + 10 * 60_000 };
  return jwt;
}

interface AppwriteLikeError {
  code?: number;
  type?: string;
}

/**
 * Maps Appwrite errors to messages. Sign-in failures stay generic (they must not reveal whether an
 * account exists), but configuration problems are named so they can be fixed, and unknown errors
 * include Appwrite's numeric code and error type (neither contains secrets).
 */
export function authErrorMessage(error: unknown, mode: "signin" | "signup"): string {
  const e = (error ?? {}) as AppwriteLikeError;
  const code = e.code;
  const type = e.type;

  if (code === 429) return "Too many attempts. Wait a minute and try again.";
  if (type === "general_unknown_origin" || (code === 403 && type?.includes("origin"))) {
    return "This site's address is not registered in Appwrite. Add it under Apps → Web (hostname only, no https://).";
  }
  if (code === 501 || type === "user_auth_method_unsupported") {
    return "Email/password sign-in is turned off in Appwrite. Enable it under Auth → Settings.";
  }
  if (code === undefined || code === 0) {
    return "Could not reach Appwrite. Check your connection and that the Appwrite endpoint is correct.";
  }
  if (mode === "signin" && (code === 401 || code === 400)) return "Email or password is incorrect.";
  if (mode === "signup") {
    if (code === 409) return "Could not create the account. Try signing in instead.";
    if (code === 400) return "Use a valid email and a password of at least 8 characters.";
  }
  return `Something went wrong (Appwrite ${code}${type ? `: ${type}` : ""}). Please try again.`;
}
