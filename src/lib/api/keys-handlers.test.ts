import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { deleteKey, getKey, getKeys, maskLast4, postKey, putKey } from "./keys-handlers";
import type { ApiDeps } from "./handlers";
import type { KeyMetadata, KeysRepository } from "@/lib/data/repositories";
import { decryptWithKeyring, encryptWithKeyring, parseKeyring } from "@/lib/security/secrets-core";
import { credentialContext } from "@/lib/security/credential-context";
import { ALICE, BOB, jsonRequest, verifyToken } from "./test-helpers";

const ring = parseKeyring(`k1:${randomBytes(32).toString("base64")}`);
const SECRET = "sk-live-ABCDEFGHIJKLMNOP1234";

function setup() {
  const rows = new Map<string, KeyMetadata & { ciphertext: string; keyId: string }>();
  const id = (o: string, p: string) => `${o}/${p}`;
  const meta = (r: KeyMetadata): KeyMetadata => ({ providerId: r.providerId, last4: r.last4, validationStatus: r.validationStatus, createdAt: r.createdAt, updatedAt: r.updatedAt });
  const keys: KeysRepository = {
    async create(i) {
      if (rows.has(id(i.ownerId, i.providerId))) return null;
      const row = { providerId: i.providerId, last4: i.last4, validationStatus: "unvalidated" as const, createdAt: "t0", updatedAt: "t0", ciphertext: i.ciphertext, keyId: i.keyId };
      rows.set(id(i.ownerId, i.providerId), row);
      return meta(row);
    },
    async replace(i) {
      const row = rows.get(id(i.ownerId, i.providerId));
      if (!row) return null;
      Object.assign(row, { ciphertext: i.ciphertext, keyId: i.keyId, last4: i.last4, validationStatus: "unvalidated", updatedAt: "t1" });
      return meta(row);
    },
    async get(o, p) { const r = rows.get(id(o, p)); return r ? meta(r) : null; },
    async list(o) { return [...rows.entries()].filter(([k]) => k.startsWith(`${o}/`)).map(([, r]) => meta(r)); },
    async delete(o, p) { return rows.delete(id(o, p)); }
  };
  const deps = { verifyToken, keys, vault: { encrypt: async (p: string, c: string) => encryptWithKeyring(ring, p, c) } } as unknown as ApiDeps;
  return { deps, rows };
}

describe("BYOK key routes", () => {
  it("requires authentication everywhere", async () => {
    const { deps } = setup();
    const r = () => jsonRequest("/api/keys", { body: { providerId: "openai", apiKey: SECRET } });
    for (const res of [await postKey(r(), deps), await getKeys(r(), deps), await getKey(r(), deps, "openai"), await putKey(r(), deps, "openai"), await deleteKey(r(), deps, "openai")]) {
      expect(res.status).toBe(401);
    }
  });

  it("stores only ciphertext bound to owner+provider, and returns masked metadata", async () => {
    const { deps, rows } = setup();
    const res = await postKey(jsonRequest("/api/keys", { token: ALICE, body: { providerId: "openai", apiKey: SECRET } }), deps);
    expect(res.status).toBe(201);
    const text = await res.text();
    expect(text).not.toContain(SECRET);
    expect(JSON.parse(text).key).toMatchObject({ providerId: "openai", masked: "••••1234", validationStatus: "unvalidated" });

    const row = rows.get("alice/openai")!;
    expect(row.ciphertext).not.toContain(SECRET);
    expect(row.keyId).toBe("k1");
    expect(decryptWithKeyring(ring, row.ciphertext, credentialContext("alice", "openai"))).toBe(SECRET);
    expect(() => decryptWithKeyring(ring, row.ciphertext, credentialContext("bob", "openai"))).toThrow();
  });

  it("never returns secret or ciphertext from any GET", async () => {
    const { deps } = setup();
    await postKey(jsonRequest("/api/keys", { token: ALICE, body: { providerId: "openai", apiKey: SECRET } }), deps);
    const list = await (await getKeys(jsonRequest("/api/keys", { token: ALICE, method: "GET" }), deps)).text();
    const one = await (await getKey(jsonRequest("/x", { token: ALICE, method: "GET" }), deps, "openai")).text();
    for (const body of [list, one]) {
      expect(body).not.toContain(SECRET);
      expect(body).not.toMatch(/ciphertext|bk1\.|keyId|ownerId/);
    }
  });

  it("does not reveal any characters of short keys", () => {
    expect(maskLast4("short-key-123")).toBeNull();
    expect(maskLast4(SECRET)).toBe("1234");
  });

  it("rejects duplicates on create (409) and keeps the original", async () => {
    const { deps, rows } = setup();
    await postKey(jsonRequest("/api/keys", { token: ALICE, body: { providerId: "openai", apiKey: SECRET } }), deps);
    const before = rows.get("alice/openai")!.ciphertext;
    const res = await postKey(jsonRequest("/api/keys", { token: ALICE, body: { providerId: "openai", apiKey: "another-secret-value-9999" } }), deps);
    expect(res.status).toBe(409);
    expect(rows.get("alice/openai")!.ciphertext).toBe(before);
  });

  it("rotates via PUT: new ciphertext, validation reset, 404 if missing", async () => {
    const { deps, rows } = setup();
    const missing = await putKey(jsonRequest("/x", { token: ALICE, method: "PUT", body: { apiKey: SECRET } }), deps, "openai");
    expect(missing.status).toBe(404);

    await postKey(jsonRequest("/api/keys", { token: ALICE, body: { providerId: "openai", apiKey: SECRET } }), deps);
    rows.get("alice/openai")!.validationStatus = "valid";
    const next = "sk-live-ZZZZZZZZZZZZZZZZ5678";
    const res = await putKey(jsonRequest("/x", { token: ALICE, method: "PUT", body: { apiKey: next } }), deps, "openai");
    expect(res.status).toBe(200);
    expect(await res.clone().text()).not.toContain(next);
    expect((await res.json()).key).toMatchObject({ masked: "••••5678", validationStatus: "unvalidated" });
    expect(decryptWithKeyring(ring, rows.get("alice/openai")!.ciphertext, credentialContext("alice", "openai"))).toBe(next);
  });

  it("isolates users: bob cannot read, rotate or delete alice's key", async () => {
    const { deps, rows } = setup();
    await postKey(jsonRequest("/api/keys", { token: ALICE, body: { providerId: "openai", apiKey: SECRET } }), deps);
    expect((await getKey(jsonRequest("/x", { token: BOB, method: "GET" }), deps, "openai")).status).toBe(404);
    expect((await putKey(jsonRequest("/x", { token: BOB, method: "PUT", body: { apiKey: SECRET } }), deps, "openai")).status).toBe(404);
    expect((await deleteKey(jsonRequest("/x", { token: BOB, method: "DELETE" }), deps, "openai")).status).toBe(404);
    expect((await (await getKeys(jsonRequest("/x", { token: BOB, method: "GET" }), deps)).json()).keys).toEqual([]);
    expect(rows.has("alice/openai")).toBe(true);
  });

  it("deletes a key", async () => {
    const { deps, rows } = setup();
    await postKey(jsonRequest("/api/keys", { token: ALICE, body: { providerId: "openai", apiKey: SECRET } }), deps);
    expect((await deleteKey(jsonRequest("/x", { token: ALICE, method: "DELETE" }), deps, "openai")).status).toBe(200);
    expect(rows.size).toBe(0);
    expect((await deleteKey(jsonRequest("/x", { token: ALICE, method: "DELETE" }), deps, "openai")).status).toBe(404);
  });

  it("validates input and does not echo the submitted secret in errors", async () => {
    const { deps } = setup();
    const bad = async (body: unknown) => postKey(jsonRequest("/api/keys", { token: ALICE, body }), deps);
    expect((await bad({ providerId: "OpenAI!", apiKey: SECRET })).status).toBe(422);
    expect((await bad({ providerId: "openai", apiKey: "short" })).status).toBe(422);
    const spaced = await bad({ providerId: "openai", apiKey: "has some spaces in it 123" });
    expect(spaced.status).toBe(422);
    expect(await spaced.text()).not.toContain("spaces in it");
    expect((await bad({ providerId: "openai", apiKey: "x".repeat(2001) })).status).toBe(422);
  });

  it("fails without leaking the secret when encryption is unavailable", async () => {
    const { deps } = setup();
    const broken = { ...deps, vault: { encrypt: async () => { throw new Error(`no key for ${SECRET}`); } } } as ApiDeps;
    const res = await postKey(jsonRequest("/api/keys", { token: ALICE, body: { providerId: "openai", apiKey: SECRET } }), broken);
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain(SECRET);
  });
});
