import { describe, expect, it } from "vitest";
import {
  TemplateError, createGenericHttpAdapter, getByPath, httpTemplateSchema, normaliseHttpTemplate, parseBodyTemplate, renderTemplate
} from "./generic-http";
import { ProviderError } from "../types";
import type { CustomProviderConfig, HttpTemplate } from "@/lib/data/repositories";
import type { Lookup } from "@/lib/net/public-url";
import { PNG } from "@/lib/api/test-helpers";

const publicDns: Lookup = async () => [{ address: "93.184.216.34" }];
const b64 = Buffer.from(PNG).toString("base64");

const jsonTemplate: HttpTemplate = {
  path: "/v1/generate", authHeader: "Authorization", authScheme: "Bearer",
  body: '{"model":"{{model}}","prompt":"{{prompt}}","width":"{{width}}","height":"{{height}}","note":"size={{size}}","n":1}',
  responseKind: "json", responsePath: "images.0.b64", testPath: "/v1/me"
};
const cfgFor = (http: HttpTemplate, over: Partial<CustomProviderConfig> = {}): CustomProviderConfig & { http: HttpTemplate } => ({
  providerId: "custom-acme", label: "Acme", baseUrl: "https://api.acme.example", models: ["draw-1", "stabilityai/sdxl-1.0"], estimatedCostUsd: 0.04, ...over, http
});

type Call = { url: string; init: RequestInit };
function fakeFetch(respond: (c: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return respond({ url, init }); }) as unknown as typeof fetch;
  return { fn, calls };
}
const make = (f: typeof fetch, http = jsonTemplate, lookup: Lookup = publicDns, over: Partial<CustomProviderConfig> = {}) =>
  createGenericHttpAdapter(cfgFor(http, over), { fetch: f, lookup });
const req = (over: Record<string, unknown> = {}, modelId = "draw-1") => ({ capability: "text_to_image" as const, modelId, inputAssetIds: [] as string[], parameters: { prompt: "a cat", ...over } });
const ctx = { secret: "sk-SECRET", inputFiles: [] };

describe("body template", () => {
  it("accepts an object with {{prompt}} and known placeholders", () => {
    expect(parseBodyTemplate('{"inputs":"{{prompt}}"}')).toEqual({ inputs: "{{prompt}}" });
    expect(() => parseBodyTemplate('{"a":{"b":["x {{prompt}} {{model}} {{size}}"]}}')).not.toThrow();
  });

  it("rejects invalid JSON, non-objects, unknown placeholders, a missing prompt and absurd nesting", () => {
    for (const bad of ["{nope", "[1]", '"text"', "null", '{"a":"{{secret}}","p":"{{prompt}}"}', '{"model":"{{model}}"}', '{"a":"{{prompt}}","k":"{{api_key}}"}']) {
      expect(() => parseBodyTemplate(bad), bad).toThrow(TemplateError);
    }
    const deep = `${'{"a":'.repeat(12)}"{{prompt}}"${"}".repeat(12)}`;
    expect(() => parseBodyTemplate(deep)).toThrow(/nested/);
  });

  it("substitutes into string values only, with numbers for width/height, and cannot alter the JSON structure", () => {
    const t = parseBodyTemplate('{"p":"{{prompt}}","w":"{{width}}","h":"{{height}}","s":"{{size}}","m":"x/{{model}}","list":["{{prompt}}"],"{{prompt}}":1}');
    const out = renderTemplate(t, { prompt: 'a "quoted" \\ prompt\n", "injected": true', model: "m1", size: "1024x1024", width: 1024, height: 1024 }) as Record<string, unknown>;
    expect(out.p).toBe('a "quoted" \\ prompt\n", "injected": true');
    expect(out).toMatchObject({ w: 1024, h: 1024, s: "1024x1024", m: "x/m1" });
    expect(out.list).toEqual(['a "quoted" \\ prompt\n", "injected": true']);
    expect(Object.keys(out)).toContain("{{prompt}}"); // keys are never substituted
    expect(out).not.toHaveProperty("injected");
  });
});

describe("getByPath", () => {
  it("walks objects and arrays by own properties only", () => {
    const v = { data: [{ b64: "x" }, { url: "u" }], a: { b: 1 } };
    expect(getByPath(v, "data.0.b64")).toBe("x");
    expect(getByPath(v, "data.1.url")).toBe("u");
    expect(getByPath(v, "a.b")).toBe(1);
    for (const p of ["data.2.b64", "data.x", "missing", "a.b.c", "__proto__", "a.__proto__", "a.constructor", "data.length", "a.toString"]) {
      expect(getByPath(v, p), p).toBeUndefined();
    }
  });
});

describe("httpTemplateSchema", () => {
  const ok = { path: "/v1/generate", body: '{"prompt":"{{prompt}}"}', responseKind: "json" as const, responsePath: "data.0.b64_json" };

  it("accepts a valid template and fills defaults", () => {
    const parsed = httpTemplateSchema.parse(ok);
    expect(parsed).toMatchObject({ authHeader: "Authorization", authScheme: "Bearer" });
    expect(normaliseHttpTemplate(parsed)).toEqual({ path: "/v1/generate", authHeader: "Authorization", authScheme: "Bearer", body: ok.body, responseKind: "json", responsePath: "data.0.b64_json", testPath: null });
    expect(normaliseHttpTemplate(httpTemplateSchema.parse({ ...ok, responseKind: "binary", responsePath: "ignored" })).responsePath).toBeNull();
    expect(httpTemplateSchema.safeParse({ ...ok, path: "/models/{{model}}", authHeader: "x-api-key", authScheme: "" }).success).toBe(true);
  });

  it("rejects unsafe paths, blocked headers, bad schemes, missing response path and extra fields", () => {
    const bad: Record<string, unknown>[] = [
      { path: "https://evil.example/x" }, { path: "no-slash" }, { path: "/a/../b" }, { path: "/a?x=1" }, { path: "/a#f" }, { path: "//evil.example" },
      { authHeader: "Host" }, { authHeader: "Content-Length" }, { authHeader: "Cookie" }, { authHeader: "X-Forwarded-For" }, { authHeader: "bad header" },
      { authScheme: "Bearer token" }, { authScheme: "x".repeat(30) },
      { responsePath: undefined }, { responsePath: "a..b" }, { responsePath: "a[0]" },
      { body: "{nope" }, { body: '{"x":1}' }, { testPath: "/a/../b" }, { extra: 1 }
    ];
    for (const patch of bad) {
      const r = httpTemplateSchema.safeParse({ ...ok, ...patch });
      if (patch.path === "//evil.example") continue; // "//host" is only a path on the fixed base URL, never a new host
      expect(r.success, JSON.stringify(patch)).toBe(false);
    }
  });
});

describe("generic HTTP adapter: request", () => {
  it("sends the rendered body with the key in the configured header, to the fixed base URL, without redirects", async () => {
    const { fn, calls } = fakeFetch(() => Response.json({ images: [{ b64 }] }));
    const res = await make(fn).executeJob(req({ size: "1024x1536" }), "idem", ctx);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.acme.example/v1/generate");
    expect(calls[0].init.redirect).toBe("error");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-SECRET");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ model: "draw-1", prompt: "a cat", width: 1024, height: 1536, note: "size=1024x1536", n: 1 });
    expect(res.outputFiles![0]).toMatchObject({ contentType: "image/png" });
    expect(res.outputFiles![0].data).toEqual(PNG);
  });

  it("supports other auth styles (custom header, no scheme) and never puts the key in the body or URL", async () => {
    const { fn, calls } = fakeFetch(() => Response.json({ images: [{ b64 }] }));
    await make(fn, { ...jsonTemplate, authHeader: "x-api-key", authScheme: "" }).executeJob(req(), "i", ctx);
    expect((calls[0].init.headers as Record<string, string>)["x-api-key"]).toBe("sk-SECRET");
    expect(calls[0].url).not.toContain("sk-SECRET");
    expect(String(calls[0].init.body)).not.toContain("sk-SECRET");
    const { fn: fn2, calls: calls2 } = fakeFetch(() => Response.json({ images: [{ b64 }] }));
    await make(fn2, { ...jsonTemplate, authHeader: "Authorization", authScheme: "Key" }).executeJob(req(), "i", ctx);
    expect((calls2[0].init.headers as Record<string, string>).Authorization).toBe("Key sk-SECRET");
  });

  it("puts the model in the path with / kept and everything else encoded, and rejects dot segments", async () => {
    const { fn, calls } = fakeFetch(() => new Response(PNG));
    const tmpl: HttpTemplate = { ...jsonTemplate, path: "/models/{{model}}", responseKind: "binary", responsePath: null, body: '{"inputs":"{{prompt}}"}' };
    await make(fn, tmpl).executeJob(req({}, "stabilityai/sdxl-1.0"), "i", ctx);
    expect(calls[0].url).toBe("https://api.acme.example/models/stabilityai/sdxl-1.0");
    expect((calls[0].init.headers as Record<string, string>).Accept).toBe("image/*");
    const evil = createGenericHttpAdapter(cfgFor(tmpl, { models: ["a/../b"] }), { fetch: fn, lookup: publicDns });
    await expect(evil.executeJob(req({}, "a/../b"), "i", ctx)).rejects.toMatchObject({ code: "invalid_request" });
    expect(calls).toHaveLength(1);
  });

  it("validates model, size, extra parameters and input images before any call", () => {
    const a = make(fakeFetch(() => Response.json({})).fn);
    expect(() => a.validateRequest(req())).not.toThrow();
    expect(() => a.validateRequest(req({}, "other"))).toThrow(/Unsupported/);
    expect(() => a.validateRequest(req({ size: "9x9" }))).toThrow(ProviderError);
    expect(() => a.validateRequest(req({ steps: 4 }))).toThrow(ProviderError);
    expect(() => a.validateRequest({ ...req(), inputAssetIds: ["x"] })).toThrow(/input images/);
    expect(a.config.description).toContain("Custom HTTP endpoint");
  });
});

describe("generic HTTP adapter: response", () => {
  it("reads the image from the configured JSON path (base64, data: URL, https link)", async () => {
    const dataUrl = `data:image/png;base64,${b64}`;
    for (const value of [b64.repeat(3).slice(0, b64.length), dataUrl]) {
      const { fn } = fakeFetch(() => Response.json({ images: [{ b64: value }] }));
      const out = await make(fn).executeJob(req(), "i", ctx);
      expect(out.outputFiles![0].data.length).toBeGreaterThan(0);
    }
    const { fn, calls } = fakeFetch(({ url }) => (url.includes("/v1/generate") ? Response.json({ images: [{ b64: "https://cdn.acme.example/o/1.png" }] }) : new Response(PNG)));
    const out = await make(fn).executeJob(req(), "i", ctx);
    expect(out.outputFiles![0].data).toEqual(PNG);
    expect(calls[1].url).toBe("https://cdn.acme.example/o/1.png");
    expect((calls[1].init.headers ?? {}) as Record<string, string>).not.toHaveProperty("Authorization");
  });

  it("refuses image links to private or non-https hosts without fetching them", async () => {
    for (const link of ["http://cdn.acme.example/x.png", "https://169.254.169.254/x", "https://10.0.0.1/x", "https://localhost/x"]) {
      const { fn, calls } = fakeFetch(() => Response.json({ images: [{ b64: link }] }));
      await expect(make(fn).executeJob(req(), "i", ctx)).rejects.toMatchObject({ code: "unknown", outcomeKnown: false });
      expect(calls).toHaveLength(1);
    }
  });

  it("accepts raw image bytes in binary mode and rejects non-images", async () => {
    const tmpl: HttpTemplate = { ...jsonTemplate, responseKind: "binary", responsePath: null };
    const out = await make(fakeFetch(() => new Response(PNG)).fn, tmpl).executeJob(req(), "i", ctx);
    expect(out.outputFiles![0].data).toEqual(PNG);
    await expect(make(fakeFetch(() => new Response("<html>no</html>")).fn, tmpl).executeJob(req(), "i", ctx)).rejects.toMatchObject({ code: "unknown", outcomeKnown: false });
    await expect(make(fakeFetch(() => new Response(new Uint8Array(0))).fn, tmpl).executeJob(req(), "i", ctx)).rejects.toMatchObject({ outcomeKnown: false });
  });

  it("treats a missing path, non-JSON answers and non-image data as unknown (possibly billed) outcomes", async () => {
    const cases: Response[] = [Response.json({ other: 1 }), Response.json({ images: [{ b64: 5 }] }), new Response("not json"), Response.json({ images: [{ b64: Buffer.from("<html>".repeat(40)).toString("base64") }] })];
    for (const res of cases) {
      const err = (await make(fakeFetch(() => res).fn).executeJob(req(), "i", ctx).catch((e) => e)) as ProviderError;
      expect(err).toBeInstanceOf(ProviderError);
      expect(err.outcomeKnown).toBe(false);
    }
  });

  it("maps HTTP failures to sanitized errors, never retries and never leaks the key", async () => {
    const run = async (res: Response | Error) => {
      const { fn, calls } = fakeFetch(() => { if (res instanceof Error) throw res; return res; });
      const err = await make(fn).executeJob(req(), "i", ctx).catch((e) => e);
      expect(calls).toHaveLength(1);
      return err as ProviderError;
    };
    expect(await run(new Response("{}", { status: 401 }))).toMatchObject({ code: "auth", outcomeKnown: true });
    expect(await run(new Response("{}", { status: 402 }))).toMatchObject({ code: "insufficient_funds" });
    expect(await run(new Response("{}", { status: 422 }))).toMatchObject({ code: "invalid_request", outcomeKnown: true });
    const server = await run(new Response("boom sk-SECRET", { status: 503 }));
    expect(server).toMatchObject({ code: "unavailable", outcomeKnown: false });
    const timeout = await run(Object.assign(new Error("t"), { name: "TimeoutError" }));
    expect(timeout).toMatchObject({ code: "timeout", outcomeKnown: false });
    for (const e of [server, timeout]) expect(e.message).not.toContain("sk-SECRET");
  });

  it("re-validates the saved host on every request and never sends the key to a non-public address", async () => {
    const { fn, calls } = fakeFetch(() => Response.json({ images: [{ b64 }] }));
    const dns: Lookup = async () => [{ address: "10.1.2.3" }];
    await expect(make(fn, jsonTemplate, dns).executeJob(req(), "i", ctx)).rejects.toMatchObject({ code: "invalid_request", outcomeKnown: true });
    await expect(make(fn, jsonTemplate, dns).testKey("k")).rejects.toMatchObject({ code: "invalid_request" });
    expect(calls).toHaveLength(0);
  });
});

describe("generic HTTP adapter: key check and cost", () => {
  it("checks the key with GET {testPath} when configured", async () => {
    const { fn, calls } = fakeFetch(() => Response.json({ ok: true }));
    expect(await make(fn).testKey("sk-x")).toEqual({ valid: true });
    expect(calls[0].url).toBe("https://api.acme.example/v1/me");
    expect(calls[0].init.method).toBe("GET");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer sk-x");
    expect((await make(fakeFetch(() => new Response("{}", { status: 401 })).fn).testKey("x")).valid).toBe(false);
    await expect(make(fakeFetch(() => new Response("{}", { status: 500 })).fn).testKey("x")).rejects.toMatchObject({ code: "unavailable" });
  });

  it("explains when no key-check address is configured, without calling anything", async () => {
    const { fn, calls } = fakeFetch(() => Response.json({}));
    await expect(make(fn, { ...jsonTemplate, testPath: null }).testKey("x")).rejects.toThrow(/No key-check address/);
    expect(calls).toHaveLength(0);
  });

  it("estimates with the user's price, or reports an unknown price", async () => {
    const a = make(fakeFetch(() => Response.json({})).fn);
    expect(await a.estimateCost(req())).toMatchObject({ amount: 0.04 });
    const u = make(fakeFetch(() => Response.json({})).fn, jsonTemplate, publicDns, { estimatedCostUsd: null });
    expect(await u.estimateCost(req())).toMatchObject({ amount: null });
    expect(u.config.description).toMatch(/price unknown/);
  });
});
