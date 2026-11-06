import { describe, expect, it } from "vitest";
import { appwriteAssetsRepository, appwriteJobsRepository, appwriteKeysRepository, deterministicId, type RepoContext } from "./appwrite-repositories";
import { TABLE_SPECS } from "@/lib/appwrite/schema";
import { createFakeTables } from "@/lib/appwrite/fake-tables";

async function setup() {
  const fake = createFakeTables();
  for (const spec of TABLE_SPECS) await fake.api.createTable({ tableId: spec.id, name: spec.name });
  const ctx = { tables: fake.api, databaseId: "studio" } as unknown as RepoContext;
  return { fake, ctx, rows: (t: string) => fake.state.tables.get(t)!.rows };
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
