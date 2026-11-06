import { describe, expect, it } from "vitest";
import { getAssetDownload, getJobs, postJob } from "./handlers";
import { ALICE, BOB, createTestWorld, jsonRequest } from "./test-helpers";

async function seedJobs(w: ReturnType<typeof createTestWorld>, n: number, token = ALICE) {
  for (let i = 1; i <= n; i++) {
    const res = await postJob(jsonRequest("/api/jobs", { token, body: { projectId: "p", capability: "text_to_image", providerId: "fake", modelId: "m1", parameters: { prompt: `prompt ${i}` }, idempotencyKey: `idem-key-${token.slice(10, 15)}-${i}` } }), w.deps);
    expect(res.status).toBe(202);
    // These tests are about listing, not about the concurrency limit: let each job finish first.
    for (const job of w.jobs.values()) job.status = "completed";
  }
}
const list = (w: ReturnType<typeof createTestWorld>, qs = "", token = ALICE) => getJobs(jsonRequest(`/api/jobs${qs}`, { token, method: "GET" }), w.deps);

describe("GET /api/jobs (library)", () => {
  it("returns newest first with the prompt for display, and no internal fields", async () => {
    const w = createTestWorld();
    w.seedKey("alice", "fake", "k");
    await seedJobs(w, 3);
    const body = await (await list(w)).json();
    expect(body.jobs.map((j: { prompt: string }) => j.prompt)).toEqual(["prompt 3", "prompt 2", "prompt 1"]);
    expect(body.nextCursor).toBeNull();
    expect(JSON.stringify(body)).not.toMatch(/ownerId|requestHash|idempotencyKey|parameters/);
  });

  it("paginates with a cursor without gaps or duplicates", async () => {
    const w = createTestWorld();
    w.seedKey("alice", "fake", "k");
    await seedJobs(w, 5);
    const first = await (await list(w, "?limit=2")).json();
    expect(first.jobs.map((j: { prompt: string }) => j.prompt)).toEqual(["prompt 5", "prompt 4"]);
    expect(first.nextCursor).toBe(first.jobs[1].id);
    const second = await (await list(w, `?limit=2&cursor=${first.nextCursor}`)).json();
    expect(second.jobs.map((j: { prompt: string }) => j.prompt)).toEqual(["prompt 3", "prompt 2"]);
    const third = await (await list(w, `?limit=2&cursor=${second.nextCursor}`)).json();
    expect(third.jobs.map((j: { prompt: string }) => j.prompt)).toEqual(["prompt 1"]);
    expect(third.nextCursor).toBeNull();
  });

  it("never mixes in other users' jobs and rejects malformed cursors", async () => {
    const w = createTestWorld();
    w.seedKey("alice", "fake", "k");
    w.seedKey("bob", "fake", "k");
    await seedJobs(w, 2);
    await seedJobs(w, 2, BOB);
    expect((await (await list(w)).json()).jobs).toHaveLength(2);
    expect((await (await list(w, "", BOB)).json()).jobs).toHaveLength(2);
    expect((await list(w, "?cursor=../etc")).status).toBe(400);
  });
});

describe("GET /api/assets/:id", () => {
  const get = (w: ReturnType<typeof createTestWorld>, id: string, qs = "", token = ALICE) =>
    getAssetDownload(jsonRequest(`/api/assets/${id}${qs}`, { token, method: "GET" }), w.deps, id);

  it("returns a short-lived inline URL by default and an attachment URL with ?download=1", async () => {
    const w = createTestWorld();
    const a = w.seedAsset({ id: "g1", ownerId: "alice" });
    const inline = new URL((await (await get(w, "g1")).json()).download.url);
    expect(inline.searchParams.get("response-content-disposition")).toBeNull();
    expect(inline.pathname).toContain(a.objectKey);
    expect(inline.searchParams.get("X-Amz-Expires")).toBe("300");
    const attach = new URL((await (await get(w, "g1", "?download=1")).json()).download.url);
    expect(attach.searchParams.get("response-content-disposition")).toBe('attachment; filename="studio-g1.png"');
  });

  it("is not available for other users' or non-uploaded assets", async () => {
    const w = createTestWorld();
    w.seedAsset({ id: "g1", ownerId: "alice" });
    w.seedAsset({ id: "p1", ownerId: "alice", status: "pending" });
    expect((await get(w, "g1", "", BOB)).status).toBe(404);
    expect((await get(w, "p1")).status).toBe(404);
    expect((await get(w, "g1", "", "")).status).toBe(401);
  });

  it("has its own, roomier rate limit so a gallery page can load many thumbnails", async () => {
    const w = createTestWorld({ limits: { assetRead: { limit: 3, windowSeconds: 60 }, uploads: { limit: 1, windowSeconds: 60 }, keys: { limit: 1, windowSeconds: 60 }, providerTest: { limit: 1, windowSeconds: 60 }, jobs: { limit: 1, windowSeconds: 60 } } });
    w.seedAsset({ id: "g1", ownerId: "alice" });
    for (let i = 0; i < 3; i++) expect((await get(w, "g1")).status).toBe(200);
    expect((await get(w, "g1")).status).toBe(429);
  });
});
