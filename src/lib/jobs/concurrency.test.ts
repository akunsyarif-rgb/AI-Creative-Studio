import { describe, expect, it } from "vitest";
import { ACTIVE_WINDOW_MS, concurrencyVerdict } from "./concurrency";
import type { Capability } from "@/lib/providers/types";

const NOW = Date.parse("2026-11-06T12:00:00Z");
const job = (capability: Capability, status = "processing", ageMs = 60_000) =>
  ({ capability, status: status as "processing", createdAt: new Date(NOW - ageMs).toISOString() });
const image = (n: number) => Array.from({ length: n }, () => job("text_to_image"));
const video = (n: number) => Array.from({ length: n }, () => job("text_to_video"));
const ok = (jobs: ReturnType<typeof job>[], incoming: Capability) => concurrencyVerdict(jobs, incoming, NOW).allowed;

describe("concurrency limits (3 at once, at most 2 videos)", () => {
  it("allows up to 3 images", () => {
    expect(ok([], "text_to_image")).toBe(true);
    expect(ok(image(2), "image_to_image")).toBe(true);
    expect(ok(image(3), "text_to_image")).toBe(false);
  });

  it("1 video leaves room for 2 more images", () => {
    expect(ok(video(1), "text_to_image")).toBe(true);
    expect(ok([...video(1), ...image(1)], "text_to_image")).toBe(true);
    expect(ok([...video(1), ...image(2)], "text_to_image")).toBe(false);
  });

  it("2 videos leave room for 1 image only, and no third video", () => {
    expect(ok(video(2), "text_to_image")).toBe(true);
    expect(ok([...video(2), ...image(1)], "text_to_image")).toBe(false);
    expect(ok(video(2), "image_to_video")).toBe(false);
    expect(ok([...video(1), ...image(1)], "text_to_video")).toBe(true);
    expect(ok([...video(1), ...image(2)], "text_to_video")).toBe(false);
  });

  it("explains itself and reports the counts", () => {
    const v = concurrencyVerdict(video(2), "text_to_video", NOW);
    expect(v).toMatchObject({ allowed: false, active: { total: 2, videos: 2 } });
    expect(v.reason).toMatch(/2 videos/);
    expect(concurrencyVerdict(image(3), "text_to_image", NOW).reason).toMatch(/3 jobs/);
  });

  it("finished jobs do not count", () => {
    const done = ["completed", "failed", "cancelled"].map((s) => job("text_to_image", s));
    expect(ok([...done, ...done, ...image(2)], "text_to_image")).toBe(true);
    expect(concurrencyVerdict(done, "text_to_image", NOW).active.total).toBe(0);
  });

  it("a job that never finished stops blocking after its window", () => {
    expect(ok([job("text_to_image", "queued", ACTIVE_WINDOW_MS.image + 1000), ...image(2)], "text_to_image")).toBe(true);
    expect(ok([job("text_to_video", "processing", ACTIVE_WINDOW_MS.video - 1000), ...image(2)], "text_to_image")).toBe(false);
    expect(ok([job("text_to_video", "processing", ACTIVE_WINDOW_MS.video + 1000), ...image(2)], "text_to_image")).toBe(true);
  });
});
