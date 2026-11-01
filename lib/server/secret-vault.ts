import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { requireEncryptionKey } from "@/lib/env";

const VERSION = "v1";
const ALGORITHM = "aes-256-gcm";

export type EncryptedSecret = {
  version: 1;
  value: string;
};

export function encryptSecret(plaintext: string): EncryptedSecret {
  if (!plaintext.trim()) throw new Error("Secret cannot be empty.");

  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, requireEncryptionKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return {
    version: 1,
    value: [VERSION, iv.toString("base64"), tag.toString("base64"), ciphertext.toString("base64")].join("."),
  };
}

export function decryptSecret(payload: EncryptedSecret): string {
  if (payload.version !== 1) throw new Error("Unsupported encrypted secret version.");

  const [version, ivEncoded, tagEncoded, ciphertextEncoded, extra] = payload.value.split(".");
  if (version !== VERSION || !ivEncoded || !tagEncoded || !ciphertextEncoded || extra) {
    throw new Error("Malformed encrypted secret payload.");
  }

  const decipher = createDecipheriv(
    ALGORITHM,
    requireEncryptionKey(),
    Buffer.from(ivEncoded, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tagEncoded, "base64"));

  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextEncoded, "base64")),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}

export function maskSecret(secret: string): string {
  if (secret.length <= 8) return "••••••••";
  return `${secret.slice(0, 4)}••••••••${secret.slice(-4)}`;
}
