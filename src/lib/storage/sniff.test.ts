import { describe, expect, it } from "vitest";
import { sniffMime } from "./sniff";

const bytes = (...n: number[]) => Uint8Array.from(n);
const text = (s: string) => Uint8Array.from([...s].map((c) => c.charCodeAt(0)));

describe("sniffMime", () => {
  it("recognizes accepted formats", () => {
    expect(sniffMime(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0))).toBe("image/png");
    expect(sniffMime(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe("image/jpeg");
    expect(sniffMime(text("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
    expect(sniffMime(text("\0\0\0\x18ftypisom\0\0\0\0"))).toBe("video/mp4");
    expect(sniffMime(text("\0\0\0\x14ftypqt  \0\0\0\0"))).toBe("video/quicktime");
    expect(sniffMime(bytes(0x1a, 0x45, 0xdf, 0xa3, 0x01))).toBe("video/webm");
  });

  it("returns null for HTML, SVG, scripts, truncated and empty input", () => {
    for (const s of ["<html>", "<svg xmlns=", "#!/bin/sh\n", "GIF89a....", "RIFF\0\0\0\0WAVEfmt "]) expect(sniffMime(text(s))).toBeNull();
    expect(sniffMime(bytes(0x89, 0x50))).toBeNull();
    expect(sniffMime(new Uint8Array())).toBeNull();
  });
});
