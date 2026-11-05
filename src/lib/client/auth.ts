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

/** Maps Appwrite errors to messages that do not leak account existence. */
export function authErrorMessage(error: unknown, mode: "signin" | "signup"): string {
  const code = (error as { code?: number })?.code;
  if (code === 429) return "Too many attempts. Wait a minute and try again.";
  if (mode === "signin") return "Email or password is incorrect.";
  if (code === 409) return "Could not create the account. Try signing in instead.";
  if (code === 400) return "Use a valid email and a password of at least 8 characters.";
  return "Something went wrong. Please try again.";
}
