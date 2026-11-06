import { describe, expect, it } from "vitest";
import { deleteJob, getAssetDownload, postJob } from "./handlers";
import { ALICE, BOB, PNG, createTestWorld, jsonRequest } from "./test-helpers";

const body = { projectId: "p1", capability: "text_to_image", providerId: "fake", modelId: "m1", parameters: { prompt: "a fox" }, idempotencyKey: "idem-delete-01" };
const del = (w: ReturnType<typeof createTestWorld>, id: string, token = ALICE) => deleteJob(jsonRequest(`/api/jobs/${id}`, { token, method: "DELETE" }), w.deps, id);

async function finishedJob(w: ReturnType<typeof createTestWorld>, key = "idem-delete-01", inputAssetId?: string) {
  const res = await postJob(jsonRequest("/api/jobs", { token: ALICE, body: { ...body, idempotencyKey: key, ...(inputAssetId ? { capability: "image_to_image", inputAssetIds: [inputAssetId] } : {}) } }), w.deps);
  const id = (await res.json()).job.id as string;
  await w.runTasks();
  return id;
}

describe("DELETE /api/jobs/:id", () => {
  it("removes the job, its generated files (record + stored object) and nothing else", async () => {
    const w = createTestWorld();
    w.seedKey("alice", "fake", "k");
    const upload = w.seedAsset({ id: "up1", ownerId: "alice", objectKey: "users/alice/11111111-1111-1111-1111-111111111111", contentType: "image/png", status: "uploaded" });
    w.objects.set(upload.objectKey, { data: PNG, contentType: "image/png" });
    const id = await finishedJob(w, "idem-delete-01", "up1");
    const job = w.jobs.get(id)!;
    expect(job.status).toBe("completed");
    const outputId = job.outputAssetIds[0];
    expect(w.objects.size).toBe(2);

    const res = await del(w, id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
    expect(w.jobs.has(id)).toBe(false);
    expect(w.assets.has(outputId)).toBe(false);
    expect(w.objects.size).toBe(1); // only the user's own upload is left
    expect(w.assets.has("up1")).toBe(true);
    // the deleted file can no longer be fetched
    expect((await getAssetDownload(jsonRequest(`/api/assets/${outputId}`, { token: ALICE, method: "GET" }), w.deps, outputId)).status).toBe(404);
  });

  it("deleting twice, an unknown id or another user's job gives 404 and changes nothing", async () => {
    const w = createTestWorld();
    w.seedKey("alice", "fake", "k");
    const id = await finishedJob(w);
    expect((await del(w, id, BOB)).status).toBe(404);
    expect(w.jobs.has(id)).toBe(true);
    expect(w.objects.size).toBe(1);
    expect((await del(w, id)).status).toBe(200);
    expect((await del(w, id)).status).toBe(404);
    expect((await del(w, "nope-1")).status).toBe(404);
    expect((await deleteJob(jsonRequest("/api/jobs/x", { method: "DELETE" }), w.deps, id)).status).toBe(401);
  });

  it("refuses a job that is still running, but not one that is far older than any job can run", async () => {
    const w = createTestWorld({ adapter: { submit: async () => new Promise(() => undefined) } });
    w.seedKey("alice", "fake", "k");
    const res = await postJob(jsonRequest("/api/jobs", { token: ALICE, body }), w.deps);
    const id = (await res.json()).job.id as string;
    expect((await del(w, id)).status).toBe(409);
    expect(w.jobs.has(id)).toBe(true);
    w.jobs.get(id)!.createdAt = new Date(Date.now() - 60 * 60_000).toISOString(); // stuck for an hour
    expect((await del(w, id)).status).toBe(200);
    expect(w.jobs.has(id)).toBe(false);
  });

  it("deletes a failed job (no files) too", async () => {
    const w = createTestWorld();
    w.seedKey("alice", "fake", "k");
    const id = await finishedJob(w);
    Object.assign(w.jobs.get(id)!, { status: "failed", outputAssetIds: [] });
    expect((await del(w, id)).status).toBe(200);
  });
});
