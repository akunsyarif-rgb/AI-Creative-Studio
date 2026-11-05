import "server-only";
import { Account, Client, Databases } from "node-appwrite";
import { z } from "zod";
import type { AuthUser, TokenVerifier } from "@/lib/auth/session";

const envSchema = z.object({
  APPWRITE_ENDPOINT: z.url(),
  APPWRITE_PROJECT_ID: z.string().min(1),
  APPWRITE_API_KEY: z.string().min(1),
  APPWRITE_DATABASE_ID: z.string().min(1)
});

export function appwriteConfig() {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) throw new Error("Appwrite is not configured (missing or invalid APPWRITE_* variables).");
  return parsed.data;
}

/** Privileged client. Server-only; bypasses permissions, so callers must enforce ownership. */
export function adminDatabases(): { databases: Databases; databaseId: string } {
  const c = appwriteConfig();
  const client = new Client().setEndpoint(c.APPWRITE_ENDPOINT).setProject(c.APPWRITE_PROJECT_ID).setKey(c.APPWRITE_API_KEY);
  return { databases: new Databases(client), databaseId: c.APPWRITE_DATABASE_ID };
}

/** Validates an Appwrite session JWT (created client-side with account.createJWT()). */
export const verifyAppwriteJwt: TokenVerifier = async (token): Promise<AuthUser | null> => {
  const c = appwriteConfig();
  try {
    const client = new Client().setEndpoint(c.APPWRITE_ENDPOINT).setProject(c.APPWRITE_PROJECT_ID).setJWT(token);
    const user = await new Account(client).get();
    return user.status ? { userId: user.$id } : null;
  } catch {
    return null;
  }
};
