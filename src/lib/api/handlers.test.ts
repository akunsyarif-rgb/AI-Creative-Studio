import { describe, expect, it } from "vitest";
import { getJobs, postJob, postPresign, requestHash, type ApiDeps } from "./handlers";
import type { AssetRecord, JobRecord, JobsRepository, NewJob } from "@/lib/data/repositories";
import { createR2Storage } from "@/lib/storage/r2";

const TOKENS: Record<string, string> = { "token-for-alice-0000000000": "alice", "token-for-bob-000000000000": "bob" };

function makeDeps(overrides: Partial<ApiDeps> = {}) {
  const jobStore = new Map<string, JobRecord>();
  const assetStore = new Map<string, AssetRecord>();
  let seq = 0;
  const jobs: JobsRepository = {
    async createIdempotent(job: NewJob) {
      const key = `${job.ownerId}:${job.idempotencyKey}`;
      const existing = jobStore.get(key);
      if (existing) return { job: existing, created: false };
      const record: JobRecord = {
        ...job, id: `job${++seq}`, status: "queued", progress: null, errorCode: null, estimatedCost: null, currency: null,
        createdAt: "2026-01-01T00:00:00.000Z"
      };
      jobStore.set(key, record);
      return { job: record, created: true };
    },
    async listByOwner(ownerId, limit) {
      return [...jobStore.values()].filter((j) => j.ownerId === ownerId).slice(0, limit);
    }
  };
  const deps: ApiDeps = {
    verifyToken: async (t) => (TOKENS[t] ? { userId: TOKENS[t] } : null),
    jobs,
    assets: {
      async createPendingUpload(i) {
        const a: AssetRecord = { id: `asset${++seq}`, ownerId: i.ownerId, objectKey: i.objectKey, contentType: i.contentType, size: i.size, status: "pending" };
        assetStore.set(a.id, a);
        return a;
      },
      async findOwned(ownerId, ids) {
        return ids.map((i) => assetStore.get(i)).filter((a): a is AssetRecord => !!a && a.ownerId === ownerId);
      }
    },
    storage: createR2Storage({ endpoint: "https://acct.r2.cloudflarestorage.com", bucket: "b", accessKeyId: "AK", secretAccessKey: "SK" }),
    catalog: { supports: (p, m, c) => p === "fake" && m === "m1" && c === "text_to_image" },
    ...overrides
  };
  return { deps, jobStore, assetStore };
}

const req = (url: string, init: { token?: string; body?: unknown; method?: string; raw?: string; contentType?: string } = {}) =>
  new Request(`http://localhost${url}`, {
    method: init.method ?? "POST",
    headers: {
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
      "content-type": init.contentType ?? "application/json"
    },
    body: init.raw ?? (init.body === undefined ? undefined : JSON.stringify(init.body))
  });

const ALICE = "token-for-alice-0000000000";
const BOB = "token-for-bob-000000000000";
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
  it("creates a queued job (201) and does not dispatch anything", async () => {
    const { deps, jobStore } = makeDeps();
    const res = await postJob(req("/api/jobs", { token: ALICE, body: validJob }), deps);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.job.status).toBe("queued");
    expect(body.duplicate).toBe(false);
    expect(jobStore.size).toBe(1);
    expect(JSON.stringify(body)).not.toMatch(/ownerId|requestHash|idempotencyKey|parameters/);
  });

  it("returns the same job for a duplicate idempotency key without creating another", async () => {
    const { deps, jobStore } = makeDeps();
    const first = await (await postJob(req("/api/jobs", { token: ALICE, body: validJob }), deps)).json();
    const res = await postJob(req("/api/jobs", { token: ALICE, body: validJob }), deps);
    const second = await res.json();
    expect(res.status).toBe(200);
    expect(second.duplicate).toBe(true);
    expect(second.job.id).toBe(first.job.id);
    expect(jobStore.size).toBe(1);
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
    expect(res.status).toBe(201);
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
    const { deps } = makeDeps({ catalog: { supports: () => false } });
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
    expect(res.status).toBe(201);
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
    const { deps } = makeDeps({ jobs: { createIdempotent: async () => { throw new Error("db password=hunter2"); }, listByOwner: async () => [] } });
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
