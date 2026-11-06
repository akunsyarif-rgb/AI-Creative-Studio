import { describe, expect, it } from "vitest";
import { createOpenAICompatibleAdapter } from "./openai-compatible";
import { ProviderError } from "../types";
import type { Lookup } from "@/lib/net/public-url";
import { PNG } from "@/lib/api/test-helpers";

const cfg = { providerId: "custom-acme", label: "Acme AI", baseUrl: "https://api.acme.example/v1", models: ["acme/draw-1", "acme/draw-2"], estimatedCostUsd: 0.05 };
const publicDns = async () => [{ address: "93.184.216.34" }];

type Call = { url: string; init: RequestInit };
function fakeFetch(respond: (c: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return respond({ url, init }); }) as unknown as typeof fetch;
  return { fn, calls };
}
const b64 = Buffer.from(PNG).toString("base64");
const ok = () => Response.json({ data: [{ b64_json: b64 }] });
const make = (f: typeof fetch, lookup: Lookup = publicDns, c = cfg) => createOpenAICompatibleAdapter(c, { fetch: f, lookup });
const req = (over: Record<string, unknown> = {}, modelId = "acme/draw-1") => ({ capability: "text_to_image" as const, modelId, inputAssetIds: [] as string[], parameters: { prompt: "a cat", ...over } });
const ctx = { secret: "sk-SECRET", inputFiles: [] };

describe("OpenAI-compatible adapter config", () => {
  const a = make(fakeFetch(ok).fn);

  it("exposes the user's name and models with a size parameter, text-to-image only", () => {
    expect(a.config).toMatchObject({ id: "custom-acme", name: "Acme AI" });
    expect(a.config.description).toContain("api.acme.example");
    expect(a.config.availableModels.map((m) => m.modelId)).toEqual(["acme/draw-1", "acme/draw-2"]);
    for (const m of a.config.availableModels) {
      expect(m.capabilities).toEqual(["text_to_image"]);
      expect(m.parameters!.map((p) => p.key)).toEqual(["size"]);
      expect(m.isFreeTier).toBe(false);
    }
  });

  it("always estimates with the user's own price, so unknown prices still need confirmation", async () => {
    expect(await a.estimateCost(req())).toMatchObject({ amount: 0.05, currency: "USD", isEstimate: true });
  });

  it("validates model, size, extra parameters and input images before any call", () => {
    expect(() => a.validateRequest(req())).not.toThrow();
    expect(() => a.validateRequest(req({ size: "1024x1536" }))).not.toThrow();
    expect(() => a.validateRequest(req({}, "other-model"))).toThrow(/Unsupported/);
    expect(() => a.validateRequest(req({ size: "9x9" }))).toThrow(ProviderError);
    expect(() => a.validateRequest(req({ steps: 4 }))).toThrow(ProviderError);
    expect(() => a.validateRequest(req({ prompt: "" }))).toThrow(ProviderError);
    expect(() => a.validateRequest({ ...req(), inputAssetIds: ["x"] })).toThrow(/input images/);
    expect(() => a.validateRequest({ ...req(), capability: "image_to_image" })).toThrow(/Unsupported/);
  });
});

describe("OpenAI-compatible testKey", () => {
  it("checks GET {base}/models with a bearer token and no redirects", async () => {
    const { fn, calls } = fakeFetch(() => Response.json({ data: [] }));
    expect(await make(fn).testKey("sk-x")).toEqual({ valid: true });
    expect(calls[0].url).toBe("https://api.acme.example/v1/models");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer sk-x");
    expect(calls[0].init.redirect).toBe("error");
  });

  it("reports rejected keys, says when a provider has no key-check endpoint, and throws otherwise", async () => {
    expect((await make(fakeFetch(() => new Response("{}", { status: 401 })).fn).testKey("x")).valid).toBe(false);
    await expect(make(fakeFetch(() => new Response("{}", { status: 404 })).fn).testKey("x")).rejects.toThrow(/no key-check endpoint/);
    await expect(make(fakeFetch(() => new Response("{}", { status: 500 })).fn).testKey("x")).rejects.toMatchObject({ code: "unavailable" });
  });
});

describe("OpenAI-compatible executeJob", () => {
  it("posts one images request (size omitted by default) and decodes b64_json", async () => {
    const { fn, calls } = fakeFetch(ok);
    const res = await make(fn).executeJob(req(), "idem", ctx);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.acme.example/v1/images/generations");
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ model: "acme/draw-1", prompt: "a cat", n: 1 });
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer sk-SECRET");
    expect(res.outputFiles![0]).toMatchObject({ contentType: "image/png" });
    expect(res.outputFiles![0].data).toEqual(PNG);
  });

  it("sends the size when one is chosen", async () => {
    const { fn, calls } = fakeFetch(ok);
    await make(fn).executeJob(req({ size: "1536x1024" }), "i", ctx);
    expect(JSON.parse(calls[0].init.body as string).size).toBe("1536x1024");
  });

  it("downloads an image URL returned by the provider (public https only) and checks the real bytes", async () => {
    const { fn, calls } = fakeFetch(({ url }) => (url.includes("images/generations") ? Response.json({ data: [{ url: "https://cdn.acme.example/out/1.png" }] }) : new Response(PNG)));
    const res = await make(fn).executeJob(req(), "i", ctx);
    expect(res.outputFiles![0].data).toEqual(PNG);
    expect(calls.map((c) => c.url)).toEqual(["https://api.acme.example/v1/images/generations", "https://cdn.acme.example/out/1.png"]);
    expect(calls[1].init.redirect).toBe("manual");
    expect((calls[1].init.headers ?? {}) as Record<string, string>).not.toHaveProperty("Authorization"); // the key is never sent to the CDN
  });

  it("refuses image URLs that point at private or non-https hosts, without fetching them", async () => {
    for (const url of ["http://cdn.acme.example/x.png", "https://169.254.169.254/latest/meta-data", "https://10.0.0.5/x.png", "https://localhost/x.png", "https://user:pw@cdn.acme.example/x.png"]) {
      const { fn, calls } = fakeFetch(() => Response.json({ data: [{ url }] }));
      const err = (await make(fn).executeJob(req(), "i", ctx).catch((e) => e)) as ProviderError;
      expect(err).toMatchObject({ code: "unknown", outcomeKnown: false });
      expect(calls).toHaveLength(1); // only the generation call
    }
  });

  it("refuses an image host that resolves to a private address", async () => {
    const dns = async (h: string) => (h === "cdn.evil.example" ? [{ address: "10.0.0.9" }] : [{ address: "93.184.216.34" }]);
    const { fn, calls } = fakeFetch(() => Response.json({ data: [{ url: "https://cdn.evil.example/x.png" }] }));
    await expect(make(fn, dns).executeJob(req(), "i", ctx)).rejects.toMatchObject({ code: "unknown", outcomeKnown: false });
    expect(calls).toHaveLength(1);
  });

  it("follows a bounded number of redirects, re-validating each hop", async () => {
    let hop = 0;
    const { fn, calls } = fakeFetch(({ url }) => {
      if (url.includes("images/generations")) return Response.json({ data: [{ url: "https://cdn.acme.example/a" }] });
      hop++;
      return hop === 1 ? new Response(null, { status: 302, headers: { location: "https://cdn2.acme.example/b" } }) : new Response(PNG);
    });
    expect((await make(fn).executeJob(req(), "i", ctx)).outputFiles![0].data).toEqual(PNG);
    expect(calls).toHaveLength(3);

    const loop = fakeFetch(({ url }) => (url.includes("images/generations") ? Response.json({ data: [{ url: "https://cdn.acme.example/a" }] }) : new Response(null, { status: 302, headers: { location: "https://cdn.acme.example/a" } })));
    await expect(make(loop.fn).executeJob(req(), "i", ctx)).rejects.toMatchObject({ code: "unknown" });
    const toPrivate = fakeFetch(({ url }) => (url.includes("images/generations") ? Response.json({ data: [{ url: "https://cdn.acme.example/a" }] }) : new Response(null, { status: 302, headers: { location: "https://169.254.169.254/x" } })));
    await expect(make(toPrivate.fn).executeJob(req(), "i", ctx)).rejects.toMatchObject({ code: "unknown" });
    expect(toPrivate.calls).toHaveLength(2); // the private hop is never requested
  });

  it("blocks a saved base URL that now points somewhere non-public (checked on every request)", async () => {
    const { fn, calls } = fakeFetch(ok);
    const dns = async () => [{ address: "127.0.0.1" }];
    await expect(make(fn, dns).executeJob(req(), "i", ctx)).rejects.toMatchObject({ code: "invalid_request", outcomeKnown: true });
    await expect(make(fn, dns).testKey("x")).rejects.toMatchObject({ code: "invalid_request" });
    expect(calls).toHaveLength(0); // the key was never sent
  });

  it("maps failures to sanitized errors, never retries, and never leaks the key", async () => {
    const run = async (res: Response | Error) => {
      const { fn, calls } = fakeFetch(() => { if (res instanceof Error) throw res; return res; });
      const err = await make(fn).executeJob(req(), "i", ctx).catch((e) => e);
      expect(calls).toHaveLength(1);
      return err as ProviderError;
    };
    expect(await run(new Response("{}", { status: 401 }))).toMatchObject({ code: "auth", outcomeKnown: true });
    expect(await run(new Response("{}", { status: 402 }))).toMatchObject({ code: "insufficient_funds", outcomeKnown: true });
    expect(await run(new Response("{}", { status: 429 }))).toMatchObject({ code: "rate_limited", outcomeKnown: true });
    expect(await run(new Response("{}", { status: 404 }))).toMatchObject({ code: "invalid_request", outcomeKnown: true });
    expect(await run(Response.json({ error: { code: "moderation_blocked" } }, { status: 400 }))).toMatchObject({ code: "content_policy" });
    const server = await run(new Response("boom sk-SECRET", { status: 502 }));
    expect(server).toMatchObject({ code: "unavailable", outcomeKnown: false });
    const timeout = await run(Object.assign(new Error("t"), { name: "TimeoutError" }));
    expect(timeout).toMatchObject({ code: "timeout", outcomeKnown: false });
    const redirected = await run(new TypeError("fetch failed (redirect)")); // redirect: "error" surfaces as a network error
    expect(redirected).toMatchObject({ code: "unavailable", outcomeKnown: false });
    for (const e of [server, timeout, redirected]) expect(e.message).not.toContain("sk-SECRET");
  });

  it("treats error bodies, empty data and non-image bytes as unknown (possibly billed) outcomes", async () => {
    const html = Buffer.from("<html>no</html>").toString("base64");
    for (const body of [{ error: { message: "x sk-SECRET" } }, { data: [] }, { data: [{ b64_json: "!!!" }] }, { data: [{ b64_json: html }] }]) {
      const err = (await make(fakeFetch(() => Response.json(body)).fn).executeJob(req(), "i", ctx).catch((e) => e)) as ProviderError;
      expect(err).toBeInstanceOf(ProviderError);
      expect(err.outcomeKnown).toBe(false);
      expect(err.message).not.toContain("sk-SECRET");
    }
  });
});
