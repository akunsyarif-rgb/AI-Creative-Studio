import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { checkConfig } from "./health";

const good = () => ({
  APPWRITE_ENDPOINT: "https://cloud.appwrite.io/v1",
  APPWRITE_PROJECT_ID: "proj1",
  APPWRITE_API_KEY: "standard_abc",
  APPWRITE_DATABASE_ID: "studio",
  NEXT_PUBLIC_APPWRITE_ENDPOINT: "https://cloud.appwrite.io/v1",
  NEXT_PUBLIC_APPWRITE_PROJECT_ID: "proj1",
  STORAGE_ENDPOINT: "https://acct123.r2.cloudflarestorage.com",
  STORAGE_BUCKET: "studio",
  STORAGE_ACCESS_KEY_ID: "AKIAEXAMPLE",
  STORAGE_SECRET_ACCESS_KEY: "secret-value",
  CREDENTIAL_ENCRYPTION_KEYS: `k1:${randomBytes(32).toString("base64")}`,
  ALLOWED_USER_EMAILS: "me@example.com"
});

describe("checkConfig", () => {
  it("is ok for a complete, consistent configuration", () => {
    const r = checkConfig(good());
    expect(r).toEqual({ ok: true, checks: { appwrite: true, browserAuth: true, storage: true, encryption: true, access: true }, missing: [], warnings: [] });
  });

  it("reports every missing group by variable name", () => {
    const r = checkConfig({});
    expect(r.ok).toBe(false);
    expect(Object.values(r.checks)).toEqual([false, false, false, false, false]);
    expect(r.missing).toEqual(expect.arrayContaining(["APPWRITE_API_KEY", "NEXT_PUBLIC_APPWRITE_PROJECT_ID", "STORAGE_BUCKET", "CREDENTIAL_ENCRYPTION_KEYS", "ALLOWED_USER_EMAILS (or ALLOWED_USER_IDS)"]));
  });

  it("flags a malformed encryption key (wrong length) and a non-https storage endpoint", () => {
    const r = checkConfig({ ...good(), CREDENTIAL_ENCRYPTION_KEYS: "k1:dG9vc2hvcnQ=", STORAGE_ENDPOINT: "http://acct.r2.cloudflarestorage.com" });
    expect(r.checks.encryption).toBe(false);
    expect(r.checks.storage).toBe(false);
    expect(r.missing).toEqual(["STORAGE_ENDPOINT", "CREDENTIAL_ENCRYPTION_KEYS"]);
  });

  it("is not ok without an allowlist, and accepts ids instead of emails", () => {
    const rest: Record<string, string | undefined> = good();
    delete rest.ALLOWED_USER_EMAILS;
    expect(checkConfig(rest)).toMatchObject({ ok: false, checks: { access: false }, missing: ["ALLOWED_USER_EMAILS (or ALLOWED_USER_IDS)"] });
    expect(checkConfig({ ...rest, ALLOWED_USER_IDS: "abc123" }).ok).toBe(true);
  });

  it("warns about common mistakes that would only fail at runtime", () => {
    const r = checkConfig({
      ...good(),
      NEXT_PUBLIC_APPWRITE_ENDPOINT: "https://fra.cloud.appwrite.io/v1",
      NEXT_PUBLIC_APPWRITE_PROJECT_ID: "other",
      STORAGE_ENDPOINT: "https://acct123.r2.cloudflarestorage.com/studio",
      MAX_JOB_COST_USD: "abc"
    });
    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual([
      "APPWRITE_ENDPOINT and NEXT_PUBLIC_APPWRITE_ENDPOINT differ",
      "APPWRITE_PROJECT_ID and NEXT_PUBLIC_APPWRITE_PROJECT_ID differ",
      "STORAGE_ENDPOINT should not include a path or the bucket name",
      "MAX_JOB_COST_USD is invalid; the default of 1 USD is used"
    ]);
  });

  it("warns when the endpoint starts with the bucket name", () => {
    expect(checkConfig({ ...good(), STORAGE_ENDPOINT: "https://studio.acct123.r2.cloudflarestorage.com" }).warnings).toEqual([
      "STORAGE_ENDPOINT should not start with the bucket name"
    ]);
  });

  it("never includes secret values in its output", () => {
    const env = good();
    const out = JSON.stringify(checkConfig({ ...env, STORAGE_ENDPOINT: "nope" }));
    for (const secret of [env.APPWRITE_API_KEY, env.STORAGE_SECRET_ACCESS_KEY, env.STORAGE_ACCESS_KEY_ID, env.CREDENTIAL_ENCRYPTION_KEYS]) {
      expect(out).not.toContain(secret);
    }
  });
});
