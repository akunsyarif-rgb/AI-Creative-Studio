import { describe, expect, it } from "vitest";
import { allowlistConfigured, isAllowed, parseAllowlist, withAllowlist } from "./allowlist";

describe("allowlist", () => {
  it("parses comma lists, trims, drops blanks and lower-cases emails", () => {
    const a = parseAllowlist({ ALLOWED_USER_EMAILS: " Me@Example.com , ,other@x.io", ALLOWED_USER_IDS: "u1, u2" });
    expect([...a.emails]).toEqual(["me@example.com", "other@x.io"]);
    expect([...a.ids]).toEqual(["u1", "u2"]);
    expect(allowlistConfigured(a)).toBe(true);
  });

  it("is not configured, and allows nobody, when both variables are unset or empty", () => {
    for (const env of [{}, { ALLOWED_USER_EMAILS: "", ALLOWED_USER_IDS: " , " }]) {
      const a = parseAllowlist(env);
      expect(allowlistConfigured(a)).toBe(false);
      expect(isAllowed({ userId: "u1", email: "me@example.com" }, a)).toBe(false);
    }
  });

  it("allows by id or by case-insensitive email, and nobody else", () => {
    const a = parseAllowlist({ ALLOWED_USER_EMAILS: "me@example.com", ALLOWED_USER_IDS: "owner1" });
    expect(isAllowed({ userId: "owner1" }, a)).toBe(true);
    expect(isAllowed({ userId: "x", email: "ME@EXAMPLE.COM" }, a)).toBe(true);
    expect(isAllowed({ userId: "x", email: "stranger@example.com" }, a)).toBe(false);
    expect(isAllowed({ userId: "x" }, a)).toBe(false);
    expect(isAllowed({ userId: "x", email: "me@example.com.evil.io" }, a)).toBe(false);
  });

  it("rejects signed-in users outside the allowlist with AccessDeniedError, and yields null for invalid tokens", async () => {
    const a = parseAllowlist({ ALLOWED_USER_EMAILS: "me@example.com" });
    const verify = withAllowlist(
      async (t) => (t === "good" ? { userId: "u1", email: "me@example.com" } : t === "other" ? { userId: "u2", email: "p@school.id" } : null),
      a
    );
    expect(await verify("good")).toEqual({ userId: "u1", email: "me@example.com" });
    await expect(verify("other")).rejects.toMatchObject({ name: "AccessDeniedError", email: "p@school.id" });
    expect(await verify("bad")).toBeNull();
  });
});

import { getJobs } from "@/lib/api/handlers";
import { createTestWorld, jsonRequest } from "@/lib/api/test-helpers";

describe("allowlist through the API", () => {
  const world = () => {
    const w = createTestWorld();
    const verify = withAllowlist(
      async (t) => (t === "token-for-stranger-00000000" ? { userId: "s1", email: "Stranger@School.id" } : t === "token-for-owner-0000000000000" ? { userId: "o1", email: "owner@x.io" } : null),
      parseAllowlist({ ALLOWED_USER_EMAILS: "owner@x.io" })
    );
    w.deps.verifyToken = verify;
    return w;
  };
  const call = (w: ReturnType<typeof world>, token: string) => getJobs(jsonRequest("/api/jobs", { token, method: "GET" }), w.deps);

  it("answers 403 (not 401) for a valid account that is not allowed, naming the account so typos are visible", async () => {
    const res = await call(world(), "token-for-stranger-00000000");
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("forbidden");
    expect(body.error.message).toContain("Stranger@School.id");
    expect(body.error.message).toContain("ALLOWED_USER_EMAILS");
  });

  it("still answers 401 for invalid or missing tokens, and 200 for the allowed owner", async () => {
    expect((await call(world(), "token-for-nobody-000000000000")).status).toBe(401);
    expect((await getJobs(jsonRequest("/api/jobs", { method: "GET" }), world().deps)).status).toBe(401);
    expect((await call(world(), "token-for-owner-0000000000000")).status).toBe(200);
  });
});
