import { apiError } from "./http";

/**
 * Fixed-window in-memory rate limiter. Per server instance only: on serverless
 * or multi-instance hosting each instance counts separately, so treat it as a
 * basic abuse brake, not a hard global quota (use a shared store for that).
 */
export interface RateLimiter {
  /** Returns 0 if allowed, otherwise the seconds to wait. */
  check(bucket: string, subject: string): number;
}

export interface RateLimitRule {
  limit: number;
  windowSeconds: number;
}

export const RATE_RULES = {
  keys: { limit: 20, windowSeconds: 60 },
  uploads: { limit: 30, windowSeconds: 60 },
  providerTest: { limit: 5, windowSeconds: 60 },
  jobs: { limit: 20, windowSeconds: 60 }
} satisfies Record<string, RateLimitRule>;

export type RateBucket = keyof typeof RATE_RULES;

export function createRateLimiter(rules: Record<string, RateLimitRule> = RATE_RULES, now: () => number = Date.now): RateLimiter {
  const windows = new Map<string, { start: number; count: number }>();
  let lastSweep = now();
  return {
    check(bucket, subject) {
      const rule = rules[bucket];
      if (!rule) throw new Error(`Unknown rate limit bucket: ${bucket}`);
      const t = now();
      if (t - lastSweep > 60_000) {
        for (const [k, w] of windows) if (t - w.start > 3_600_000) windows.delete(k);
        lastSweep = t;
      }
      const key = `${bucket}:${subject}`;
      const windowMs = rule.windowSeconds * 1000;
      const w = windows.get(key);
      if (!w || t - w.start >= windowMs) {
        windows.set(key, { start: t, count: 1 });
        return 0;
      }
      if (w.count >= rule.limit) return Math.max(1, Math.ceil((w.start + windowMs - t) / 1000));
      w.count++;
      return 0;
    }
  };
}

/** Returns a 429 response if `subject` is over the limit for `bucket`, else null. */
export function enforceRate(limiter: RateLimiter, bucket: RateBucket, subject: string): Response | null {
  const wait = limiter.check(bucket, subject);
  if (!wait) return null;
  const res = apiError(429, "rate_limited", "Too many requests. Please slow down.");
  res.headers.set("Retry-After", String(wait));
  return res;
}
