import { describe, expect, it } from "vitest";
import { OPENROUTER_GEMINI_FLASH_IMAGE, OPENROUTER_GPT_IMAGE_MINI, createOpenRouterAdapter } from "./openrouter";
import { ProviderError } from "../types";
import { PNG } from "@/lib/api/test-helpers";

type Call = { url: string; init: RequestInit };
function fakeFetch(respond: (c: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return respond({ url, init }); }) as unknown as typeof fetch;
  return { fn, calls };
}
const dataUrl = `data:image/png;base64,${Buffer.from(PNG).toString("base64")}`;
const ok = () => Response.json({ choices: [{ message: { content: "here", images: [{ type: "image_url", image_url: { url: dataUrl } }] } }] });
const req = (over: Record<string, unknown> = {}, modelId = OPENROUTER_GEMINI_FLASH_IMAGE) => ({
  capability: "text_to_image" as const, modelId, inputAssetIds: [] as string[], parameters: { prompt: "a cat", ...over }
});
const ctx = { secret: "or-SECRET", inputFiles: [] };

describe("openrouter adapter config", () => {
  const a = createOpenRouterAdapter(fakeFetch(ok).fn);

  it("offers at least two models including a Gemini Flash image model, none marked free or price-verified", () => {
    const ids = a.config.availableModels.map((m) => m.modelId);
    expect(ids).toContain(OPENROUTER_GEMINI_FLASH_IMAGE);
    expect(ids).toContain(OPENROUTER_GPT_IMAGE_MINI);
    expect(a.config.id).toBe("openrouter");
    for (const m of a.config.availableModels) {
      expect(m.isFreeTier).toBe(false);
      expect(m.pricingVerifiedAt).toBeUndefined();
    }
    expect(a.getCapabilities()).toEqual(["text_to_image", "image_to_image"]);
  });

  it("never returns a null estimate for a model it offers (so the cost gate always applies)", async () => {
    for (const m of a.config.availableModels) {
      const est = await a.estimateCost(req({}, m.modelId));
      expect(est).toMatchObject({ currency: "USD", isEstimate: true });
      expect(est!.amount).toBeGreaterThan(0);
    }
    expect(await a.estimateCost(req({}, "unknown/model"))).toBeNull();
  });

  it("validates models, capabilities, parameters and input counts before submission", () => {
    expect(() => a.validateRequest(req())).not.toThrow();
    expect(() => a.validateRequest(req({ aspect_ratio: "16:9" }))).not.toThrow();
    expect(() => a.validateRequest(req({ aspect_ratio: "5:4" }))).toThrow(ProviderError);
    expect(() => a.validateRequest(req({}, "unknown/model"))).toThrow(/Unsupported/);
    expect(() => a.validateRequest({ ...req(), capability: "text_to_video" })).toThrow(/Unsupported/);
    expect(() => a.validateRequest(req({ prompt: "" }))).toThrow(ProviderError);
    expect(() => a.validateRequest(req({ aspect_ratio: "1:1" }, OPENROUTER_GPT_IMAGE_MINI))).toThrow(ProviderError); // not a tunable of this model
    expect(() => a.validateRequest({ ...req(), capability: "image_to_image" })).toThrow(/exactly one/);
    expect(() => a.validateRequest({ ...req(), inputAssetIds: ["x"] })).toThrow(/does not accept/);
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
  it("requests image modality with the aspect ratio and decodes the returned data URL", async () => {
    const { fn, calls } = fakeFetch(ok);
    const res = await createOpenRouterAdapter(fn).executeJob(req({ aspect_ratio: "16:9" }), "idem", ctx);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      model: OPENROUTER_GEMINI_FLASH_IMAGE, messages: [{ role: "user", content: "a cat" }],
      modalities: ["image", "text"], image_config: { aspect_ratio: "16:9" }
    });
    expect(res.outputFiles![0]).toMatchObject({ contentType: "image/png" });
    expect(res.outputFiles![0].data).toEqual(PNG);
  });

  it("omits image_config for models without tunables", async () => {
    const { fn, calls } = fakeFetch(ok);
    await createOpenRouterAdapter(fn).executeJob(req({}, OPENROUTER_GPT_IMAGE_MINI), "i", ctx);
    expect(JSON.parse(calls[0].init.body as string)).not.toHaveProperty("image_config");
  });

  it("sends the input image inline for image_to_image", async () => {
    const { fn, calls } = fakeFetch(ok);
    await createOpenRouterAdapter(fn).executeJob({ ...req(), capability: "image_to_image", inputAssetIds: ["a"] }, "i", {
      secret: "k", inputFiles: [{ contentType: "image/png", data: PNG }]
    });
    const content = JSON.parse(calls[0].init.body as string).messages[0].content;
    expect(content[0]).toEqual({ type: "text", text: "a cat" });
    expect(content[1].image_url.url).toBe(dataUrl);
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
    expect(await run(new Response("{}", { status: 404 }))).toMatchObject({ code: "invalid_request" }); // wrong model id: safe, nothing billed
    expect(await run(new Response("boom or-SECRET", { status: 502 }))).toMatchObject({ code: "unavailable", outcomeKnown: false });
    const timeout = await run(Object.assign(new Error("t"), { name: "TimeoutError" }));
    expect(timeout).toMatchObject({ code: "timeout", outcomeKnown: false });
    expect(timeout.message).toMatch(/billed/);
    for (const e of [await run(new Response("boom or-SECRET", { status: 502 })), timeout]) expect(e.message).not.toContain("or-SECRET");
  });

  it("treats a 200 with an error body, or no image, as an unknown (possibly billed) outcome", async () => {
    const noImage = Response.json({ choices: [{ message: { content: "sorry, text only" } }] });
    const errBody = Response.json({ error: { message: "upstream failed with key or-SECRET" } });
    for (const res of [noImage, errBody]) {
      const err = (await createOpenRouterAdapter(fakeFetch(() => res).fn).executeJob(req(), "i", ctx).catch((e) => e)) as ProviderError;
      expect(err).toBeInstanceOf(ProviderError);
      expect(err.outcomeKnown).toBe(false);
      expect(err.message).not.toContain("or-SECRET");
    }
  });

  it("refuses remote image URLs and non-image data URLs instead of fetching them", async () => {
    for (const url of ["https://evil.example/x.png", "data:text/html;base64,PGh0bWw+", "data:image/svg+xml;base64,PHN2Zz4="]) {
      const { fn, calls } = fakeFetch(() => Response.json({ choices: [{ message: { images: [{ image_url: { url } }] } }] }));
      const err = (await createOpenRouterAdapter(fn).executeJob(req(), "i", ctx).catch((e) => e)) as ProviderError;
      expect(err).toMatchObject({ code: "unknown", outcomeKnown: false });
      expect(calls).toHaveLength(1);
    }
  });
});
