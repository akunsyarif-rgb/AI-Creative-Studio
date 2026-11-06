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

  it("treats users outside the allowlist as unauthenticated, and never calls through for bad tokens", async () => {
    const a = parseAllowlist({ ALLOWED_USER_EMAILS: "me@example.com" });
    const verify = withAllowlist(
      async (t) => (t === "good" ? { userId: "u1", email: "me@example.com" } : t === "other" ? { userId: "u2", email: "p@school.id" } : null),
      a
    );
    expect(await verify("good")).toEqual({ userId: "u1", email: "me@example.com" });
    expect(await verify("other")).toBeNull();
    expect(await verify("bad")).toBeNull();
  });
});
