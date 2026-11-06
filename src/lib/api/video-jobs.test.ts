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

describe("POST /api/jobs concurrency limits", () => {
  const make = () => {
    const w = createTestWorld({ adapter: { videoModel: true, submit: async () => ({ status: "processing", providerJobId: "job_abc123456" }) } });
    w.seedKey("alice", "fake", "k");
    let n = 0;
    const post = async (capability: string, key?: string, token = ALICE) =>
      postJob(jsonRequest("/api/jobs", { token, body: { ...body, capability, idempotencyKey: key ?? `idem-conc-${++n}` } }), w.deps);
    return { w, post };
  };

  it("1 video + 2 images are allowed, the 4th job is refused with a clear message", async () => {
    const { w, post } = make();
    expect((await post("text_to_video")).status).toBe(202);
    expect((await post("text_to_image")).status).toBe(202);
    expect((await post("text_to_image")).status).toBe(202);
    const refused = await post("text_to_image");
    expect(refused.status).toBe(429);
    expect((await refused.json()).error).toMatchObject({ code: "concurrency_limit", details: { active: { total: 3, videos: 1 } } });
    expect(w.jobs.size).toBe(3); // nothing was created for the refused one
  });

  it("2 videos + 1 image; a third video is refused even with a free slot", async () => {
    const { post } = make();
    expect((await post("text_to_video")).status).toBe(202);
    expect((await post("text_to_video")).status).toBe(202);
    expect((await post("text_to_video")).status).toBe(429);
    expect((await post("text_to_image")).status).toBe(202);
  });

  it("frees a slot when a job finishes, never blocks a repeat of an existing request, and is per user", async () => {
    const { w, post } = make();
    for (const k of ["a-key-0001", "a-key-0002", "a-key-0003"]) expect((await post("text_to_image", k)).status).toBe(202);
    expect((await post("text_to_image", "a-key-0002")).status).toBe(200); // duplicate: returns the existing job
    expect((await post("text_to_image", "a-key-0004")).status).toBe(429);
    expect((await post("text_to_image", "a-key-0005", BOB)).status).toBe(422); // Bob has no key, but is not blocked by Alice's jobs
    [...w.jobs.values()][0].status = "completed";
    expect((await post("text_to_image", "a-key-0004")).status).toBe(202);
  });
});
