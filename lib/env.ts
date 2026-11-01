import { z } from "zod";

const optionalUrl = z.string().url().optional().or(z.literal(""));
const optionalSecret = z.string().optional().or(z.literal(""));

const serverSchema = z.object({
  APP_URL: optionalUrl,
  APP_ENCRYPTION_KEY: optionalSecret,
  SUPABASE_URL: optionalUrl,
  SUPABASE_SERVICE_ROLE_KEY: optionalSecret,
  R2_ACCOUNT_ID: optionalSecret,
  R2_ACCESS_KEY_ID: optionalSecret,
  R2_SECRET_ACCESS_KEY: optionalSecret,
  R2_BUCKET_NAME: optionalSecret,
  R2_ENDPOINT: optionalUrl,
});

export function getServerEnv() {
  return serverSchema.parse(process.env);
}

export function requireEncryptionKey(): Buffer {
  const encoded = process.env.APP_ENCRYPTION_KEY;
  if (!encoded) throw new Error("APP_ENCRYPTION_KEY is not configured.");

  const key = Buffer.from(encoded, "base64");
  if (key.byteLength !== 32) {
    throw new Error("APP_ENCRYPTION_KEY must be a base64-encoded 32-byte key.");
  }
  return key;
}
