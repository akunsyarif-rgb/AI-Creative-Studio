/**
 * Shrinks a photo in the browser before upload so a reference image stays small (and uploads fast on mobile data).
 * Photos already under the limit are left untouched. The original file is never modified: it stays on the user's
 * device, and only the smaller copy is uploaded. Compressed copies are JPEG (transparency becomes white).
 */

export const COMPRESS_TARGET_BYTES = 2 * 1024 * 1024;

const SIDES = [2048, 1600, 1280, 1024, 768, 512];
const QUALITIES = [0.9, 0.8, 0.7, 0.6, 0.5];

export interface ImageCodec {
  /** Natural size of the (orientation-corrected) image. */
  measure(file: File): Promise<{ width: number; height: number }>;
  /** Re-encodes as JPEG at the given size and quality. */
  encode(file: File, width: number, height: number, quality: number): Promise<Blob>;
}

export class CompressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompressError";
  }
}

export async function compressImage(file: File, codec: ImageCodec = browserCodec, maxBytes = COMPRESS_TARGET_BYTES): Promise<File> {
  if (file.size <= maxBytes) return file;
  let size: { width: number; height: number };
  try {
    size = await codec.measure(file);
  } catch {
    throw new CompressError("This image could not be read to shrink it. Try a different photo.");
  }
  const longest = Math.max(size.width, size.height);
  const sides = [...new Set([Math.min(longest, SIDES[0]), ...SIDES.filter((s) => s < longest)])];
  for (const side of sides) {
    const scale = Math.min(1, side / longest);
    const width = Math.max(1, Math.round(size.width * scale));
    const height = Math.max(1, Math.round(size.height * scale));
    for (const quality of QUALITIES) {
      let blob: Blob;
      try {
        blob = await codec.encode(file, width, height, quality);
      } catch {
        throw new CompressError("This image could not be shrunk. Try a different photo.");
      }
      if (blob.size > 0 && blob.size <= maxBytes) {
        const base = file.name.replace(/\.[^.]+$/, "") || "image";
        return new File([blob], `${base}.jpg`, { type: "image/jpeg", lastModified: file.lastModified });
      }
    }
  }
  throw new CompressError("This image is still too large after shrinking. Try a smaller photo.");
}

/** Browser implementation (canvas). Not used in tests. */
export const browserCodec: ImageCodec = {
  async measure(file) {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const out = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return out;
  },
  async encode(file, width, height, quality) {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    try {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("no canvas");
      ctx.fillStyle = "#fff"; // JPEG has no transparency
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(bitmap, 0, 0, width, height);
      return await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("encode failed"))), "image/jpeg", quality));
    } finally {
      bitmap.close();
    }
  }
};
