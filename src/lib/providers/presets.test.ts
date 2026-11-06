import { describe, expect, it } from "vitest";
import { OPENAI_COMPATIBLE_PRESETS, SPICYAPI_PRESET } from "./presets";
import { createOpenAICompatibleAdapter } from "./adapters/openai-compatible";
import { providerRegistry } from "./index";
import { createProviderRegistry } from "./registry";
import { parsePublicHttpsUrl } from "@/lib/net/public-url";
import { getProviders, postJob } from "@/lib/api/handlers";
import { postKey } from "@/lib/api/keys-handlers";
import { ALICE, PNG, createTestWorld, jsonRequest } from "@/lib/api/test-helpers";

const publicDns = async () => [{ address: "93.184.216.34" }];

describe("OpenAI-compatible presets", () => {
  it("are well formed: unique ids, not clashing with custom ids, safe https addresses, at least one model", () => {
    const ids = OPENAI_COMPATIBLE_PRESETS.map((p) => p.providerId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of OPENAI_COMPATIBLE_PRESETS) {
      expect(p.providerId).toMatch(/^[a-z0-9][a-z0-9_-]{1,63}$/);
      expect(p.providerId.startsWith("custom-")).toBe(false);
      expect(() => parsePublicHttpsUrl(p.baseUrl), p.providerId).not.toThrow();
      expect(p.baseUrl.endsWith("/")).toBe(false);
      expect(p.models.length).toBeGreaterThan(0);
      expect(p.description.length).toBeGreaterThan(10);
    }
  });

  it("has the SpicyAPI slot prepared with the requested address and model", () => {
    expect(SPICYAPI_PRESET).toMatchObject({
      providerId: "spicyapi", label: "SpicyAPI", baseUrl: "https://api.spicyapi.com/v1", models: ["spicy-image-1"], estimatedCostUsd: null
    });
  });

  it("registers every preset in the application registry next to OpenAI, with the dropdown config the Studio reads", () => {
    const spicy = providerRegistry.get("spicyapi")!;
    expect(spicy.config).toMatchObject({ id: "spicyapi", name: "SpicyAPI", description: SPICYAPI_PRESET.description });
    expect(spicy.config.availableModels.map((m) => m.modelId)).toEqual(["spicy-image-1"]);
    expect(spicy.config.availableModels[0].capabilities).toEqual(["text_to_image"]);
    expect(providerRegistry.supports("spicyapi", "spicy-image-1", "text_to_image")).toBe(true);
    expect(providerRegistry.supports("spicyapi", "other-model", "text_to_image")).toBe(false);
    expect(providerRegistry.has("openai")).toBe(true);
  });
});

describe("SpicyAPI slot end to end", () => {
  const worldWith = (respond: (url: string, init: RequestInit) => Response) => {
    const calls: { url: string; auth: string; body: unknown }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, auth: (init.headers as Record<string, string>).Authorization, body: JSON.parse((init.body as string) ?? "null") });
      return respond(url, init);
    }) as unknown as typeof fetch;
    const adapter = createOpenAICompatibleAdapter(SPICYAPI_PRESET, { fetch: fetchImpl, lookup: publicDns }, { description: SPICYAPI_PRESET.description });
    const w = createTestWorld({ deps: { providers: createProviderRegistry([adapter]) } });
    return { w, calls };
  };
  const ok = () => Response.json({ data: [{ b64_json: Buffer.from(PNG).toString("base64") }] });
  const body = { projectId: "p1", capability: "text_to_image", providerId: "spicyapi", modelId: "spicy-image-1", parameters: { prompt: "a fox" }, idempotencyKey: "idem-key-0001" };

  it("appears in the provider list the Studio and Keys pages read", async () => {
    const { w } = worldWith(ok);
    const list = (await (await getProviders(jsonRequest("/api/providers", { token: ALICE, method: "GET" }), w.deps)).json()).providers;
    expect(list).toEqual([
      expect.objectContaining({ id: "spicyapi", name: "SpicyAPI", custom: false, models: [expect.objectContaining({ modelId: "spicy-image-1", capabilities: ["text_to_image"] })] })
    ]);
  });

  it("saves its key like any built-in provider (encrypted, masked in responses)", async () => {
    const { w } = worldWith(ok);
    const secret = "spicy-key-ABCDEFGHIJKLMNOP4242";
    const res = await postKey(jsonRequest("/api/keys", { token: ALICE, body: { providerId: "spicyapi", apiKey: secret } }), w.deps);
    expect(res.status).toBe(201);
    const text = await res.text();
    expect(text).not.toContain(secret);
    expect(JSON.parse(text).key).toMatchObject({ providerId: "spicyapi", masked: "••••4242", custom: null });
    expect(w.keys.get("alice/spicyapi")!.ciphertext).not.toContain(secret);
  });

  it("asks for 'price unknown' consent, then calls the configured address with the configured model and the user's key", async () => {
    const { w, calls } = worldWith(ok);
    w.seedKey("alice", "spicyapi", "spicy-secret-key");
    const first = await postJob(jsonRequest("/api/jobs", { token: ALICE, body }), w.deps);
    expect(first.status).toBe(409);
    expect((await first.json()).error.details.estimate.amount).toBeNull();
    expect(calls).toHaveLength(0);

    expect((await postJob(jsonRequest("/api/jobs", { token: ALICE, body: { ...body, confirmUnknownCost: true } }), w.deps)).status).toBe(202);
    await w.runTasks();
    expect(calls).toEqual([{ url: "https://api.spicyapi.com/v1/images/generations", auth: "Bearer spicy-secret-key", body: { model: "spicy-image-1", prompt: "a fox", n: 1 } }]);
    expect([...w.jobs.values()][0]).toMatchObject({ status: "completed", providerId: "spicyapi" });
    expect(w.objects.size).toBe(1);
  });

  it("refuses a model that is not in the slot's list before anything is persisted", async () => {
    const { w, calls } = worldWith(ok);
    w.seedKey("alice", "spicyapi", "k");
    const res = await postJob(jsonRequest("/api/jobs", { token: ALICE, body: { ...body, modelId: "not-listed", confirmUnknownCost: true } }), w.deps);
    expect(res.status).toBe(422);
    expect(w.jobs.size).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("fails safely when the host is not reachable: the key is never sent and nothing is retried", async () => {
    const calls: string[] = [];
    const adapter = createOpenAICompatibleAdapter(
      SPICYAPI_PRESET,
      { fetch: (async (u: string) => { calls.push(u); return ok(); }) as unknown as typeof fetch, lookup: async () => { throw new Error("ENOTFOUND"); } }
    );
    await expect(adapter.testKey("k")).rejects.toMatchObject({ code: "invalid_request", outcomeKnown: true });
    await expect(adapter.executeJob({ capability: "text_to_image", modelId: "spicy-image-1", inputAssetIds: [], parameters: { prompt: "x" } }, "i", { secret: "k", inputFiles: [] })).rejects.toMatchObject({ outcomeKnown: true });
    expect(calls).toHaveLength(0);
  });
});
