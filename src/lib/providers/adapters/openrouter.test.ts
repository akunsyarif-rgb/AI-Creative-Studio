import { describe, expect, it } from "vitest";
import { OPENROUTER_FLUX_SCHNELL, OPENROUTER_SD3, createOpenRouterAdapter } from "./openrouter";
import { ProviderError } from "../types";
import { PNG } from "@/lib/api/test-helpers";

type Call = { url: string; init: RequestInit };
function fakeFetch(respond: (c: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return respond({ url, init }); }) as unknown as typeof fetch;
  return { fn, calls };
}
const b64 = Buffer.from(PNG).toString("base64");
const ok = () => Response.json({ data: [{ b64_json: b64, media_type: "image/png" }] });
const req = (over: Record<string, unknown> = {}, modelId = OPENROUTER_FLUX_SCHNELL) => ({
  capability: "text_to_image" as const, modelId, inputAssetIds: [] as string[], parameters: { prompt: "a cat", ...over }
});
const ctx = { secret: "or-SECRET", inputFiles: [] };

describe("openrouter adapter config", () => {
  const a = createOpenRouterAdapter(fakeFetch(ok).fn);

  it("offers FLUX schnell and Stable Diffusion 3, text-to-image only, none free or price-verified", () => {
    expect(a.config.id).toBe("openrouter");
    expect(a.config.availableModels.map((m) => m.modelId)).toEqual(["black-forest-labs/flux-schnell", "stabilityai/stable-diffusion-3"]);
    for (const m of a.config.availableModels) {
      expect(m.capabilities).toEqual(["text_to_image"]);
      expect(m.isFreeTier).toBe(false);
      expect(m.pricingVerifiedAt).toBeUndefined();
      expect(m.parameters!.map((p) => p.key)).toEqual(["size"]);
    }
    expect(a.getCapabilities()).toEqual(["text_to_image"]);
  });

  it("never returns a null estimate for an offered model (the cost gate always applies)", async () => {
    for (const m of a.config.availableModels) {
      const est = await a.estimateCost(req({}, m.modelId));
      expect(est).toMatchObject({ currency: "USD", isEstimate: true });
      expect(est!.amount).toBeGreaterThan(0);
      expect(est!.notes).toMatch(/not verified/i);
    }
    expect(await a.estimateCost(req({}, "unknown/model"))).toBeNull();
  });

  it("validates models, capabilities, parameters and rejects image inputs before submission", () => {
    expect(() => a.validateRequest(req())).not.toThrow();
    expect(() => a.validateRequest(req({ size: "1536x1024" }, OPENROUTER_SD3))).not.toThrow();
    expect(() => a.validateRequest(req({ size: "64x64" }))).toThrow(ProviderError);
    expect(() => a.validateRequest(req({ steps: 4 }))).toThrow(ProviderError);
    expect(() => a.validateRequest(req({ prompt: "" }))).toThrow(ProviderError);
    expect(() => a.validateRequest(req({}, "unknown/model"))).toThrow(/Unsupported/);
    expect(() => a.validateRequest({ ...req(), capability: "image_to_image" })).toThrow(/Unsupported/);
    expect(() => a.validateRequest({ ...req(), capability: "text_to_video" })).toThrow(/Unsupported/);
    expect(() => a.validateRequest({ ...req(), inputAssetIds: ["x"] })).toThrow(/input images/);
  });
});

describe("openrouter testKey", () => {
  it("accepts a valid key and sends it as a bearer token to the fixed base URL", async () => {
    const { fn, calls } = fakeFetch(() => Response.json({ data: {} }));
    expect(await createOpenRouterAdapter(fn).testKey("or-key")).toEqual({ valid: true });
    expect(calls[0].url).toBe("https://openrouter.ai/api/v1/auth/key");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer or-key");
  });

  it("reports rejected keys, and throws (status unknown) otherwise", async () => {
    expect((await createOpenRouterAdapter(fakeFetch(() => new Response("{}", { status: 401 })).fn).testKey("x")).valid).toBe(false);
    await expect(createOpenRouterAdapter(fakeFetch(() => new Response("{}", { status: 500 })).fn).testKey("x")).rejects.toMatchObject({ code: "unavailable" });
    const down = (async () => { throw new TypeError("x"); }) as unknown as typeof fetch;
    await expect(createOpenRouterAdapter(down).testKey("x")).rejects.toBeInstanceOf(ProviderError);
  });
});

describe("openrouter executeJob", () => {
  it("posts a standard text-to-image request and decodes the base64 image", async () => {
    const { fn, calls } = fakeFetch(ok);
    const res = await createOpenRouterAdapter(fn).executeJob(req({ size: "1024x1536" }, OPENROUTER_SD3), "idem", ctx);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://openrouter.ai/api/v1/images/generations");
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      model: "stabilityai/stable-diffusion-3", prompt: "a cat", n: 1, size: "1024x1536", response_format: "b64_json"
    });
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer or-SECRET");
    expect(res.outputFiles![0]).toMatchObject({ contentType: "image/png" });
    expect(res.outputFiles![0].data).toEqual(PNG);
  });

  it("applies the default size", async () => {
    const { fn, calls } = fakeFetch(ok);
    await createOpenRouterAdapter(fn).executeJob(req(), "i", ctx);
    expect(JSON.parse(calls[0].init.body as string).size).toBe("1024x1024");
  });

  it("trusts the real bytes over the reported media type", async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]).toString("base64");
    const { fn } = fakeFetch(() => Response.json({ data: [{ b64_json: jpeg, media_type: "image/png" }] }));
    expect((await createOpenRouterAdapter(fn).executeJob(req(), "i", ctx)).outputFiles![0].contentType).toBe("image/jpeg");
  });

  it("maps failures to sanitized errors and never retries", async () => {
    const run = async (res: Response | Error) => {
      const { fn, calls } = fakeFetch(() => { if (res instanceof Error) throw res; return res; });
      const err = await createOpenRouterAdapter(fn).executeJob(req(), "i", ctx).catch((e) => e);
      expect(calls).toHaveLength(1);
      return err as ProviderError;
    };
    expect(await run(new Response("{}", { status: 401 }))).toMatchObject({ code: "auth", outcomeKnown: true });
    expect(await run(new Response("{}", { status: 402 }))).toMatchObject({ code: "insufficient_funds", outcomeKnown: true });
    expect(await run(new Response("{}", { status: 429 }))).toMatchObject({ code: "rate_limited", outcomeKnown: true });
    expect(await run(new Response("{}", { status: 400 }))).toMatchObject({ code: "invalid_request", outcomeKnown: true });
    expect(await run(new Response("{}", { status: 404 }))).toMatchObject({ code: "invalid_request", outcomeKnown: true }); // wrong model id/path: safe, nothing billed
    expect(await run(new Response("boom or-SECRET", { status: 502 }))).toMatchObject({ code: "unavailable", outcomeKnown: false });
    const timeout = await run(Object.assign(new Error("t"), { name: "TimeoutError" }));
    expect(timeout).toMatchObject({ code: "timeout", outcomeKnown: false });
    expect(timeout.message).toMatch(/billed/);
    for (const e of [await run(new Response("boom or-SECRET", { status: 502 })), timeout]) expect(e.message).not.toContain("or-SECRET");
  });

  it("treats a 200 with an error body, or no usable image, as an unknown (possibly billed) outcome", async () => {
    const bodies = [{ error: { message: "upstream failed with key or-SECRET" } }, { data: [] }, { data: [{ b64_json: "!!not base64!!" }] }];
    for (const body of bodies) {
      const err = (await createOpenRouterAdapter(fakeFetch(() => Response.json(body)).fn).executeJob(req(), "i", ctx).catch((e) => e)) as ProviderError;
      expect(err).toBeInstanceOf(ProviderError);
      expect(err.outcomeKnown).toBe(false);
      expect(err.message).not.toContain("or-SECRET");
    }
  });

  it("never fetches remote image URLs and rejects non-image bytes", async () => {
    const { fn, calls } = fakeFetch(() => Response.json({ data: [{ url: "https://evil.example/x.png" }] }));
    expect(await createOpenRouterAdapter(fn).executeJob(req(), "i", ctx).catch((e) => e)).toMatchObject({ code: "unknown", outcomeKnown: false });
    expect(calls).toHaveLength(1);
    const html = Buffer.from("<html>hi</html>").toString("base64");
    const err = await createOpenRouterAdapter(fakeFetch(() => Response.json({ data: [{ b64_json: html, media_type: "text/html" }] })).fn).executeJob(req(), "i", ctx).catch((e) => e);
    expect(err).toMatchObject({ code: "unknown", outcomeKnown: false });
  });
});
