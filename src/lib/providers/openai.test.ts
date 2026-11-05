import { describe, expect, it } from "vitest";
import { createOpenAIAdapter, OPENAI_IMAGE_MODEL } from "./openai";
import { ProviderError } from "./types";
import { PNG } from "@/lib/api/test-helpers";

type Call = { url: string; init: RequestInit };
function fakeFetch(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return respond({ url, init });
  }) as unknown as typeof fetch;
  return { fn, calls };
}
const b64 = Buffer.from(PNG).toString("base64");
const ok = () => Response.json({ data: [{ b64_json: b64 }] });
const req = (over: Record<string, unknown> = {}) => ({
  capability: "text_to_image" as const, modelId: OPENAI_IMAGE_MODEL, inputAssetIds: [] as string[], parameters: { prompt: "a cat", ...over }
});

describe("openai adapter", () => {
  it("validates credentials with GET /models using a bearer token", async () => {
    const { fn, calls } = fakeFetch(() => Response.json({ data: [] }));
    expect(await createOpenAIAdapter(fn).validateCredentials("sk-test")).toEqual({ valid: true });
    expect(calls[0].url).toBe("https://api.openai.com/v1/models");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
  });

  it("reports rejected keys as invalid, and throws (status unknown) on server errors or network failure", async () => {
    expect((await createOpenAIAdapter(fakeFetch(() => new Response("{}", { status: 401 })).fn).validateCredentials("x")).valid).toBe(false);
    await expect(createOpenAIAdapter(fakeFetch(() => new Response("{}", { status: 429 })).fn).validateCredentials("x")).rejects.toMatchObject({ code: "rate_limited" });
    await expect(createOpenAIAdapter(fakeFetch(() => new Response("{}", { status: 503 })).fn).validateCredentials("x")).rejects.toMatchObject({ code: "unavailable" });
    const down = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    await expect(createOpenAIAdapter(down).validateCredentials("x")).rejects.toBeInstanceOf(ProviderError);
  });

  it("estimates cost from quality and size, and flags it unverified", async () => {
    const a = createOpenAIAdapter(fakeFetch(ok).fn);
    const est = await a.estimateCost(req({ quality: "high", size: "1024x1536" }));
    expect(est).toMatchObject({ amount: 0.25, currency: "USD", isEstimate: true });
    expect(est!.notes).toMatch(/not verified/i);
    expect((await a.estimateCost(req()))!.amount).toBe(0.042);
    expect(await a.estimateCost(req({ size: "9x9" }))).toBeNull();
    expect(a.models()[0].pricingVerifiedAt).toBeUndefined();
    expect(a.models()[0].isFreeTier).toBe(false);
  });

  it("rejects unsupported parameters, models and input counts before submission", () => {
    const a = createOpenAIAdapter(fakeFetch(ok).fn);
    expect(() => a.validateRequest(req())).not.toThrow();
    expect(() => a.validateRequest(req({ prompt: "" }))).toThrow(ProviderError);
    expect(() => a.validateRequest(req({ size: "512x512" }))).toThrow(/size/);
    expect(() => a.validateRequest(req({ n: 4 }))).toThrow(ProviderError);
    expect(() => a.validateRequest({ ...req(), modelId: "dall-e-9" })).toThrow(/Unsupported/);
    expect(() => a.validateRequest({ ...req(), capability: "text_to_video" })).toThrow(/Unsupported/);
    expect(() => a.validateRequest({ ...req(), capability: "image_to_image" })).toThrow(/exactly one/);
    expect(() => a.validateRequest({ ...req(), inputAssetIds: ["x"] })).toThrow(/does not accept/);
  });

  it("generates an image with one request and returns the decoded PNG", async () => {
    const { fn, calls } = fakeFetch(ok);
    const res = await createOpenAIAdapter(fn).submitJob(req({ quality: "low" }), "idem", { secret: "sk-test", inputFiles: [] });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.openai.com/v1/images/generations");
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ model: "gpt-image-1", prompt: "a cat", size: "1024x1024", quality: "low", n: 1 });
    expect(res.outputFiles![0].contentType).toBe("image/png");
    expect(res.outputFiles![0].data).toEqual(PNG);
  });

  it("edits with multipart upload for image_to_image", async () => {
    const { fn, calls } = fakeFetch(ok);
    await createOpenAIAdapter(fn).submitJob({ ...req(), capability: "image_to_image", inputAssetIds: ["a"] }, "idem", {
      secret: "sk-test", inputFiles: [{ contentType: "image/png", data: PNG }]
    });
    expect(calls[0].url).toBe("https://api.openai.com/v1/images/edits");
    const form = calls[0].init.body as FormData;
    expect(form.get("prompt")).toBe("a cat");
    expect((form.get("image") as Blob).type).toBe("image/png");
  });

  it("maps failures to sanitized errors with the right outcome-known flag, and never retries", async () => {
    const run = async (res: Response | Error) => {
      const { fn, calls } = fakeFetch(() => { if (res instanceof Error) throw res; return res; });
      const err = await createOpenAIAdapter(fn).submitJob(req(), "i", { secret: "sk-SECRET", inputFiles: [] }).catch((e) => e);
      expect(calls).toHaveLength(1);
      return err as ProviderError;
    };
    expect(await run(new Response("{}", { status: 401 }))).toMatchObject({ code: "auth", outcomeKnown: true });
    expect(await run(new Response("{}", { status: 429 }))).toMatchObject({ code: "rate_limited", outcomeKnown: true });
    expect(await run(Response.json({ error: { code: "moderation_blocked", message: "echo prompt" } }, { status: 400 }))).toMatchObject({ code: "content_policy", outcomeKnown: true });
    expect(await run(new Response("{}", { status: 400 }))).toMatchObject({ code: "invalid_request" });
    expect(await run(new Response("boom sk-SECRET", { status: 500 }))).toMatchObject({ code: "unavailable", outcomeKnown: false });
    const timeout = await run(Object.assign(new Error("t"), { name: "TimeoutError" }));
    expect(timeout).toMatchObject({ code: "timeout", outcomeKnown: false });
    expect(timeout.message).toMatch(/billed/);
    expect(await run(Response.json({ data: [] }))).toMatchObject({ code: "unknown", outcomeKnown: false });
    for (const e of [await run(new Response("boom sk-SECRET", { status: 500 })), timeout]) expect(e.message).not.toContain("sk-SECRET");
  });
});
