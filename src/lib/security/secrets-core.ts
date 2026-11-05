import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Pure AES-256-GCM envelope with a rotatable keyring. No env access and no
 * "server-only" import so it can be unit-tested; app code must go through
 * `secrets.ts`, which is the server-only boundary.
 *
 * Format: bk1.<keyId>.<iv>.<ciphertext>.<tag>   (base64url segments)
 * The AAD (context) binds a ciphertext to its owner/provider, so a stored
 * value copied to another row fails authentication.
 */

const VERSION = "bk1";
const IV_BYTES = 12;
const KEY_BYTES = 32;
const KEY_ID_PATTERN = /^[a-z0-9_-]{1,16}$/;

export interface Keyring {
  /** Key used for all new encryptions. */
  readonly activeKeyId: string;
  readonly keys: ReadonlyMap<string, Buffer>;
}

export class CredentialCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialCryptoError";
  }
}

/**
 * Parse "id1:base64key,id2:base64key". The FIRST entry is the active key;
 * the rest are retained only to decrypt older values until re-encrypted.
 */
export function parseKeyring(raw: string | undefined): Keyring {
  if (!raw || !raw.trim()) {
    throw new CredentialCryptoError("CREDENTIAL_ENCRYPTION_KEYS is not configured.");
  }
  const keys = new Map<string, Buffer>();
  let activeKeyId: string | undefined;
  for (const entry of raw.split(",")) {
    const separator = entry.indexOf(":");
    const id = entry.slice(0, separator).trim();
    const encoded = entry.slice(separator + 1).trim();
    if (separator < 0 || !KEY_ID_PATTERN.test(id)) {
      throw new CredentialCryptoError("Invalid key id in CREDENTIAL_ENCRYPTION_KEYS.");
    }
    if (keys.has(id)) {
      throw new CredentialCryptoError("Duplicate key id in CREDENTIAL_ENCRYPTION_KEYS.");
    }
    const key = Buffer.from(encoded, "base64");
    if (key.length !== KEY_BYTES) {
      throw new CredentialCryptoError(`Key "${id}" must be ${KEY_BYTES} bytes (base64-encoded).`);
    }
    keys.set(id, key);
    activeKeyId ??= id;
  }
  return { activeKeyId: activeKeyId as string, keys };
}

function requireContext(context: string): Buffer {
  if (!context) throw new CredentialCryptoError("Encryption context is required.");
  return Buffer.from(context, "utf8");
}

export function encryptWithKeyring(keyring: Keyring, plaintext: string, context: string): string {
  if (!plaintext) throw new CredentialCryptoError("Refusing to encrypt an empty secret.");
  const aad = requireContext(context);
  const key = keyring.keys.get(keyring.activeKeyId);
  if (!key) throw new CredentialCryptoError("Active encryption key is missing.");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, keyring.activeKeyId, iv, body, tag]
    .map((part, i) => (i < 2 ? (part as string) : (part as Buffer).toString("base64url")))
    .join(".");
}

export function decryptWithKeyring(keyring: Keyring, ciphertext: string, context: string): string {
  const aad = requireContext(context);
  const parts = ciphertext.split(".");
  if (parts.length !== 5 || parts[0] !== VERSION) {
    throw new CredentialCryptoError("Unrecognized ciphertext format.");
  }
  const [, keyId, ivB64, bodyB64, tagB64] = parts;
  const key = keyring.keys.get(keyId);
  if (!key) throw new CredentialCryptoError(`Unknown encryption key "${keyId}".`);
  try {
    const iv = Buffer.from(ivB64, "base64url");
    const tag = Buffer.from(tagB64, "base64url");
    if (iv.length !== IV_BYTES || tag.length !== 16) throw new Error("bad lengths");
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(Buffer.from(bodyB64, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    // Deliberately generic: never reveal which check failed.
    throw new CredentialCryptoError("Credential could not be decrypted.");
  }
}

export function needsRotation(keyring: Keyring, ciphertext: string): boolean {
  const parts = ciphertext.split(".");
  return parts.length === 5 && parts[0] === VERSION && parts[1] !== keyring.activeKeyId;
}

/** Decrypt with whichever key sealed it, re-seal with the active key. */
export function rotateWithKeyring(keyring: Keyring, ciphertext: string, context: string): string {
  return encryptWithKeyring(keyring, decryptWithKeyring(keyring, ciphertext, context), context);
}
