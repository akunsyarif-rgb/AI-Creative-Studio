import { describe, expect, it } from "vitest";
import { MAX_EDIT_INPUT_BYTES, buildEditInput, capabilitiesForModel, createSpicyApiAdapter, isSpicyBaseUrl } from "./spicyapi";
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
        return polls < 3 ? env({ state: "running" }) : env({ state: "succeeded", cost: "0.008", output: { assets: [{ url: "https://files.example.com/o.png?X-Signature=abc123&Expires=1" }] } });
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
    expect(download.url).toBe("https://files.example.com/o.png?X-Signature=abc123&Expires=1");
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

  it("shows SpicyAPI's validation text on a 400 so a wrong model id is diagnosable", async () => {
    const { adapter } = setup(() => Response.json({ code: 400, msg: "model: not found" }, { status: 400 }));
    await expect(adapter.executeJob(req(), "i", ctx)).rejects.toMatchObject({ code: "invalid_request", message: expect.stringContaining("model: not found") });
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

  it("says why a download failed without leaking the signed link", async () => {
    const { adapter } = setup((url) => {
      if (url.endsWith("/jobs/createTask")) return env({ taskId: task }, 202);
      if (url.includes("recordInfo")) return env({ state: "succeeded", output: { assets: [{ url: "https://files.example.com/o.png?X-Signature=SIGSECRET" }] } });
      return new Response("denied", { status: 403 });
    });
    const err = await adapter.executeJob(req(), "i", ctx).catch((e) => e);
    expect(err.message).toContain("HTTP 403");
    expect(err.message).not.toContain("SIGSECRET");
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

describe("SpicyAPI image edit", () => {
  const editCfg: CustomProviderConfig = { ...cfg, models: ["alibaba/z-image-turbo/text-to-image", "vendor/img-edit/edit"] };
  const schema = (props: Record<string, unknown>, required: string[] = ["prompt"]) => ({ type: "object", properties: props, required });
  const editReq = (over: Record<string, unknown> = {}) => ({ capability: "image_to_image" as const, modelId: "vendor/img-edit/edit", inputAssetIds: ["a1"], parameters: { prompt: "make it blue", ...over } });
  const editCtx = { secret: "sk-spicy-SECRET", inputFiles: [{ contentType: "image/png", data: PNG }] };

  function editSetup(modelSchema: unknown, status = 200) {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url.includes("/models/")) return env({ model: "vendor/img-edit/edit", inputSchema: modelSchema }, status);
      if (url.endsWith("/jobs/createTask")) return env({ taskId: task }, 202);
      if (url.includes("recordInfo")) return env({ state: "succeeded", output: { assets: [{ url: "https://files.example.com/o.png?sig=1" }] } });
      return new Response(PNG, { headers: { "content-type": "image/png" } });
    }) as unknown as typeof fetch;
    const clock = { t: 0 };
    return { calls, adapter: createSpicyApiAdapter(editCfg, { fetch: fetchImpl, lookup: publicDns, sleep: async (ms) => { clock.t += ms; }, now: () => clock.t }) };
  }

  it("infers capabilities from the model id suffix", () => {
    expect(capabilitiesForModel("vendor/img-edit/edit")).toEqual(["image_to_image"]);
    expect(capabilitiesForModel("alibaba/z-image-turbo/text-to-image")).toEqual(["text_to_image"]);
    expect(capabilitiesForModel("plain-name")).toEqual(["text_to_image"]);
    const a = createSpicyApiAdapter(editCfg);
    expect(a.getCapabilities().sort()).toEqual(["image_to_image", "text_to_image"]);
    expect(a.config.availableModels.map((m) => m.capabilities)).toEqual([["text_to_image"], ["image_to_image"]]);
  });

  it("validates edit requests: edit model, exactly one input image; text models take none", () => {
    const { adapter } = editSetup({});
    expect(() => adapter.validateRequest(editReq())).not.toThrow();
    expect(() => adapter.validateRequest({ ...editReq(), inputAssetIds: [] })).toThrow();
    expect(() => adapter.validateRequest({ ...editReq(), inputAssetIds: ["a", "b"] })).toThrow();
    expect(() => adapter.validateRequest({ ...editReq(), modelId: "alibaba/z-image-turbo/text-to-image" })).toThrow();
    expect(() => adapter.validateRequest({ capability: "text_to_image", modelId: "vendor/img-edit/edit", inputAssetIds: [], parameters: { prompt: "x" } })).toThrow();
  });

  it("reads the model schema first, sends the image as a data URI in the field the model declares, one createTask", async () => {
    const { adapter, calls } = editSetup(schema({ prompt: {}, image_urls: { type: "array", minItems: 1, maxItems: 3 }, seed: {} }));
    const out = await adapter.executeJob(editReq(), "idem", editCtx);
    expect(out.outputFiles?.[0].contentType).toBe("image/png");
    expect(calls[0].url).toBe("https://api.spicyapi.ai/api/v1/models/vendor/img-edit/edit");
    const create = calls.find((c) => c.url.endsWith("/jobs/createTask"))!;
    const body = JSON.parse(create.init.body as string);
    expect(body.model).toBe("vendor/img-edit/edit");
    expect(Object.keys(body.input).sort()).toEqual(["image_urls", "prompt"]);
    expect(body.input.image_urls[0]).toMatch(/^data:image\/png;base64,/);
    expect(calls.filter((c) => c.url.endsWith("/jobs/createTask"))).toHaveLength(1);
  });

  it("uses a single image_url field when that is what the model declares", () => {
    expect(buildEditInput(schema({ prompt: {}, image_url: {} }), "p", "data:x")).toEqual({ prompt: "p", image_url: "data:x" });
  });

  it("fails before anything billable when the schema cannot be satisfied", () => {
    const fails = (sch: unknown) => { try { buildEditInput(sch, "p", "data:x"); } catch (e) { return e as { code: string; outcomeKnown: boolean; message: string }; } return null; };
    expect(fails(null)).toMatchObject({ code: "invalid_request", outcomeKnown: true });
    expect(fails(schema({ prompt: {} }))?.message).toMatch(/does not accept an input image/);
    expect(fails(schema({ image_url: {} }))?.message).toMatch(/text prompt/);
    expect(fails(schema({ prompt: {}, image_urls: { type: "array", minItems: 2 } }))?.message).toMatch(/at least 2/);
    expect(fails(schema({ prompt: {}, image_url: {}, mode: {}, strength: { default: 0.5 } }, ["prompt", "image_url", "mode", "strength"]))?.message).toMatch(/mode/);
  });

  it("never sends createTask when the schema is unusable, the model lookup fails, or the image is too large", async () => {
    const unusable = editSetup(schema({ prompt: {} }));
    await expect(unusable.adapter.executeJob(editReq(), "i", editCtx)).rejects.toMatchObject({ outcomeKnown: true });
    expect(unusable.calls.some((c) => c.url.endsWith("/jobs/createTask"))).toBe(false);

    const denied = editSetup({}, 403);
    await expect(denied.adapter.executeJob(editReq(), "i", editCtx)).rejects.toMatchObject({ outcomeKnown: true });
    expect(denied.calls.some((c) => c.url.endsWith("/jobs/createTask"))).toBe(false);

    const big = editSetup(schema({ prompt: {}, image_url: {} }));
    const huge = { secret: "k", inputFiles: [{ contentType: "image/png", data: new Uint8Array(MAX_EDIT_INPUT_BYTES + 1) }] };
    await expect(big.adapter.executeJob(editReq(), "i", huge)).rejects.toMatchObject({ message: expect.stringContaining("too large"), outcomeKnown: true });
    expect(big.calls).toHaveLength(0);
  });
});
