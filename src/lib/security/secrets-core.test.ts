import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CredentialCryptoError,
  decryptWithKeyring,
  encryptWithKeyring,
  needsRotation,
  parseKeyring,
  rotateWithKeyring
} from "./secrets-core";

const b64 = () => randomBytes(32).toString("base64");
const ctx = "provider-credential:user1:openai";

describe("credential encryption", () => {
  it("round-trips and never contains plaintext", () => {
    const ring = parseKeyring(`k1:${b64()}`);
    const sealed = encryptWithKeyring(ring, "sk-secret-value", ctx);
    expect(sealed).not.toContain("sk-secret-value");
    expect(decryptWithKeyring(ring, sealed, ctx)).toBe("sk-secret-value");
  });

  it("uses a fresh IV per encryption", () => {
    const ring = parseKeyring(`k1:${b64()}`);
    expect(encryptWithKeyring(ring, "same", ctx)).not.toBe(encryptWithKeyring(ring, "same", ctx));
  });

  it("rejects a different context (ciphertext moved to another row)", () => {
    const ring = parseKeyring(`k1:${b64()}`);
    const sealed = encryptWithKeyring(ring, "secret", ctx);
    expect(() => decryptWithKeyring(ring, sealed, "provider-credential:user2:openai")).toThrow(CredentialCryptoError);
  });

  it("detects tampering in every segment", () => {
    const ring = parseKeyring(`k1:${b64()}`);
    const parts = encryptWithKeyring(ring, "secret", ctx).split(".");
    for (const i of [2, 3, 4]) {
      const bad = [...parts];
      const buf = Buffer.from(bad[i], "base64url");
      buf[0] ^= 0xff;
      bad[i] = buf.toString("base64url");
      expect(() => decryptWithKeyring(ring, bad.join("."), ctx)).toThrow(CredentialCryptoError);
    }
  });

  it("rejects wrong key, unknown key id, and malformed input", () => {
    const sealed = encryptWithKeyring(parseKeyring(`k1:${b64()}`), "secret", ctx);
    expect(() => decryptWithKeyring(parseKeyring(`k1:${b64()}`), sealed, ctx)).toThrow(CredentialCryptoError);
    expect(() => decryptWithKeyring(parseKeyring(`other:${b64()}`), sealed, ctx)).toThrow(/Unknown encryption key/);
    expect(() => decryptWithKeyring(parseKeyring(`k1:${b64()}`), "garbage", ctx)).toThrow(/format/);
  });

  it("requires a context and a non-empty secret", () => {
    const ring = parseKeyring(`k1:${b64()}`);
    expect(() => encryptWithKeyring(ring, "secret", "")).toThrow(/context/);
    expect(() => encryptWithKeyring(ring, "", ctx)).toThrow(/empty/);
  });

  it("does not leak plaintext or keys in error messages", () => {
    const ring = parseKeyring(`k1:${b64()}`);
    const sealed = encryptWithKeyring(ring, "super-secret", ctx);
    try {
      decryptWithKeyring(ring, sealed, "wrong");
    } catch (e) {
      expect(String(e)).not.toContain("super-secret");
    }
  });
});

describe("key rotation", () => {
  it("decrypts old values and re-seals with the new active key", () => {
    const oldKey = b64();
    const oldRing = parseKeyring(`v1:${oldKey}`);
    const sealed = encryptWithKeyring(oldRing, "secret", ctx);

    const newRing = parseKeyring(`v2:${b64()},v1:${oldKey}`);
    expect(newRing.activeKeyId).toBe("v2");
    expect(decryptWithKeyring(newRing, sealed, ctx)).toBe("secret");
    expect(needsRotation(newRing, sealed)).toBe(true);

    const rotated = rotateWithKeyring(newRing, sealed, ctx);
    expect(rotated.split(".")[1]).toBe("v2");
    expect(needsRotation(newRing, rotated)).toBe(false);
    expect(decryptWithKeyring(newRing, rotated, ctx)).toBe("secret");
  });

  it("cannot decrypt old values once the retired key is dropped", () => {
    const oldKey = b64();
    const sealed = encryptWithKeyring(parseKeyring(`v1:${oldKey}`), "secret", ctx);
    expect(() => decryptWithKeyring(parseKeyring(`v2:${b64()}`), sealed, ctx)).toThrow(/Unknown encryption key/);
  });
});

describe("parseKeyring", () => {
  it("fails closed on missing or invalid configuration", () => {
    expect(() => parseKeyring(undefined)).toThrow(/not configured/);
    expect(() => parseKeyring("  ")).toThrow(/not configured/);
    expect(() => parseKeyring("nocolon")).toThrow(/Invalid key id/);
    expect(() => parseKeyring("BAD ID:abc")).toThrow(/Invalid key id/);
    expect(() => parseKeyring(`k1:${Buffer.alloc(16).toString("base64")}`)).toThrow(/32 bytes/);
    const k = b64();
    expect(() => parseKeyring(`k1:${k},k1:${k}`)).toThrow(/Duplicate/);
  });
});
