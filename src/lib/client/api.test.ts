import { describe, expect, it } from "vitest";
import { ApiError, createApiClient, pollJob, uploadAsset, type JobView } from "./api";

const jsonRes = (body: unknown, status = 200) => Response.json(body, { status });

describe("api client", () => {
  it("sends the bearer token and JSON body, and returns parsed JSON", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const api = createApiClient(async () => "jwt-1", (async (url: string, init: RequestInit) => { seen = { url, init }; return jsonRes({ ok: 1 }); }) as unknown as typeof fetch);
    expect(await api.post("/api/x", { a: 1 })).toEqual({ ok: 1 });
    expect((seen!.init.headers as Record<string, string>).Authorization).toBe("Bearer jwt-1");
    expect(seen!.init.body).toBe('{"a":1}');
  });

  it("surfaces structured API errors, and network failures", async () => {
    const api = createApiClient(async () => "t", (async () => jsonRes({ error: { code: "cost_confirmation_required", message: "Confirm", details: { estimate: { amount: 0.04 } } } }, 409)) as unknown as typeof fetch);
    const err = await api.post("/api/jobs").catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 409, code: "cost_confirmation_required", details: { estimate: { amount: 0.04 } } });
    const down = createApiClient(async () => "t", (async () => { throw new TypeError("x"); }) as unknown as typeof fetch);
    expect(await down.get("/x").catch((e) => e)).toMatchObject({ code: "network_error" });
  });
});

describe("uploadAsset", () => {
  const file = new File([new Uint8Array(10)], "cat.png", { type: "image/png" });

  it("presigns, PUTs to storage with the signed headers, then confirms", async () => {
    const calls: string[] = [];
    const api = createApiClient(async () => "t", (async (url: string) => {
      calls.push(url);
      return url.endsWith("presign") ? jsonRes({ assetId: "a1", uploadUrl: "https://r2.example/put", method: "PUT", headers: { "Content-Type": "image/png" } }, 201) : jsonRes({ asset: {} });
    }) as unknown as typeof fetch);
    let put: { url: string; init: RequestInit } | undefined;
    const id = await uploadAsset(api, file, (async (url: string, init: RequestInit) => { put = { url, init }; return new Response(null, { status: 200 }); }) as unknown as typeof fetch);
    expect(id).toBe("a1");
    expect(put!.url).toBe("https://r2.example/put");
    expect(put!.init.method).toBe("PUT");
    expect(calls).toEqual(["/api/uploads/presign", "/api/uploads/a1/confirm"]);
  });

  it("does not confirm when the storage upload fails", async () => {
    const calls: string[] = [];
    const api = createApiClient(async () => "t", (async (url: string) => { calls.push(url); return jsonRes({ assetId: "a1", uploadUrl: "https://r2/x", method: "PUT", headers: {} }); }) as unknown as typeof fetch);
    await expect(uploadAsset(api, file, (async () => new Response(null, { status: 403 })) as unknown as typeof fetch)).rejects.toMatchObject({ code: "upload_failed" });
    expect(calls).toEqual(["/api/uploads/presign"]);
  });
});

describe("pollJob", () => {
  const job = (status: JobView["status"]): JobView => ({ id: "j", status, progress: null, errorCode: null, errorMessage: null, outputAssetIds: [], estimatedCost: null });

  it("polls until a terminal state without re-submitting anything", async () => {
    const seq = ["queued", "submitted", "completed"] as const;
    let i = 0;
    const seen: string[] = [];
    const api = createApiClient(async () => "t", (async () => jsonRes({ job: job(seq[i++]) })) as unknown as typeof fetch);
    const final = await pollJob(api, "j", (j) => seen.push(j.status), { sleep: async () => undefined });
    expect(final.status).toBe("completed");
    expect(seen).toEqual(["queued", "submitted", "completed"]);
  });

  it("stops with a clear error on timeout", async () => {
    const api = createApiClient(async () => "t", (async () => jsonRes({ job: job("submitted") })) as unknown as typeof fetch);
    await expect(pollJob(api, "j", () => undefined, { timeoutMs: -1, sleep: async () => undefined })).rejects.toMatchObject({ code: "poll_timeout" });
  });
});
