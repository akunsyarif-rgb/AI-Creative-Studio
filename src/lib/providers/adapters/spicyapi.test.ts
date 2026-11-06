import { describe, expect, it } from "vitest";
import { createSpicyApiAdapter, isSpicyBaseUrl } from "./spicyapi";
import { buildCustomAdapter } from "../custom";
import type { CustomProviderConfig } from "@/lib/data/repositories";
import type { Lookup } from "@/lib/net/public-url";
import { PNG } from "@/lib/api/test-helpers";

const publicDns: Lookup = async () => [{ address: "93.184.216.34" }];
const cfg: CustomProviderConfig = { providerId: "custom-spicy", label: "Spicy", baseUrl: "https://api.spicyapi.ai/api/v1", models: ["vendor/img-1"], estimatedCostUsd: null };
const ctx = { secret: "sk-spicy-SECRET", inputFiles: [] };
const req = (over: Record<string, unknown> = {}) => ({ capability: "text_to_image" as const, modelId: "vendor/img-1", inputAssetIds: [] as string[], parameters: { prompt: "a fox", ...over } });
const task = "job_01k3m8x9q2z4v7n5p6r8s0t1w3";
const env = (data: unknown, status = 200) => Response.json({ code: status, msg: "x", data }, { status });

function setup(handler: (url: string, init: RequestInit) => Response | Promise<Response>, clock = { t: 0 }) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return handler(url, init); }) as unknown as typeof fetch;
  const adapter = createSpicyApiAdapter(cfg, { fetch: fetchImpl, lookup: publicDns, sleep: async (ms) => { clock.t += ms; }, now: () => clock.t });
  return { adapter, calls };
}

describe("SpicyAPI native adapter", () => {
  it("recognises only its own https API host", () => {
    expect(isSpicyBaseUrl("https://api.spicyapi.ai/api/v1")).toBe(true);
    expect(isSpicyBaseUrl("https://api.spicyapi.ai")).toBe(true);
    for (const u of ["http://api.spicyapi.ai", "https://api.spicyapi.com/v1", "https://evil.example/api.spicyapi.ai", "https://api.spicyapi.ai.evil.example", "nope"]) {
      expect(isSpicyBaseUrl(u), u).toBe(false);
    }
    expect(buildCustomAdapter(cfg).config.description).toContain("native task API");
    expect(buildCustomAdapter({ ...cfg, baseUrl: "https://api.other.example/v1" }).config.description).not.toContain("native task API");
  });

  it("creates one task, polls until it succeeds, downloads the signed link without the key and returns the image", async () => {
    let polls = 0;
    const { adapter, calls } = setup((url) => {
      if (url.endsWith("/jobs/createTask")) return env({ taskId: task, state: "queued", estimatedCost: "0.008" }, 202);
      if (url.includes("/jobs/recordInfo")) {
        polls += 1;
        return polls < 3 ? env({ state: "running" }) : env({ state: "succeeded", cost: "0.008", output: { assets: [{ url: "https://files.example.com/o.png" }] } });
      }
      return new Response(PNG, { headers: { "content-type": "image/png" } });
    });
    const out = await adapter.executeJob(req(), "idem-1", ctx);
    expect(out).toMatchObject({ providerJobId: task, status: "validating", outputFiles: [{ contentType: "image/png" }], estimatedCost: { amount: 0.008 } });

    const create = calls[0];
    expect(create.url).toBe("https://api.spicyapi.ai/api/v1/jobs/createTask");
    expect((create.init.headers as Record<string, string>).Authorization).toBe("Bearer sk-spicy-SECRET");
    expect((create.init.headers as Record<string, string>)["Idempotency-Key"]).toMatch(/^[0-9a-f]{48}$/);
    expect(JSON.parse(create.init.body as string)).toEqual({ model: "vendor/img-1", input: { prompt: "a fox" } });
    expect(calls.filter((c) => c.url.endsWith("/jobs/createTask"))).toHaveLength(1);
    expect(calls[1].url).toBe(`https://api.spicyapi.ai/api/v1/jobs/recordInfo?taskId=${task}`);
    const download = calls[calls.length - 1];
    expect(download.url).toBe("https://files.example.com/o.png");
    expect(JSON.stringify(download.init.headers ?? {})).not.toContain("SECRET");
  });

  it("maps createTask errors to known outcomes (nothing held) and never retries", async () => {
    const cases: [number, number, string][] = [[401, 401, "auth"], [402, 40201, "insufficient_funds"], [402, 40202, "insufficient_funds"], [403, 40301, "invalid_request"], [400, 400, "invalid_request"], [429, 429, "rate_limited"], [503, 50301, "unavailable"], [409, 40901, "invalid_request"]];
    for (const [status, code, expected] of cases) {
      const { adapter, calls } = setup(() => Response.json({ code, msg: "no" }, { status }));
      await expect(adapter.executeJob(req(), "i", ctx), String(code)).rejects.toMatchObject({ code: expected, outcomeKnown: true });
      expect(calls).toHaveLength(1);
    }
  });

  it("treats a lost createTask response as unknown outcome and does not resend", async () => {
    const { adapter, calls } = setup(() => { throw new Error("socket hang up"); });
    await expect(adapter.executeJob(req(), "i", ctx)).rejects.toMatchObject({ outcomeKnown: false });
    expect(calls).toHaveLength(1);
  });

  it("reports failed, refused and expired tasks", async () => {
    const run = async (final: unknown) => {
      const { adapter } = setup((url) => (url.endsWith("/jobs/createTask") ? env({ taskId: task, state: "queued" }, 202) : env(final)));
      return adapter.executeJob(req(), "i", ctx);
    };
    await expect(run({ state: "failed", errorCode: "upstream_failed" })).rejects.toMatchObject({ code: "unavailable", outcomeKnown: true });
    await expect(run({ state: "failed", errorCode: "content_rejected" })).rejects.toMatchObject({ code: "content_policy", outcomeKnown: false });
    await expect(run({ state: "expired", errorCode: "timeout" })).rejects.toMatchObject({ code: "timeout", outcomeKnown: true });
    await expect(run({ state: "succeeded", output: { assets: [] } })).rejects.toMatchObject({ code: "unknown", outcomeKnown: false });
  });

  it("stops waiting after the budget, keeps the task id in the message and never creates a second task", async () => {
    const { adapter, calls } = setup((url) => (url.endsWith("/jobs/createTask") ? env({ taskId: task, state: "queued" }, 202) : env({ state: "running" })));
    await expect(adapter.executeJob(req(), "i", ctx)).rejects.toMatchObject({ code: "timeout", outcomeKnown: false, message: expect.stringContaining(task) });
    expect(calls.filter((c) => c.url.endsWith("/jobs/createTask"))).toHaveLength(1);
  });

  it("rejects a malformed task id and non-image downloads", async () => {
    const bad = setup(() => env({ taskId: "../etc", state: "queued" }, 202));
    await expect(bad.adapter.executeJob(req(), "i", ctx)).rejects.toMatchObject({ code: "unknown", outcomeKnown: false });
    const html = setup((url) => {
      if (url.endsWith("/jobs/createTask")) return env({ taskId: task }, 202);
      if (url.includes("recordInfo")) return env({ state: "succeeded", output: { assets: [{ url: "https://files.example.com/x" }] } });
      return new Response("<html></html>", { headers: { "content-type": "text/html" } });
    });
    await expect(html.adapter.executeJob(req(), "i", ctx)).rejects.toMatchObject({ code: "unknown" });
  });

  it("validates requests: listed model, prompt only, no input images", () => {
    const { adapter } = setup(() => env({}));
    expect(() => adapter.validateRequest(req())).not.toThrow();
    expect(() => adapter.validateRequest({ ...req(), modelId: "other" })).toThrow();
    expect(() => adapter.validateRequest(req({ size: "1024x1024" }))).toThrow();
    expect(() => adapter.validateRequest({ ...req(), inputAssetIds: ["a"] })).toThrow();
    expect(() => adapter.validateRequest(req({ prompt: "" }))).toThrow();
  });

  it("asks for price-unknown consent and tests the key against the free catalog", async () => {
    const { adapter, calls } = setup((url, init) => ((init.headers as Record<string, string>).Authorization.endsWith("good") ? env({ items: [] }) : Response.json({}, { status: 401 })));
    expect((await adapter.estimateCost(req()))?.amount).toBeNull();
    expect(await adapter.testKey("good")).toEqual({ valid: true });
    expect(await adapter.testKey("bad")).toMatchObject({ valid: false });
    expect(calls[0].url).toBe("https://api.spicyapi.ai/api/v1/models?modality=image");
  });
});
