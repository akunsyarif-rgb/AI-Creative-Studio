import { describe, expect, it } from "vitest";
import { COMPRESS_TARGET_BYTES, CompressError, compressImage, type ImageCodec } from "./compress";

const big = (name = "IMG_1.PNG", size = COMPRESS_TARGET_BYTES + 1) => new File([new Uint8Array(size)], name, { type: "image/png", lastModified: 5 });

/** A fake codec whose output size shrinks with pixels and quality. */
function codec(size = { width: 4000, height: 3000 }, bytesPerPixel = 1): ImageCodec & { calls: [number, number, number][] } {
  const calls: [number, number, number][] = [];
  return {
    calls,
    measure: async () => size,
    encode: async (_f, w, h, q) => { calls.push([w, h, q]); return new Blob([new Uint8Array(Math.round(w * h * q * bytesPerPixel))]); }
  };
}

describe("compressImage", () => {
  it("returns small files unchanged without touching the codec", async () => {
    const small = big("a.png", 1000);
    const c = codec();
    expect(await compressImage(small, c)).toBe(small);
    expect(c.calls).toHaveLength(0);
  });

  it("shrinks to at most 2 MB as a JPEG, keeps the aspect ratio and renames the copy", async () => {
    const original = big();
    const out = await compressImage(original, codec());
    expect(out.size).toBeLessThanOrEqual(COMPRESS_TARGET_BYTES);
    expect(out.type).toBe("image/jpeg");
    expect(out.name).toBe("IMG_1.jpg");
    expect(original.size).toBe(COMPRESS_TARGET_BYTES + 1); // the original is untouched
    const c = codec();
    await compressImage(original, c);
    const [w, h] = c.calls[0];
    expect(Math.max(w, h)).toBe(2048);
    expect(Math.abs(w / h - 4000 / 3000)).toBeLessThan(0.01);
  });

  it("lowers quality first, then the size, and never upscales a smaller image", async () => {
    const c = codec({ width: 1500, height: 1000 }, 3);
    const out = await compressImage(big(), c);
    expect(out.size).toBeLessThanOrEqual(COMPRESS_TARGET_BYTES);
    expect(c.calls[0][0]).toBe(1500);
    expect(c.calls.every(([w]) => w <= 1500)).toBe(true);
    expect(c.calls[1][2]).toBeLessThan(c.calls[0][2]);
  });

  it("fails with a clear error when it cannot get small enough or cannot read the image", async () => {
    const stubborn: ImageCodec = { measure: async () => ({ width: 4000, height: 3000 }), encode: async () => new Blob([new Uint8Array(COMPRESS_TARGET_BYTES + 1)]) };
    await expect(compressImage(big(), stubborn)).rejects.toBeInstanceOf(CompressError);
    await expect(compressImage(big(), { measure: async () => { throw new Error("x"); }, encode: async () => new Blob([]) })).rejects.toThrow(/could not be read/);
    await expect(compressImage(big(), { measure: async () => ({ width: 10, height: 10 }), encode: async () => { throw new Error("x"); } })).rejects.toThrow(/could not be shrunk/);
  });
});
