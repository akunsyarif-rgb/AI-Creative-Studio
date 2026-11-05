import "server-only";
import {
  decryptWithKeyring,
  encryptWithKeyring,
  needsRotation as needsRotationCore,
  parseKeyring,
  rotateWithKeyring,
  type Keyring
} from "./secrets-core";

/**
 * Server-only boundary for BYOK provider credentials. Keys come from
 * CREDENTIAL_ENCRYPTION_KEYS ("activeId:b64,olderId:b64"); never log or return
 * plaintext. `context` must identify the owner and provider (see
 * `credentialContext`) so ciphertext cannot be moved between rows.
 */

let cached: { raw: string | undefined; keyring: Keyring } | undefined;

function keyring(): Keyring {
  const raw = process.env.CREDENTIAL_ENCRYPTION_KEYS;
  if (!cached || cached.raw !== raw) cached = { raw, keyring: parseKeyring(raw) };
  return cached.keyring;
}

export function credentialContext(ownerId: string, providerId: string): string {
  return `provider-credential:${ownerId}:${providerId}`;
}

export async function encryptProviderCredential(plaintext: string, context: string): Promise<string> {
  return encryptWithKeyring(keyring(), plaintext, context);
}

export async function decryptProviderCredential(ciphertext: string, context: string): Promise<string> {
  return decryptWithKeyring(keyring(), ciphertext, context);
}

export function credentialNeedsRotation(ciphertext: string): boolean {
  return needsRotationCore(keyring(), ciphertext);
}

export async function rotateProviderCredential(ciphertext: string, context: string): Promise<string> {
  return rotateWithKeyring(keyring(), ciphertext, context);
}
