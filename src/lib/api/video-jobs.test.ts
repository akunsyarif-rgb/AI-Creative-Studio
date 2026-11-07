import { describe, expect, it } from "vitest";
import { getJobById, postJob, recoverJob } from "./handlers";
import { ProviderError } from "@/lib/providers/types";
import { ALICE, BOB, MP4, PNG, createTestWorld, jsonRequest } from "./test-helpers";

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

describe("POST /api/jobs/:id/recover (a task we gave up waiting for)", () => {
  const TASK = "job_06gv7x6y157kw98njfvw41ra0w";
  const failedUnknown = (w: ReturnType<typeof createTestWorld>, over: Record<string, unknown> = {}) => {
    const job = {
      id: "jobR1", ownerId: "alice", projectId: "p1", capability: "text_to_image", providerId: "fake", modelId: "m1", status: "failed",
      inputAssetIds: [], parameters: { prompt: "x" }, idempotencyKey: "idem-recover-1", requestHash: "h", progress: null,
      errorCode: "outcome_unknown", errorMessage: `SpicyAPI did not finish task ${TASK} in time. It may still finish and be billed; check your SpicyAPI task history.`,
      outputAssetIds: [], providerJobId: null, estimatedCost: 0.014, currency: "USD", createdAt: new Date().toISOString(), ...over
    };
    w.jobs.set(job.id, job as never);
    return job.id;
  };
  const recover = (w: ReturnType<typeof createTestWorld>, id: string, token = ALICE) => recoverJob(jsonRequest(`/api/jobs/${id}/recover`, { token }), w.deps, id);

  it("reads the task id from the saved message and collects the result without creating anything at the provider", async () => {
    let asked = "";
    const w = createTestWorld({ adapter: { videoModel: true, status: async (taskId) => { asked = taskId; return { status: "validating", providerJobId: taskId, outputFiles: [{ contentType: "image/png", data: PNG }] }; } } });
    w.seedKey("alice", "fake", "k");
    const id = failedUnknown(w);
    const res = await recover(w, id);
    expect(res.status).toBe(200);
    const job = (await res.json()).job;
    expect(job).toMatchObject({ status: "completed", errorCode: null });
    expect(job.outputAssetIds).toHaveLength(1);
    expect(asked).toBe(TASK);
    expect(w.calls.submit).toBe(0);
    expect(w.jobs.get(id)).toMatchObject({ providerJobId: TASK, status: "completed" });
  });

  it("goes back to processing when the provider is still working, and fails again with a reason when it ended", async () => {
    const still = createTestWorld({ adapter: { videoModel: true, status: async (t) => ({ status: "processing", providerJobId: t }) } });
    still.seedKey("alice", "fake", "k");
    const id = failedUnknown(still, { id: "jobR6" });
    expect((await (await recover(still, id)).json()).job.status).toBe("processing");

    const ended = createTestWorld({ adapter: { videoModel: true, status: async () => { throw new ProviderError("timeout", "SpicyAPI could not finish the task (timeout). The hold is normally released.", true); } } });
    ended.seedKey("alice", "fake", "k");
    const id2 = failedUnknown(ended, { id: "jobR5" });
    expect((await (await recover(ended, id2)).json()).job).toMatchObject({ status: "failed", errorCode: "provider_timeout" });
  });

  it("only works for the owner's outcome-unknown failures that name a task", async () => {
    const w = createTestWorld({ adapter: { videoModel: true, status: async () => { throw new Error("must not be called"); } } });
    w.seedKey("alice", "fake", "k");
    expect((await recover(w, failedUnknown(w), BOB)).status).toBe(404);
    expect((await recover(w, failedUnknown(w, { id: "jobR2", errorCode: "provider_unavailable" }))).status).toBe(409);
    expect((await recover(w, failedUnknown(w, { id: "jobR3", errorMessage: "no task here" }))).status).toBe(409);
    expect((await recover(w, failedUnknown(w, { id: "jobR4", status: "completed" }))).status).toBe(409);
    expect((await recover(w, "nope-1")).status).toBe(404);
    expect((await recoverJob(jsonRequest("/api/jobs/x/recover", {}), w.deps, "jobR1")).status).toBe(401);
  });

  it("is refused for a provider that cannot report on tasks", async () => {
    const w = createTestWorld(); // the fake adapter has no getJobStatus here
    w.seedKey("alice", "fake", "k");
    expect((await recover(w, failedUnknown(w))).status).toBe(409);
    expect(w.jobs.get("jobR1")!.status).toBe("failed");
  });
});
