import { describe, expect, it } from "vitest";
import { executeJob } from "./execute";
import { PNG, createTestWorld, type TestWorld } from "@/lib/api/test-helpers";
import { ProviderError } from "@/lib/providers/types";
import type { JobRecord } from "@/lib/data/repositories";

function run(w: TestWorld, overrides: Partial<JobRecord> = {}) {
  const job: JobRecord = {
    id: "job1", ownerId: "alice", projectId: "p1", capability: "text_to_image", providerId: "fake", modelId: "m1",
    status: "queued", inputAssetIds: [], parameters: { prompt: "a cat" }, idempotencyKey: "idem-0001", requestHash: "h",
    progress: null, errorCode: null, errorMessage: null, outputAssetIds: [], estimatedCost: 0.05, currency: "USD", createdAt: "t",
    ...overrides
  };
  w.jobs.set(job.id, job);
  const exec = () =>
    executeJob(
      { jobs: w.deps.jobs, assets: w.deps.assets, keys: w.deps.keys, storage: w.deps.storage, vault: w.deps.vault, resolveAdapter: async (_owner, id) => w.deps.providers.get(id) },
      job
    );
  return { job, exec, get: () => w.jobs.get(job.id)! };
}

describe("executeJob", () => {
  it("decrypts the saved key, calls the provider once with it, stores output and completes", async () => {
    let seenSecret = "";
    const w = createTestWorld({ adapter: { submit: async (_r, secret) => { seenSecret = secret; return { status: "validating", outputFiles: [{ contentType: "image/png", data: PNG }] }; } } });
    w.seedKey("alice", "fake", "alice-real-secret");
    const { exec, get } = run(w);
    await exec();
    expect(seenSecret).toBe("alice-real-secret");
    expect(w.calls.submit).toBe(1);
    expect(get().status).toBe("completed");
    expect(get().progress).toBe(100);
    const [assetId] = get().outputAssetIds;
    const asset = w.assets.get(assetId)!;
    expect(asset).toMatchObject({ ownerId: "alice", contentType: "image/png", status: "uploaded" });
    expect(w.objects.get(asset.objectKey)!.data).toEqual(PNG);
  });

  it("passes owned input files for image_to_image", async () => {
    let inputs = -1;
    const w = createTestWorld({ adapter: { submit: async (_r, _s, n) => { inputs = n; return { status: "validating", outputFiles: [{ contentType: "image/png", data: PNG }] }; } } });
    w.seedKey("alice", "fake", "k");
    const src = w.seedAsset({ id: "in1", ownerId: "alice" });
    w.objects.set(src.objectKey, { data: PNG, contentType: "image/png" });
    const { exec, get } = run(w, { capability: "image_to_image", inputAssetIds: ["in1"] });
    await exec();
    expect(inputs).toBe(1);
    expect(get().status).toBe("completed");
  });

  it("fails without calling the provider when no key is saved", async () => {
    const w = createTestWorld();
    const { exec, get } = run(w);
    await exec();
    expect(w.calls.submit).toBe(0);
    expect(get()).toMatchObject({ status: "failed", errorCode: "provider_key_missing" });
  });

  it("never reads another user's input asset", async () => {
    const w = createTestWorld();
    w.seedKey("alice", "fake", "k");
    w.seedAsset({ id: "bobs", ownerId: "bob" });
    const { exec, get } = run(w, { capability: "image_to_image", inputAssetIds: ["bobs"] });
    await exec();
    expect(w.calls.submit).toBe(0);
    expect(get()).toMatchObject({ status: "failed", errorCode: "invalid_input_assets" });
  });

  it("does not use another user's key (ciphertext is bound to its owner)", async () => {
    const w = createTestWorld();
    w.seedKey("bob", "fake", "bobs-secret");
    w.keys.set("alice/fake", w.keys.get("bob/fake")!); // ciphertext copied across rows
    const { exec, get } = run(w);
    await exec();
    expect(w.calls.submit).toBe(0);
    expect(get()).toMatchObject({ status: "failed", errorCode: "credential_error" });
  });

  it("does not retry and flags an unknown outcome after a timeout", async () => {
    const w = createTestWorld({ adapter: { submit: async () => { throw new ProviderError("timeout", "timed out", false); } } });
    w.seedKey("alice", "fake", "k");
    const { exec, get } = run(w);
    await exec();
    expect(w.calls.submit).toBe(1);
    expect(get()).toMatchObject({ status: "failed", errorCode: "outcome_unknown" });
    expect(get().errorMessage).toMatch(/may have been billed/);
    expect(get().errorMessage).toMatch(/not retried/);
  });

  it("reports known provider failures without the billing warning", async () => {
    const w = createTestWorld({ adapter: { submit: async () => { throw new ProviderError("auth", "The provider rejected the API key.", true); } } });
    w.seedKey("alice", "fake", "k");
    const { exec, get } = run(w);
    await exec();
    expect(get()).toMatchObject({ status: "failed", errorCode: "provider_auth" });
    expect(get().errorMessage).not.toMatch(/billed/);
  });

  it("marks unexpected provider exceptions as unknown outcome and never leaks the message", async () => {
    const w = createTestWorld({ adapter: { submit: async () => { throw new Error("secret sk-123 leaked"); } } });
    w.seedKey("alice", "fake", "k");
    const { exec, get } = run(w);
    await exec();
    expect(get().status).toBe("failed");
    expect(JSON.stringify(get())).not.toContain("sk-123");
  });

  it("does not complete when the provider output is not a real image", async () => {
    const html = new TextEncoder().encode("<html>not an image</html>");
    const w = createTestWorld({ adapter: { submit: async () => ({ status: "validating", outputFiles: [{ contentType: "image/png", data: html }] }) } });
    w.seedKey("alice", "fake", "k");
    const { exec, get } = run(w);
    await exec();
    expect(get()).toMatchObject({ status: "failed", errorCode: "invalid_output" });
    expect(w.objects.size).toBe(0);
    expect(w.assets.size).toBe(0);
  });

  it("does not complete when the provider returns no output", async () => {
    const w = createTestWorld({ adapter: { submit: async () => ({ status: "validating", outputFiles: [] }) } });
    w.seedKey("alice", "fake", "k");
    const { exec, get } = run(w);
    await exec();
    expect(get()).toMatchObject({ status: "failed", errorCode: "invalid_output" });
  });

  it("flags storage failure after a billed call", async () => {
    const w = createTestWorld();
    w.seedKey("alice", "fake", "k");
    w.deps.storage.putObject = async () => { throw new Error("r2 down"); };
    const { exec, get } = run(w);
    await exec();
    expect(get()).toMatchObject({ status: "failed", errorCode: "internal_error" });
    expect(get().errorMessage).toMatch(/may have been billed/);
  });
});
