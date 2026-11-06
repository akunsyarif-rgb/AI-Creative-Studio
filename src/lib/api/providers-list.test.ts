import { describe, expect, it } from "vitest";
import { getProviders, postJob, postProviderTest } from "./handlers";
import { ALICE, createTestWorld, fakeAdapter, jsonRequest } from "./test-helpers";
import { createProviderRegistry } from "@/lib/providers/registry";
import type { ProviderAdapter } from "@/lib/providers/types";

const get = (w: ReturnType<typeof createTestWorld>, token = ALICE) => getProviders(jsonRequest("/api/providers", { token, method: "GET" }), w.deps);

describe("GET /api/providers", () => {
  it("requires authentication", async () => {
    expect((await get(createTestWorld(), "")).status).toBe(401);
  });

  it("lists every registered provider with models and parameter specs, and no secrets or internals", async () => {
    const w = createTestWorld();
    const body = await (await get(w)).json();
    expect(body.providers).toEqual([
      {
        id: "fake", name: "Fake Provider", description: null, custom: false,
        models: [{
          modelId: "m1", displayName: "M1", capabilities: ["text_to_image", "image_to_image"], isFreeTier: false,
          parameters: [{ key: "size", label: "Size", default: "s", options: [{ value: "s", label: "Small" }] }]
        }]
      }
    ]);
  });

  it("reflects newly registered providers dynamically", async () => {
    const a = fakeAdapter().adapter;
    const b: ProviderAdapter = { ...a, config: { ...a.config, id: "second", name: "Second" } };
    const w = createTestWorld({ deps: { providers: createProviderRegistry([a, b]) } });
    expect((await (await get(w)).json()).providers.map((p: { id: string }) => p.id)).toEqual(["fake", "second"]);
  });
});

describe("dynamic provider resolution", () => {
  const job = { projectId: "p1", capability: "text_to_image", modelId: "m1", parameters: { prompt: "hi" }, idempotencyKey: "idem-key-0001" };

  function twoProviders() {
    const one = fakeAdapter({ validCredential: "key-one" });
    const two = fakeAdapter({ validCredential: "key-two" });
    const second: ProviderAdapter = { ...two.adapter, config: { ...two.adapter.config, id: "second" } };
    const w = createTestWorld({ deps: { providers: createProviderRegistry([one.adapter, second]) } });
    return { w, one, two };
  }

  it("routes /test to the adapter matching :id", async () => {
    const { w, one, two } = twoProviders();
    w.seedKey("alice", "fake", "key-one");
    w.seedKey("alice", "second", "key-two");
    expect((await (await postProviderTest(jsonRequest("/x", { token: ALICE }), w.deps, "second")).json()).validationStatus).toBe("valid");
    expect(two.calls.validate).toBe(1);
    expect(one.calls.validate).toBe(0);
    expect((await (await postProviderTest(jsonRequest("/x", { token: ALICE }), w.deps, "fake")).json()).validationStatus).toBe("valid");
    expect(one.calls.validate).toBe(1);
  });

  it("routes jobs to the adapter named by providerId, using that provider's key", async () => {
    const { w, one, two } = twoProviders();
    w.seedKey("alice", "second", "key-two");
    const res = await postJob(jsonRequest("/api/jobs", { token: ALICE, body: { ...job, providerId: "second" } }), w.deps);
    expect(res.status).toBe(202);
    await w.runTasks();
    expect(two.calls.submit).toBe(1);
    expect(one.calls.submit).toBe(0);
    expect([...w.jobs.values()][0]).toMatchObject({ providerId: "second", status: "completed" });
  });

  it("rejects an unregistered provider id", async () => {
    const { w } = twoProviders();
    const res = await postJob(jsonRequest("/api/jobs", { token: ALICE, body: { ...job, providerId: "ghost" } }), w.deps);
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("unsupported_capability");
    expect((await postProviderTest(jsonRequest("/x", { token: ALICE }), w.deps, "ghost")).status).toBe(404);
  });
});
