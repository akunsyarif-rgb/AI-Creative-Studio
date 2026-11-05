import { describe, expect, it } from "vitest";
import { ProviderRegistry, createProviderRegistry } from "./registry";
import { providerRegistry } from "./index";
import { createTemplateAdapter } from "./adapters/_template";
import type { ProviderAdapter, ProviderConfig } from "./types";
import { fakeAdapter } from "@/lib/api/test-helpers";

const withConfig = (patch: Partial<ProviderConfig>): ProviderAdapter => {
  const a = fakeAdapter().adapter;
  return { ...a, config: { ...a.config, ...patch } };
};

describe("ProviderRegistry", () => {
  it("registers, lists and retrieves adapters by id", () => {
    const r = new ProviderRegistry();
    const fake = fakeAdapter().adapter;
    expect(r.register(fake)).toBe(r);
    expect(r.get("fake")).toBe(fake);
    expect(r.has("fake")).toBe(true);
    expect(r.get("nope")).toBeUndefined();
    expect(r.list()).toHaveLength(1);
    expect(r.configs()[0]).toMatchObject({ id: "fake", name: "Fake Provider" });
  });

  it("resolves models and capabilities, and refuses unknown combinations", () => {
    const r = createProviderRegistry([fakeAdapter().adapter]);
    expect(r.findModel("fake", "m1")?.displayName).toBe("M1");
    expect(r.supports("fake", "m1", "text_to_image")).toBe(true);
    expect(r.supports("fake", "m1", "text_to_video")).toBe(false);
    expect(r.supports("fake", "other", "text_to_image")).toBe(false);
    expect(r.supports("nope", "m1", "text_to_image")).toBe(false);
  });

  it("rejects duplicate registration and malformed configs", () => {
    const r = createProviderRegistry([fakeAdapter().adapter]);
    expect(() => r.register(fakeAdapter().adapter)).toThrow(/already registered/);
    expect(() => new ProviderRegistry().register(withConfig({ id: "Bad Id!" }))).toThrow(/Invalid provider id/);
    expect(() => new ProviderRegistry().register(withConfig({ availableModels: [] }))).toThrow(/no models/);
    const m = { modelId: "x", displayName: "X", capabilities: ["text_to_image" as const] };
    expect(() => new ProviderRegistry().register(withConfig({ availableModels: [m, m] }))).toThrow(/duplicate/);
    expect(() => new ProviderRegistry().register(withConfig({ availableModels: [{ ...m, capabilities: [] }] }))).toThrow(/no capabilities/);
  });

  it("supports several providers side by side without touching core code", () => {
    const second = withConfig({ id: "second", name: "Second" });
    const r = createProviderRegistry([fakeAdapter().adapter, second]);
    expect(r.configs().map((c) => c.id)).toEqual(["fake", "second"]);
  });
});

describe("default registry", () => {
  it("registers OpenAI and OpenRouter with their models and parameters, and not the template", () => {
    expect(providerRegistry.configs().map((c) => c.id)).toEqual(["openai", "openrouter"]);
    expect(providerRegistry.get("openrouter")!.config.availableModels.length).toBeGreaterThanOrEqual(2);
    expect(providerRegistry.supports("openrouter", "google/gemini-2.5-flash-image", "text_to_image")).toBe(true);
    const openai = providerRegistry.get("openai")!;
    expect(openai.getCapabilities()).toEqual(["text_to_image", "image_to_image"]);
    const model = providerRegistry.findModel("openai", "gpt-image-1")!;
    expect(model.parameters!.map((p) => p.key)).toEqual(["size", "quality"]);
    expect(providerRegistry.has("template")).toBe(false);
  });

  it("every registered adapter exposes the full ProviderAdapter surface", () => {
    for (const a of providerRegistry.list()) {
      for (const fn of ["getCapabilities", "validateRequest", "testKey", "estimateCost", "executeJob"] as const) {
        expect(typeof a[fn]).toBe("function");
      }
    }
  });

  it("the drop-in template is a valid, safe-by-default adapter", async () => {
    const t = createTemplateAdapter();
    expect(() => createProviderRegistry([t])).not.toThrow();
    expect(() => t.validateRequest({ capability: "text_to_image", modelId: "template-model", inputAssetIds: [], parameters: {} })).toThrow();
    await expect(t.executeJob({ capability: "text_to_image", modelId: "template-model", inputAssetIds: [], parameters: {} }, "k", { secret: "s", inputFiles: [] })).rejects.toThrow(/not implemented/);
  });
});
