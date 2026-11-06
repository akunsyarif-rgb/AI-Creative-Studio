import { describe, expect, it } from "vitest";
import { getJobById, postJob } from "./handlers";
import { ALICE, BOB, MP4, createTestWorld, jsonRequest } from "./test-helpers";

const body = { projectId: "p1", capability: "text_to_image", providerId: "fake", modelId: "m1", parameters: { prompt: "waves" }, idempotencyKey: "idem-video-001" };
const get = (w: ReturnType<typeof createTestWorld>, id: string, token = ALICE) => getJobById(jsonRequest(`/api/jobs/${id}`, { token, method: "GET" }), w.deps, id);

describe("GET /api/jobs/:id for a running video job", () => {
  it("collects the finished video when the job is looked at, then keeps returning the completed job", async () => {
    let reads = 0;
    const w = createTestWorld({ adapter: {
      videoModel: true,
      submit: async () => ({ status: "processing", providerJobId: "job_abc123456" }),
      status: async () => { reads++; return { status: "validating", providerJobId: "job_abc123456", outputFiles: [{ contentType: "video/mp4", data: MP4 }] }; }
    } });
    w.seedKey("alice", "fake", "k");
    const created = await postJob(jsonRequest("/api/jobs", { token: ALICE, body: { ...body, capability: "text_to_video" } }), w.deps);
    expect(created.status).toBe(202);
    const id = (await created.json()).job.id as string;
    await w.runTasks();
    expect(w.jobs.get(id)).toMatchObject({ status: "processing", providerJobId: "job_abc123456" });

    const view = (await (await get(w, id)).json()).job;
    expect(view).toMatchObject({ status: "completed", progress: 100 });
    expect(view.outputAssetIds).toHaveLength(1);
    expect(reads).toBe(1);
    expect((await (await get(w, id)).json()).job.status).toBe("completed");
    expect(reads).toBe(1);
    expect(w.calls.submit).toBe(1); // never submitted a second time
  });

  it("does not let another user trigger or see the job", async () => {
    const w = createTestWorld({ adapter: { videoModel: true, submit: async () => ({ status: "processing", providerJobId: "job_abc123456" }), status: async () => { throw new Error("must not be called"); } } });
    w.seedKey("alice", "fake", "k");
    const id = (await (await postJob(jsonRequest("/api/jobs", { token: ALICE, body: { ...body, capability: "text_to_video" } }), w.deps)).json()).job.id as string;
    await w.runTasks();
    expect((await get(w, id, BOB)).status).toBe(404);
  });
});
