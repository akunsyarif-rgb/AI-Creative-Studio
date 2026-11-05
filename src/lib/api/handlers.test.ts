import { describe, expect, it } from "vitest";
import { getJobs, getJobById, postJob, postPresign, requestHash } from "./handlers";
import { ALICE, BOB, createTestWorld, jsonRequest as req } from "./test-helpers";

const world = (o: Parameters<typeof createTestWorld>[0] = {}) => {
  const w = createTestWorld(o);
  w.seedKey("alice", "fake", "good-key");
  w.seedKey("bob", "fake", "good-key");
  return w;
};
const makeDeps = (o: Parameters<typeof createTestWorld>[0] = {}) => {
  const w = world(o);
  return { deps: w.deps, jobStore: w.jobs, assetStore: w.assets, w };
};
const validJob = { projectId: "p1", capability: "text_to_image", providerId: "fake", modelId: "m1", parameters: { prompt: "a cat" }, idempotencyKey: "idem-key-0001" };

describe("authentication", () => {
  it("rejects missing, malformed and unknown tokens on every route", async () => {
    const { deps } = makeDeps();
    for (const token of [undefined, "short", "unknown-token-0000000000000"]) {
      expect((await postJob(req("/api/jobs", { token, body: validJob }), deps)).status).toBe(401);
      expect((await getJobs(req("/api/jobs", { token, method: "GET" }), deps)).status).toBe(401);
      expect((await postPresign(req("/api/uploads/presign", { token, body: {} }), deps)).status).toBe(401);
    }
  });
});

describe("POST /api/jobs", () => {
  it("creates a queued job (202) and schedules execution without calling the provider inline", async () => {
    const { deps, jobStore, w } = makeDeps();
    const res = await postJob(req("/api/jobs", { token: ALICE, body: validJob }), deps);
    expect(res.status).toBe(202);
    expect(w.tasks).toHaveLength(1);
    expect(w.calls.submit).toBe(0);
    const body = await res.json();
    expect(body.job.status).toBe("queued");
    expect(body.duplicate).toBe(false);
    expect(jobStore.size).toBe(1);
    expect(JSON.stringify(body)).not.toMatch(/ownerId|requestHash|idempotencyKey|parameters/);
  });

  it("returns the same job for a duplicate idempotency key without scheduling a second submission", async () => {
    const { deps, jobStore, w } = makeDeps();
    const first = await (await postJob(req("/api/jobs", { token: ALICE, body: validJob }), deps)).json();
    const res = await postJob(req("/api/jobs", { token: ALICE, body: validJob }), deps);
    const second = await res.json();
    expect(res.status).toBe(200);
    expect(second.duplicate).toBe(true);
    expect(second.job.id).toBe(first.job.id);
    expect(jobStore.size).toBe(1);
    expect(w.tasks).toHaveLength(1);
    await w.runTasks();
    expect(w.calls.submit).toBe(1);
  });

  it("rejects an idempotency key reused with different parameters", async () => {
    const { deps } = makeDeps();
    await postJob(req("/api/jobs", { token: ALICE, body: validJob }), deps);
    const res = await postJob(req("/api/jobs", { token: ALICE, body: { ...validJob, parameters: { prompt: "a dog" } } }), deps);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("idempotency_conflict");
  });

  it("scopes idempotency keys per user", async () => {
    const { deps, jobStore } = makeDeps();
    await postJob(req("/api/jobs", { token: ALICE, body: validJob }), deps);
    const res = await postJob(req("/api/jobs", { token: BOB, body: validJob }), deps);
    expect(res.status).toBe(202);
    expect(jobStore.size).toBe(2);
  });

  it("blocks unsupported capability before persisting", async () => {
    const { deps, jobStore } = makeDeps();
    const res = await postJob(req("/api/jobs", { token: ALICE, body: { ...validJob, capability: "text_to_video" } }), deps);
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("unsupported_capability");
    expect(jobStore.size).toBe(0);
  });

  it("fails closed with the default empty catalog", async () => {
    const { deps } = makeDeps({ deps: { catalog: { supports: () => false, adapter: () => undefined } } });
    expect((await postJob(req("/api/jobs", { token: ALICE, body: validJob }), deps)).status).toBe(422);
  });

  it("rejects input assets owned by someone else or not yet uploaded, indistinguishably", async () => {
    const { deps, assetStore } = makeDeps();
    assetStore.set("bobAsset", { id: "bobAsset", ownerId: "bob", objectKey: "k", contentType: "image/png", size: 1, status: "uploaded" });
    assetStore.set("pendingAsset", { id: "pendingAsset", ownerId: "alice", objectKey: "k2", contentType: "image/png", size: 1, status: "pending" });
    const a = await postJob(req("/api/jobs", { token: ALICE, body: { ...validJob, inputAssetIds: ["bobAsset"] } }), deps);
    const b = await postJob(req("/api/jobs", { token: ALICE, body: { ...validJob, inputAssetIds: ["pendingAsset"] } }), deps);
    const c = await postJob(req("/api/jobs", { token: ALICE, body: { ...validJob, inputAssetIds: ["doesNotExist"] } }), deps);
    for (const res of [a, b, c]) {
      expect(res.status).toBe(422);
      expect((await res.json()).error.code).toBe("invalid_input_assets");
    }
  });

  it("accepts owned, uploaded input assets", async () => {
    const { deps, assetStore } = makeDeps();
    assetStore.set("a1", { id: "a1", ownerId: "alice", objectKey: "k", contentType: "image/png", size: 1, status: "uploaded" });
    const res = await postJob(req("/api/jobs", { token: ALICE, body: { ...validJob, capability: "text_to_image", inputAssetIds: ["a1", "a1"] } }), deps);
    expect(res.status).toBe(202);
    expect((await res.json()).job.inputAssetIds).toEqual(["a1"]);
  });

  it("validates input shape, content type, size and JSON", async () => {
    const { deps } = makeDeps();
    const bad = async (init: Parameters<typeof req>[1]) => (await postJob(req("/api/jobs", { token: ALICE, ...init }), deps)).status;
    expect(await bad({ body: { ...validJob, capability: "teleport" } })).toBe(422);
    expect(await bad({ body: { ...validJob, idempotencyKey: "x" } })).toBe(422);
    expect(await bad({ body: { ...validJob, projectId: "../x" } })).toBe(422);
    expect(await bad({ raw: "{nope" })).toBe(400);
    expect(await bad({ body: validJob, contentType: "text/plain" })).toBe(415);
    expect(await bad({ raw: JSON.stringify({ ...validJob, parameters: { p: "x".repeat(70_000) } }) })).toBe(413);
  });

  it("returns a generic 500 without leaking internal details", async () => {
    const base = makeDeps();
    const { deps } = makeDeps({ deps: { jobs: { ...base.deps.jobs, createIdempotent: async () => { throw new Error("db password=hunter2"); } } } });
    const res = await postJob(req("/api/jobs", { token: ALICE, body: validJob }), deps);
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("hunter2");
  });
});

describe("GET /api/jobs", () => {
  it("returns only the caller's jobs", async () => {
    const { deps } = makeDeps();
    await postJob(req("/api/jobs", { token: ALICE, body: validJob }), deps);
    const bob = await (await getJobs(req("/api/jobs", { token: BOB, method: "GET" }), deps)).json();
    const alice = await (await getJobs(req("/api/jobs", { token: ALICE, method: "GET" }), deps)).json();
    expect(bob.jobs).toHaveLength(0);
    expect(alice.jobs).toHaveLength(1);
  });
});

describe("provider key, validation and cost gates", () => {
  const paid = { amount: 0.05, currency: "USD", isEstimate: true as const };

  it("requires a saved provider key before creating a job", async () => {
    const w = createTestWorld();
    const res = await postJob(req("/api/jobs", { token: ALICE, body: validJob }), w.deps);
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("provider_key_missing");
    expect(w.jobs.size).toBe(0);
  });

  it("rejects invalid parameters before persisting", async () => {
    const { deps, jobStore } = makeDeps();
    const res = await postJob(req("/api/jobs", { token: ALICE, body: { ...validJob, parameters: {} } }), deps);
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("invalid_parameters");
    expect(jobStore.size).toBe(0);
  });

  it("asks for explicit confirmation of paid usage and persists nothing until given", async () => {
    const { deps, jobStore, w } = makeDeps({ adapter: { estimate: paid } });
    const first = await postJob(req("/api/jobs", { token: ALICE, body: validJob }), deps);
    expect(first.status).toBe(409);
    const body = await first.json();
    expect(body.error.code).toBe("cost_confirmation_required");
    expect(body.error.details.estimate.amount).toBe(0.05);
    const low = await postJob(req("/api/jobs", { token: ALICE, body: { ...validJob, confirmedMaxCostUsd: 0.01 } }), deps);
    expect(low.status).toBe(409);
    expect(jobStore.size).toBe(0);
    expect(w.tasks).toHaveLength(0);

    const ok = await postJob(req("/api/jobs", { token: ALICE, body: { ...validJob, confirmedMaxCostUsd: 0.05 } }), deps);
    expect(ok.status).toBe(202);
    expect([...jobStore.values()][0].estimatedCost).toBe(0.05);
  });

  it("enforces the per-job spend ceiling even with confirmation", async () => {
    const { deps, jobStore } = makeDeps({ adapter: { estimate: { ...paid, amount: 5 } }, maxJobCostUsd: 1 });
    const res = await postJob(req("/api/jobs", { token: ALICE, body: { ...validJob, confirmedMaxCostUsd: 100 } }), deps);
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("budget_exceeded");
    expect(jobStore.size).toBe(0);
  });

  it("runs the job to completion through the scheduler and stores the output privately", async () => {
    const { deps, w } = makeDeps();
    const created = await (await postJob(req("/api/jobs", { token: ALICE, body: validJob }), deps)).json();
    await w.runTasks();
    const done = await (await getJobById(req("/x", { token: ALICE, method: "GET" }), deps, created.job.id)).json();
    expect(done.job.status).toBe("completed");
    expect(done.job.outputAssetIds).toHaveLength(1);
    expect(w.objects.size).toBe(1);
    expect([...w.objects.keys()][0]).toMatch(/^users\/alice\//);
  });

  it("does not let another user read a job by id", async () => {
    const { deps } = makeDeps();
    const created = await (await postJob(req("/api/jobs", { token: ALICE, body: validJob }), deps)).json();
    expect((await getJobById(req("/x", { token: BOB, method: "GET" }), deps, created.job.id)).status).toBe(404);
  });

  it("rate limits job creation", async () => {
    const { deps } = makeDeps({ limits: { jobs: { limit: 1, windowSeconds: 60 }, keys: { limit: 5, windowSeconds: 60 }, uploads: { limit: 5, windowSeconds: 60 }, providerTest: { limit: 5, windowSeconds: 60 } } });
    await postJob(req("/api/jobs", { token: ALICE, body: validJob }), deps);
    const res = await postJob(req("/api/jobs", { token: ALICE, body: { ...validJob, idempotencyKey: "idem-key-0002" } }), deps);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
  });
});

describe("requestHash", () => {
  it("is stable across key order and input asset order, and sensitive to content", () => {
    const base = { ...validJob, inputAssetIds: ["b", "a"], capability: "text_to_image" as const };
    const h = requestHash({ ...base, parameters: { x: 1, y: 2 } });
    expect(requestHash({ ...base, inputAssetIds: ["a", "b"], parameters: { y: 2, x: 1 } })).toBe(h);
    expect(requestHash({ ...base, parameters: { x: 1, y: 3 } })).not.toBe(h);
  });
});

describe("POST /api/uploads/presign", () => {
  const upload = { contentType: "image/png", size: 4096, originalName: "cat.png" };

  it("creates a pending asset record and returns a signed PUT URL for a server-chosen key", async () => {
    const { deps, assetStore } = makeDeps();
    const res = await postPresign(req("/api/uploads/presign", { token: ALICE, body: upload }), deps);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.method).toBe("PUT");
    expect(new URL(body.uploadUrl).pathname).toMatch(/\/users\/alice\/[0-9a-f-]{36}$/);
    expect(body.headers).toEqual({ "Content-Type": "image/png" });
    const asset = assetStore.get(body.assetId)!;
    expect(asset.status).toBe("pending");
    expect(asset.ownerId).toBe("alice");
    expect(JSON.stringify(body)).not.toContain("objectKey");
  });

  it("rejects unsupported types and oversize files before creating any record", async () => {
    const { deps, assetStore } = makeDeps();
    const t = await postPresign(req("/api/uploads/presign", { token: ALICE, body: { ...upload, contentType: "text/html" } }), deps);
    const s = await postPresign(req("/api/uploads/presign", { token: ALICE, body: { ...upload, size: 999 * 1024 * 1024 } }), deps);
    expect(t.status).toBe(422);
    expect(s.status).toBe(413);
    expect(assetStore.size).toBe(0);
  });

  it("validates the body", async () => {
    const { deps } = makeDeps();
    expect((await postPresign(req("/api/uploads/presign", { token: ALICE, body: { contentType: "image/png" } }), deps)).status).toBe(422);
    expect((await postPresign(req("/api/uploads/presign", { token: ALICE, body: { ...upload, size: -1 } }), deps)).status).toBe(422);
  });
});
