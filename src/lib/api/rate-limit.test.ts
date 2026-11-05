import { describe, expect, it } from "vitest";
import { createRateLimiter } from "./rate-limit";

describe("rate limiter", () => {
  it("allows up to the limit then reports seconds to wait, per subject and bucket", () => {
    let t = 0;
    const rl = createRateLimiter({ a: { limit: 2, windowSeconds: 10 }, b: { limit: 1, windowSeconds: 10 } }, () => t);
    expect(rl.check("a", "u1")).toBe(0);
    expect(rl.check("a", "u1")).toBe(0);
    expect(rl.check("a", "u1")).toBe(10);
    t = 4000;
    expect(rl.check("a", "u1")).toBe(6);
    expect(rl.check("a", "u2")).toBe(0);
    expect(rl.check("b", "u1")).toBe(0);
  });

  it("opens a fresh window after it elapses", () => {
    let t = 0;
    const rl = createRateLimiter({ a: { limit: 1, windowSeconds: 10 } }, () => t);
    expect(rl.check("a", "u")).toBe(0);
    expect(rl.check("a", "u")).toBeGreaterThan(0);
    t = 10_000;
    expect(rl.check("a", "u")).toBe(0);
  });

  it("rejects unknown buckets", () => {
    expect(() => createRateLimiter({}).check("nope", "u")).toThrow();
  });
});
