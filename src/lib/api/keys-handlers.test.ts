import { describe, expect, it } from "vitest";
import { deleteKey, getKey, getKeys, maskLast4, postKey, putKey } from "./keys-handlers";
import { credentialContext } from "@/lib/security/credential-context";
import type { ApiDeps } from "./handlers";
import { ALICE, BOB, createTestWorld, jsonRequest } from "./test-helpers";

const SECRET = "sk-live-ABCDEFGHIJKLMNOP1234";

function setup() {
  const w = createTestWorld();
  // Same ciphertext format as production, with the world's own keyring.
  const rows = {
    has: (k: string) => w.keys.has(k),
    get: (k: string) => w.keys.get(k)!,
    get size() { return w.keys.size; }
  };
  return { deps: w.deps, rows, w };
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
    expect(row.ciphertext.split(".")[1]).toBe("k1");
    expect(await deps.vault.decrypt(row.ciphertext, credentialContext("alice", "openai"))).toBe(SECRET);
    await expect(deps.vault.decrypt(row.ciphertext, credentialContext("bob", "openai"))).rejects.toThrow();
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
    expect(await deps.vault.decrypt(rows.get("alice/openai")!.ciphertext, credentialContext("alice", "openai"))).toBe(next);
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

  it("rate limits key operations per user", async () => {
    const w = createTestWorld({ limits: { keys: { limit: 2, windowSeconds: 60 }, uploads: { limit: 1, windowSeconds: 60 }, providerTest: { limit: 1, windowSeconds: 60 }, jobs: { limit: 1, windowSeconds: 60 } } });
    const get = (token: string) => getKeys(jsonRequest("/api/keys", { token, method: "GET" }), w.deps);
    expect((await get(ALICE)).status).toBe(200);
    expect((await get(ALICE)).status).toBe(200);
    const blocked = await get(ALICE);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBeTruthy();
    expect((await get(BOB)).status).toBe(200);
  });

  it("fails without leaking the secret when encryption is unavailable", async () => {
    const { deps } = setup();
    const broken = { ...deps, vault: { ...deps.vault, encrypt: async () => { throw new Error(`no key for ${SECRET}`); } } } as ApiDeps;
    const res = await postKey(jsonRequest("/api/keys", { token: ALICE, body: { providerId: "openai", apiKey: SECRET } }), broken);
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain(SECRET);
  });
});
