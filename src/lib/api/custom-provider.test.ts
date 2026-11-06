import { describe, expect, it } from "vitest";
import { getProviders, postJob, postProviderTest } from "./handlers";
import { deleteKey, postKey, customProviderId } from "./keys-handlers";
import { ALICE, BOB, PNG, createTestWorld, jsonRequest, type TestWorld } from "./test-helpers";

const custom = { label: "Acme AI", baseUrl: "https://api.acme.example/v1/", models: ["acme/draw-1"], estimatedCostUsd: 0.05 };
const SECRET = "sk-acme-ABCDEFGHIJKLMNOP9999";

const add = (w: TestWorld, body: unknown, token = ALICE) => postKey(jsonRequest("/api/keys", { token, body }), w.deps);
const job = (w: TestWorld, over: Record<string, unknown> = {}, token = ALICE) =>
  postJob(jsonRequest("/api/jobs", { token, body: { projectId: "p1", capability: "text_to_image", providerId: "custom-acme-ai", modelId: "acme/draw-1", parameters: { prompt: "a cat" }, idempotencyKey: "idem-key-0001", ...over } }), w.deps);

describe("POST /api/keys with a custom provider", () => {
  it("saves a custom provider: derives the id, normalises the URL, encrypts the key, returns config but never the key", async () => {
    const w = createTestWorld();
    const res = await add(w, { apiKey: SECRET, custom });
    expect(res.status).toBe(201);
    const text = await res.text();
    expect(text).not.toContain(SECRET);
    const { key } = JSON.parse(text);
    expect(key).toMatchObject({ providerId: "custom-acme-ai", masked: "••••9999", custom: { label: "Acme AI", baseUrl: "https://api.acme.example/v1", models: ["acme/draw-1"], estimatedCostUsd: 0.05 } });
    const row = w.keys.get("alice/custom-acme-ai")!;
    expect(row.ciphertext).not.toContain(SECRET);
    expect(await w.deps.vault.decrypt(row.ciphertext, "provider-credential:alice:custom-acme-ai")).toBe(SECRET);
    expect(row.custom).toMatchObject({ baseUrl: "https://api.acme.example/v1" });
  });

  it("rejects unsafe base URLs before anything is stored (https only, public hosts only)", async () => {
    const w = createTestWorld();
    for (const baseUrl of ["http://api.acme.example/v1", "https://localhost/v1", "https://169.254.169.254/latest", "https://10.0.0.1/v1", "https://user:pw@api.acme.example/v1", "https://api.acme.example:8443/v1", "not a url"]) {
      const res = await add(w, { apiKey: SECRET, custom: { ...custom, baseUrl } });
      expect(res.status, baseUrl).toBe(422);
    }
    expect(w.keys.size).toBe(0);
  });

  it("rejects a host that resolves to a private address", async () => {
    const w = createTestWorld({ deps: { lookup: async () => [{ address: "192.168.1.10" }] } });
    const res = await add(w, { apiKey: SECRET, custom });
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("invalid_base_url");
    expect(w.keys.size).toBe(0);
  });

  it("validates the shape: model ids, counts, price range, label, reserved prefix, conflicting fields", async () => {
    const w = createTestWorld();
    const bad = async (body: unknown) => (await add(w, body)).status;
    expect(await bad({ apiKey: SECRET, custom: { ...custom, models: [] } })).toBe(422);
    expect(await bad({ apiKey: SECRET, custom: { ...custom, models: ["has space"] } })).toBe(422);
    expect(await bad({ apiKey: SECRET, custom: { ...custom, models: ["https://spicyapi.ai/models/some-model"] } })).toBe(422); // a page address, not a model id
    expect(await bad({ apiKey: SECRET, custom: { ...custom, models: Array.from({ length: 11 }, (_, i) => `m${i}`) } })).toBe(422);
    expect(await bad({ apiKey: SECRET, custom: { ...custom, estimatedCostUsd: 0 } })).toBe(422);
    expect(await bad({ apiKey: SECRET, custom: { ...custom, estimatedCostUsd: 1000 } })).toBe(422);
    expect(await bad({ apiKey: SECRET, custom: { ...custom, label: "!!" } })).toBe(422);
    expect(await bad({ apiKey: SECRET, providerId: "custom-sneaky" })).toBe(422);
    expect(await bad({ apiKey: SECRET, providerId: "openai", custom })).toBe(422);
    expect(await bad({ apiKey: SECRET })).toBe(422);
    expect(w.keys.size).toBe(0);
  });

  it("derives stable ids and rejects a duplicate name", async () => {
    expect(customProviderId("Acme AI")).toBe("custom-acme-ai");
    expect(customProviderId("  Together.ai / FLUX  ")).toBe("custom-together-ai-flux");
    expect(customProviderId("x")).toBeNull();
    const w = createTestWorld();
    expect((await add(w, { apiKey: SECRET, custom })).status).toBe(201);
    expect((await add(w, { apiKey: SECRET, custom: { ...custom, label: "acme-ai" } })).status).toBe(409);
  });

  it("keeps built-in provider keys working", async () => {
    const w = createTestWorld();
    const res = await add(w, { providerId: "openai", apiKey: SECRET });
    expect(res.status).toBe(201);
    expect((await res.json()).key.custom).toBeNull();
  });
});

describe("custom providers in the provider list, key test and jobs", () => {
  const seed = async () => {
    const w = createTestWorld();
    await add(w, { apiKey: SECRET, custom });
    return w;
  };

  it("lists a user's custom providers next to the built-in ones, and only to that user", async () => {
    const w = await seed();
    const mine = (await (await getProviders(jsonRequest("/api/providers", { token: ALICE, method: "GET" }), w.deps)).json()).providers;
    expect(mine.map((p: { id: string }) => p.id)).toEqual(["fake", "custom-acme-ai"]);
    expect(mine[1]).toMatchObject({ name: "Acme AI", custom: true, models: [{ modelId: "acme/draw-1", capabilities: ["text_to_image"] }] });
    expect(JSON.stringify(mine)).not.toContain(SECRET);
    const bobs = (await (await getProviders(jsonRequest("/api/providers", { token: BOB, method: "GET" }), w.deps)).json()).providers;
    expect(bobs.map((p: { id: string }) => p.id)).toEqual(["fake"]);
  });

  it("tests the key against the user's base URL", async () => {
    const w = await seed();
    const seen: string[] = [];
    w.customFetch.impl = (async (url: string, init: RequestInit) => { seen.push(`${url} ${(init.headers as Record<string, string>).Authorization}`); return Response.json({ data: [] }); }) as unknown as typeof fetch;
    const res = await postProviderTest(jsonRequest("/x", { token: ALICE }), w.deps, "custom-acme-ai");
    expect((await res.json()).validationStatus).toBe("valid");
    expect(seen).toEqual([`https://api.acme.example/v1/models Bearer ${SECRET}`]);
    expect(w.keys.get("alice/custom-acme-ai")!.validationStatus).toBe("valid");
  });

  it("does not let another user use or test someone else's custom provider", async () => {
    const w = await seed();
    w.seedKey("bob", "fake", "k");
    expect((await postProviderTest(jsonRequest("/x", { token: BOB }), w.deps, "custom-acme-ai")).status).toBe(404);
    const res = await job(w, {}, BOB);
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("unsupported_capability");
    expect(w.jobs.size).toBe(0);
  });

  it("requires cost confirmation based on the user's own estimate, enforces the ceiling, then generates and stores the image", async () => {
    const w = await seed();
    const first = await job(w);
    expect(first.status).toBe(409);
    expect((await first.json()).error.details.estimate.amount).toBe(0.05);
    expect(w.jobs.size).toBe(0);

    w.customFetch.impl = (async () => Response.json({ data: [{ b64_json: Buffer.from(PNG).toString("base64") }] })) as unknown as typeof fetch;
    const ok = await job(w, { confirmedMaxCostUsd: 0.05 });
    expect(ok.status).toBe(202);
    await w.runTasks();
    const done = [...w.jobs.values()][0];
    expect(done).toMatchObject({ status: "completed", providerId: "custom-acme-ai", estimatedCost: 0.05 });
    expect(w.objects.size).toBe(1);
  });

  it("applies the spend ceiling to custom providers too", async () => {
    const w = createTestWorld({ maxJobCostUsd: 1 });
    await add(w, { apiKey: SECRET, custom: { ...custom, estimatedCostUsd: 5 } });
    const res = await job(w, { confirmedMaxCostUsd: 100 });
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("budget_exceeded");
  });

  it("rejects unknown models and parameters for the custom provider before persisting", async () => {
    const w = await seed();
    expect((await job(w, { modelId: "other", confirmedMaxCostUsd: 1 })).status).toBe(422);
    expect((await job(w, { parameters: { prompt: "x", steps: 9 }, confirmedMaxCostUsd: 1 })).status).toBe(422);
    expect(w.jobs.size).toBe(0);
  });

  it("removes the provider from the list when its key is deleted", async () => {
    const w = await seed();
    expect((await deleteKey(jsonRequest("/x", { token: ALICE, method: "DELETE" }), w.deps, "custom-acme-ai")).status).toBe(200);
    const list = (await (await getProviders(jsonRequest("/api/providers", { token: ALICE, method: "GET" }), w.deps)).json()).providers;
    expect(list.map((p: { id: string }) => p.id)).toEqual(["fake"]);
  });
});

describe("custom providers without a price estimate", () => {
  const noPrice = { label: "Acme AI", baseUrl: "https://api.acme.example/v1", models: ["acme/draw-1"] };
  const seedUnknown = async (over: Record<string, unknown> = {}) => {
    const w = createTestWorld(over);
    expect((await add(w, { apiKey: SECRET, custom: noPrice })).status).toBe(201);
    return w;
  };

  it("saves the provider with a null estimate", async () => {
    const w = await seedUnknown();
    expect(w.keys.get("alice/custom-acme-ai")!.custom).toMatchObject({ estimatedCostUsd: null });
    const list = (await (await getProviders(jsonRequest("/api/providers", { token: ALICE, method: "GET" }), w.deps)).json()).providers;
    expect(list[1].description).toMatch(/price unknown/);
  });

  it("still validates a price when one is given", async () => {
    const w = createTestWorld();
    expect((await add(w, { apiKey: SECRET, custom: { ...noPrice, estimatedCostUsd: 0 } })).status).toBe(422);
    expect((await add(w, { apiKey: SECRET, custom: { ...noPrice, estimatedCostUsd: -1 } })).status).toBe(422);
    expect(w.keys.size).toBe(0);
  });

  it("asks for explicit 'price unknown' consent and persists nothing until it is given", async () => {
    const w = await seedUnknown();
    const first = await job(w);
    expect(first.status).toBe(409);
    const body = await first.json();
    expect(body.error.code).toBe("cost_confirmation_required");
    expect(body.error.details.estimate.amount).toBeNull();
    expect(w.jobs.size).toBe(0);
    expect(w.tasks).toHaveLength(0);
  });

  it("is not satisfied by a dollar confirmation, only by explicit unknown-price consent", async () => {
    const w = await seedUnknown();
    expect((await job(w, { confirmedMaxCostUsd: 1000 })).status).toBe(409);
    expect((await job(w, { confirmUnknownCost: false })).status).toBe(409);
    expect(w.jobs.size).toBe(0);
  });

  it("creates and runs the job once consent is given; no cost is recorded because none is known", async () => {
    const w = await seedUnknown();
    w.customFetch.impl = (async () => Response.json({ data: [{ b64_json: Buffer.from(PNG).toString("base64") }] })) as unknown as typeof fetch;
    const res = await job(w, { confirmUnknownCost: true });
    expect(res.status).toBe(202);
    expect((await res.json()).job.estimatedCost).toBeNull();
    await w.runTasks();
    expect([...w.jobs.values()][0]).toMatchObject({ status: "completed", estimatedCost: null });
  });

  it("consent must be given again for the next request (nothing is remembered)", async () => {
    const w = await seedUnknown();
    expect((await job(w, { confirmUnknownCost: true })).status).toBe(202);
    expect((await job(w, { idempotencyKey: "idem-key-0002" })).status).toBe(409);
  });

  it("does not let unknown-price consent bypass the cost gate of a provider that has a price", async () => {
    const w = createTestWorld({ maxJobCostUsd: 1 });
    await add(w, { apiKey: SECRET, custom: { ...noPrice, estimatedCostUsd: 0.05 } });
    expect((await job(w, { confirmUnknownCost: true })).status).toBe(409); // a dollar confirmation is still required
    expect((await job(w, { confirmUnknownCost: true, confirmedMaxCostUsd: 0.05 })).status).toBe(202);
  });
});

describe("custom HTTP providers through the API", () => {
  const http = { path: "/v1/generate", body: '{"model":"{{model}}","prompt":"{{prompt}}"}', responseKind: "json", responsePath: "images.0.b64" };
  const base = { label: "Acme HTTP", baseUrl: "https://api.acme.example", models: ["draw-1"] };
  const addHttp = (w: TestWorld, over: Record<string, unknown> = {}, token = ALICE) => add(w, { apiKey: SECRET, custom: { ...base, http: { ...http, ...over } } }, token);

  it("saves the template (normalised, non-secret), returns it without the key, and lists the provider", async () => {
    const w = createTestWorld();
    const res = await addHttp(w);
    expect(res.status).toBe(201);
    const text = await res.text();
    expect(text).not.toContain(SECRET);
    const { key } = JSON.parse(text);
    expect(key.providerId).toBe("custom-acme-http");
    expect(key.custom.http).toMatchObject({ path: "/v1/generate", authHeader: "Authorization", authScheme: "Bearer", responseKind: "json", responsePath: "images.0.b64", testPath: null });
    const list = (await (await getProviders(jsonRequest("/api/providers", { token: ALICE, method: "GET" }), w.deps)).json()).providers;
    expect(list.find((p: { id: string }) => p.id === "custom-acme-http")).toMatchObject({ custom: true, description: expect.stringContaining("Custom HTTP endpoint") });
  });

  it("rejects bad templates before storing anything", async () => {
    const w = createTestWorld();
    for (const over of [{ body: "{nope" }, { body: '{"x":"y"}' }, { body: '{"p":"{{prompt}}","k":"{{key}}"}' }, { path: "/a/../b" }, { path: "https://evil.example/x" }, { authHeader: "Host" }, { responsePath: undefined }, { authScheme: "Bearer x" }]) {
      expect((await addHttp(w, over)).status, JSON.stringify(over)).toBe(422);
    }
    expect(w.keys.size).toBe(0);
  });

  it("still applies the base-URL safety rules to HTTP providers", async () => {
    const w = createTestWorld();
    for (const baseUrl of ["http://api.acme.example", "https://localhost", "https://169.254.169.254", "https://10.0.0.1"]) {
      expect((await add(w, { apiKey: SECRET, custom: { ...base, baseUrl, http } })).status, baseUrl).toBe(422);
    }
    expect(w.keys.size).toBe(0);
  });

  it("generates through the template: cost gate, request shape, stored output", async () => {
    const w = createTestWorld();
    await addHttp(w, {});
    const seen: { url: string; body: unknown; auth: string }[] = [];
    w.customFetch.impl = (async (url: string, init: RequestInit) => {
      seen.push({ url, body: JSON.parse(init.body as string), auth: (init.headers as Record<string, string>).Authorization });
      return Response.json({ images: [{ b64: Buffer.from(PNG).toString("base64") }] });
    }) as unknown as typeof fetch;
    const body = { providerId: "custom-acme-http", modelId: "draw-1", parameters: { prompt: "a fox" } };
    const first = await job(w, body);
    expect(first.status).toBe(409); // unknown price: explicit consent required
    expect((await job(w, { ...body, confirmUnknownCost: true })).status).toBe(202);
    await w.runTasks();
    expect(seen).toEqual([{ url: "https://api.acme.example/v1/generate", body: { model: "draw-1", prompt: "a fox" }, auth: `Bearer ${SECRET}` }]);
    expect([...w.jobs.values()][0]).toMatchObject({ status: "completed", providerId: "custom-acme-http" });
    expect(w.objects.size).toBe(1);
  });

  it("tests the key through the configured check address", async () => {
    const w = createTestWorld();
    await addHttp(w, { testPath: "/v1/me" });
    const urls: string[] = [];
    w.customFetch.impl = (async (url: string) => { urls.push(url); return Response.json({ ok: true }); }) as unknown as typeof fetch;
    expect((await (await postProviderTest(jsonRequest("/x", { token: ALICE }), w.deps, "custom-acme-http")).json()).validationStatus).toBe("valid");
    expect(urls).toEqual(["https://api.acme.example/v1/me"]);
  });

  it("keeps HTTP providers private to their owner", async () => {
    const w = createTestWorld();
    await addHttp(w);
    const bobs = (await (await getProviders(jsonRequest("/api/providers", { token: BOB, method: "GET" }), w.deps)).json()).providers;
    expect(bobs.map((p: { id: string }) => p.id)).toEqual(["fake"]);
    expect((await postProviderTest(jsonRequest("/x", { token: BOB }), w.deps, "custom-acme-http")).status).toBe(404);
  });

  it("rejects model names with dot segments", async () => {
    const w = createTestWorld();
    expect((await add(w, { apiKey: SECRET, custom: { ...base, models: ["a/../b"], http } })).status).toBe(422);
  });
});
