import { describe, expect, it } from "vitest";
import nextConfig, { securityHeaders } from "../../../next.config";

describe("security headers", () => {
  it("applies baseline headers to every route", async () => {
    const rules = await nextConfig.headers!();
    expect(rules).toEqual([{ source: "/:path*", headers: securityHeaders }]);
    const map = Object.fromEntries(securityHeaders.map((h) => [h.key, h.value]));
    expect(map["X-Content-Type-Options"]).toBe("nosniff");
    expect(map["X-Frame-Options"]).toBe("DENY");
    expect(map["Strict-Transport-Security"]).toMatch(/max-age=\d+/);
    expect(map["Permissions-Policy"]).toContain("camera=()");
  });

  it("does not advertise the framework", () => {
    expect(nextConfig.poweredByHeader).toBe(false);
  });
});
