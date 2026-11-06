import { describe, expect, it } from "vitest";
import { appwriteAssetsRepository, appwriteJobsRepository, appwriteKeysRepository, decodeModels, deterministicId, type RepoContext } from "./appwrite-repositories";
import { TABLES, TABLE_SPECS } from "@/lib/appwrite/schema";
import { createFakeTables } from "@/lib/appwrite/fake-tables";

async function setup() {
  const fake = createFakeTables();
  for (const spec of TABLE_SPECS) await fake.api.createTable({ tableId: spec.id, name: spec.name });
  const ctx = { tables: fake.api, databaseId: "studio" } as unknown as RepoContext;
  return { fake, ctx, rows: (t: keyof typeof TABLES) => fake.state.tables.get(TABLES[t])!.rows };
}

const newJob = (over: Record<string, unknown> = {}) => ({
  ownerId: "alice", projectId: "p1", capability: "text_to_image" as const, providerId: "openai", modelId: "m",
  inputAssetIds: [], parameters: { prompt: "a cat" }, idempotencyKey: "idem-key-0001", requestHash: "h", ...over
});

describe("jobs repository", () => {
  it("creates once per (owner, idempotencyKey) and returns the original on a duplicate", async () => {
    const { ctx, rows } = await setup();
    const repo = appwriteJobsRepository(ctx);
    const first = await repo.createIdempotent(newJob());
    const second = await repo.createIdempotent(newJob());
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.job.id).toBe(first.job.id);
    expect(rows("jobs").size).toBe(1);
    expect((await repo.createIdempotent(newJob({ ownerId: "bob" }))).created).toBe(true); // same key, other owner
    expect(first.job.id).toBe(deterministicId("alice", "idem-key-0001"));
  });

  it("stores owner-only read permissions and serialises parameters", async () => {
    const { ctx, rows } = await setup();
    await appwriteJobsRepository(ctx).createIdempotent(newJob({ estimatedCost: 0.04 }));
    const row = [...rows("jobs").values()][0];
    expect(row.$permissions).toEqual(['read("user:alice")']);
    expect(row.parameters).toBe('{"prompt":"a cat"}');
    expect(row.status).toBe("queued");
    expect(row.currency).toBe("USD");
  });

  it("only returns a job to its owner", async () => {
    const { ctx } = await setup();
    const repo = appwriteJobsRepository(ctx);
    const { job } = await repo.createIdempotent(newJob());
    expect((await repo.getOwned("alice", job.id))?.parameters).toEqual({ prompt: "a cat" });
    expect(await repo.getOwned("bob", job.id)).toBeNull();
    expect(await repo.getOwned("alice", "missing")).toBeNull();
  });

  it("deletes only the owner's own job, and reports a missing one", async () => {
    const { ctx, rows } = await setup();
    const repo = appwriteJobsRepository(ctx);
    const { job } = await repo.createIdempotent(newJob());
    expect(await repo.delete("bob", job.id)).toBe(false);
    expect(rows("jobs").has(job.id)).toBe(true);
    expect(await repo.delete("alice", job.id)).toBe(true);
    expect(rows("jobs").has(job.id)).toBe(false);
    expect(await repo.delete("alice", job.id)).toBe(false);
    expect(await repo.delete("alice", "missing")).toBe(false);
  });

  it("lists newest first, scoped to the owner, with cursor pagination", async () => {
    const { ctx } = await setup();
    const repo = appwriteJobsRepository(ctx);
    for (let i = 1; i <= 5; i++) await repo.createIdempotent(newJob({ idempotencyKey: `idem-key-000${i}`, parameters: { prompt: `p${i}` } }));
    await repo.createIdempotent(newJob({ ownerId: "bob", idempotencyKey: "idem-key-bob1" }));
    const p1 = await repo.listByOwner("alice", 2);
    expect(p1.jobs.map((j) => j.parameters.prompt)).toEqual(["p5", "p4"]);
    const p2 = await repo.listByOwner("alice", 2, p1.nextCursor!);
    expect(p2.jobs.map((j) => j.parameters.prompt)).toEqual(["p3", "p2"]);
    const p3 = await repo.listByOwner("alice", 2, p2.nextCursor!);
    expect(p3.jobs.map((j) => j.parameters.prompt)).toEqual(["p1"]);
    expect(p3.nextCursor).toBeNull();
  });

  it("updates status fields", async () => {
    const { ctx } = await setup();
    const repo = appwriteJobsRepository(ctx);
    const { job } = await repo.createIdempotent(newJob());
    await repo.update(job.id, { status: "completed", progress: 100, outputAssetIds: ["a1"] });
    expect(await repo.getOwned("alice", job.id)).toMatchObject({ status: "completed", progress: 100, outputAssetIds: ["a1"] });
  });
});

describe("assets repository", () => {
  it("creates owner-scoped rows and finds only the owner's", async () => {
    const { ctx, rows } = await setup();
    const repo = appwriteAssetsRepository(ctx);
    const mine = await repo.createPendingUpload({ ownerId: "alice", objectKey: "users/alice/k", contentType: "image/png", size: 10 });
    const theirs = await repo.createPendingUpload({ ownerId: "bob", objectKey: "users/bob/k", contentType: "image/png", size: 10 });
    expect(mine.status).toBe("pending");
    expect(rows("metadata").get(mine.id)!.$permissions).toEqual(['read("user:alice")', 'update("user:alice")', 'delete("user:alice")']);
    expect((await repo.findOwned("alice", [mine.id, theirs.id])).map((a) => a.id)).toEqual([mine.id]);
    expect(await repo.findOwned("alice", [])).toEqual([]);
    await repo.setStatus(mine.id, "uploaded");
    expect((await repo.findOwned("alice", [mine.id]))[0].status).toBe("uploaded");
  });

  it("deletes only the owner's own record, and reports a missing one", async () => {
    const { ctx, rows } = await setup();
    const repo = appwriteAssetsRepository(ctx);
    const mine = await repo.createPendingUpload({ ownerId: "alice", objectKey: "users/alice/k", contentType: "image/png", size: 10 });
    expect(await repo.delete("bob", mine.id)).toBe(false);
    expect(rows("metadata").has(mine.id)).toBe(true);
    expect(await repo.delete("alice", mine.id)).toBe(true);
    expect(rows("metadata").has(mine.id)).toBe(false);
    expect(await repo.delete("alice", mine.id)).toBe(false);
  });

  it("records generated outputs as uploaded", async () => {
    const { ctx, rows } = await setup();
    const a = await appwriteAssetsRepository(ctx).createGenerated({ ownerId: "alice", projectId: "p", objectKey: "users/alice/g", contentType: "image/png", size: 5, sourceJobId: "j1" });
    expect(a.status).toBe("uploaded");
    expect(rows("metadata").get(a.id)).toMatchObject({ origin: "generated", sourceJobId: "j1" });
  });
});

describe("keys repository", () => {
  const secret = { ownerId: "alice", providerId: "openai", ciphertext: "bk1.k1.aaa.bbb.ccc", keyId: "k1", last4: "1234" };

  it("creates once, stores no user-readable permissions, and never returns the ciphertext from metadata reads", async () => {
    const { ctx, rows } = await setup();
    const repo = appwriteKeysRepository(ctx);
    expect(await repo.create(secret)).toMatchObject({ providerId: "openai", last4: "1234", validationStatus: "unvalidated" });
    expect(await repo.create(secret)).toBeNull();
    expect([...rows("keys").values()][0].$permissions).toEqual([]);
    for (const meta of [await repo.get("alice", "openai"), ...(await repo.list("alice"))]) {
      expect(JSON.stringify(meta)).not.toContain("bk1.");
    }
    expect(await repo.getCiphertext("alice", "openai")).toBe("bk1.k1.aaa.bbb.ccc");
  });

  it("isolates owners: ids are owner-derived, so another user addresses a different (missing) row", async () => {
    const { ctx } = await setup();
    const repo = appwriteKeysRepository(ctx);
    await repo.create(secret);
    expect(await repo.get("bob", "openai")).toBeNull();
    expect(await repo.getCiphertext("bob", "openai")).toBeNull();
    expect(await repo.list("bob")).toEqual([]);
    expect(await repo.replace({ ...secret, ownerId: "bob" })).toBeNull();
    expect(await repo.delete("bob", "openai")).toBe(false);
    expect(await repo.setValidation("bob", "openai", "valid")).toBe(false);
  });

  it("updates only models and price of the owner's own custom row", async () => {
    const { ctx } = await setup();
    const repo = appwriteKeysRepository(ctx);
    const custom = { label: "Acme", baseUrl: "https://api.acme.example/v1", models: ["m1", "m2"], estimatedCostUsd: 0.05 };
    await repo.create({ ...secret, providerId: "custom-acme", custom });
    await repo.create({ ...secret, providerId: "openai" });
    expect(await repo.updateCustom({ ownerId: "alice", providerId: "custom-acme", models: ["x1"], estimatedCostUsd: null })).toBeTruthy();
    expect(await repo.getCustomConfig("alice", "custom-acme")).toMatchObject({ baseUrl: custom.baseUrl, models: ["x1"], estimatedCostUsd: null });
    expect(await repo.getCiphertext("alice", "custom-acme")).toBe("bk1.k1.aaa.bbb.ccc");
    expect(await repo.updateCustom({ ownerId: "bob", providerId: "custom-acme", models: ["x"], estimatedCostUsd: null })).toBeNull();
    expect(await repo.updateCustom({ ownerId: "alice", providerId: "openai", models: ["x"], estimatedCostUsd: null })).toBeNull();
  });

  it("stores per-model prices inside the models column without a schema change, and reads old rows", async () => {
    const { ctx, rows } = await setup();
    const repo = appwriteKeysRepository(ctx);
    const custom = { label: "Acme", baseUrl: "https://api.acme.example/v1", models: ["m1", "m2"], estimatedCostUsd: 0.05, modelPrices: { m2: 0.2, gone: 9 } };
    await repo.create({ ...secret, providerId: "custom-acme", custom });
    expect(await repo.getCustomConfig("alice", "custom-acme")).toMatchObject({ models: ["m1", "m2"], modelPrices: { m2: 0.2 } });
    expect(JSON.parse([...rows("keys").values()][0].models as string)).toEqual({ ids: ["m1", "m2"], prices: { m2: 0.2 } });
    await repo.updateCustom({ ownerId: "alice", providerId: "custom-acme", models: ["m1"], estimatedCostUsd: 0.05, modelPrices: { m2: 0.2 } });
    const after = await repo.getCustomConfig("alice", "custom-acme");
    expect(after?.models).toEqual(["m1"]);
    expect(after?.modelPrices).toBeUndefined();
    expect(JSON.parse([...rows("keys").values()][0].models as string)).toEqual(["m1"]); // back to a plain array
    expect(decodeModels('["a","b"]')).toEqual({ models: ["a", "b"], prices: {} });
    expect(decodeModels("garbage")).toEqual({ models: [], prices: {} });
    expect(decodeModels('{"ids":["a"],"prices":{"a":-1,"b":2,"constructor":3}}')).toEqual({ models: ["a"], prices: {} });
  });

  it("rotates, validates and deletes", async () => {
    const { ctx } = await setup();
    const repo = appwriteKeysRepository(ctx);
    await repo.create(secret);
    expect(await repo.setValidation("alice", "openai", "valid")).toBe(true);
    expect((await repo.get("alice", "openai"))?.validationStatus).toBe("valid");
    const rotated = await repo.replace({ ...secret, ciphertext: "bk1.k2.x.y.z", keyId: "k2", last4: "9999" });
    expect(rotated).toMatchObject({ last4: "9999", validationStatus: "unvalidated" });
    expect(await repo.getCiphertext("alice", "openai")).toBe("bk1.k2.x.y.z");
    expect(await repo.delete("alice", "openai")).toBe(true);
    expect(await repo.delete("alice", "openai")).toBe(false);
  });
});

describe("keys repository: custom providers", () => {
  const secret = { ownerId: "alice", providerId: "custom-acme", ciphertext: "bk1.k1.aaa.bbb.ccc", keyId: "k1", last4: "1234" };
  const custom = { label: "Acme", baseUrl: "https://api.acme.example/v1", models: ["m1", "m2"], estimatedCostUsd: 0.05 };

  it("stores and returns the non-secret settings, never the ciphertext", async () => {
    const { ctx, rows } = await setup();
    const repo = appwriteKeysRepository(ctx);
    const meta = await repo.create({ ...secret, custom });
    expect(meta?.custom).toEqual({ providerId: "custom-acme", ...custom, http: null });
    expect(rows("keys").size).toBe(1);
    expect((await repo.get("alice", "custom-acme"))?.custom).toMatchObject({ models: ["m1", "m2"], estimatedCostUsd: 0.05 });
    expect(await repo.getCustomConfig("alice", "custom-acme")).toEqual({ providerId: "custom-acme", ...custom, http: null });
    expect(await repo.listCustom("alice")).toEqual([{ providerId: "custom-acme", ...custom, http: null }]);
    for (const out of [await repo.get("alice", "custom-acme"), await repo.getCustomConfig("alice", "custom-acme"), await repo.listCustom("alice")]) {
      expect(JSON.stringify(out)).not.toContain("bk1.");
    }
  });

  it("returns null/empty for built-in keys, other owners and missing rows", async () => {
    const { ctx } = await setup();
    const repo = appwriteKeysRepository(ctx);
    await repo.create({ ...secret, providerId: "openai" });
    await repo.create({ ...secret, custom });
    expect((await repo.get("alice", "openai"))?.custom).toBeNull();
    expect(await repo.getCustomConfig("alice", "openai")).toBeNull();
    expect(await repo.getCustomConfig("bob", "custom-acme")).toBeNull();
    expect(await repo.getCustomConfig("alice", "custom-missing")).toBeNull();
    expect((await repo.listCustom("alice")).map((c) => c.providerId)).toEqual(["custom-acme"]);
    expect(await repo.listCustom("bob")).toEqual([]);
  });

  it("survives a corrupt models column without throwing", async () => {
    const { ctx, rows } = await setup();
    const repo = appwriteKeysRepository(ctx);
    await repo.create({ ...secret, custom });
    [...rows("keys").values()][0].models = "{not json";
    expect((await repo.getCustomConfig("alice", "custom-acme"))?.models).toEqual([]);
  });

  it("stores no price column when the estimate is unknown, and reads it back as null", async () => {
    const { ctx, rows } = await setup();
    const repo = appwriteKeysRepository(ctx);
    const meta = await repo.create({ ...secret, custom: { ...custom, estimatedCostUsd: null } });
    expect(meta?.custom?.estimatedCostUsd).toBeNull();
    expect([...rows("keys").values()][0]).not.toHaveProperty("estimatedCostUsd");
    expect((await repo.getCustomConfig("alice", "custom-acme"))?.estimatedCostUsd).toBeNull();
  });

  it("round-trips a custom HTTP template and tolerates a corrupt one", async () => {
    const { ctx, rows } = await setup();
    const repo = appwriteKeysRepository(ctx);
    const http = { path: "/models/{{model}}", authHeader: "Authorization", authScheme: "Bearer", body: '{"inputs":"{{prompt}}"}', responseKind: "binary" as const, responsePath: null, testPath: null };
    await repo.create({ ...secret, custom: { ...custom, http } });
    expect((await repo.getCustomConfig("alice", "custom-acme"))?.http).toEqual(http);
    expect([...rows("keys").values()][0].httpConfig).toBe(JSON.stringify(http));
    [...rows("keys").values()][0].httpConfig = "{broken";
    expect((await repo.getCustomConfig("alice", "custom-acme"))?.http).toBeNull();
    [...rows("keys").values()][0].httpConfig = JSON.stringify({ path: 1 });
    expect((await repo.getCustomConfig("alice", "custom-acme"))?.http).toBeNull();
  });
});
