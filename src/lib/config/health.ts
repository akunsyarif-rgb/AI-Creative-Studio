import { allowlistConfigured, parseAllowlist } from "@/lib/auth/allowlist";
import { parseKeyring } from "@/lib/security/secrets-core";

export interface ConfigReport {
  ok: boolean;
  checks: { appwrite: boolean; browserAuth: boolean; storage: boolean; encryption: boolean; access: boolean };
  /** Names of unset or invalid variables. Never values. */
  missing: string[];
  warnings: string[];
}

type Env = Record<string, string | undefined>;

const isHttpsUrl = (v: string | undefined) => {
  try {
    return !!v && new URL(v).protocol === "https:";
  } catch {
    return false;
  }
};
const present = (v: string | undefined) => !!v && v.trim().length > 0;
const trimSlash = (v: string) => v.replace(/\/+$/, "");

/**
 * Static configuration check (no network calls, no secrets in the output).
 * Appwrite may legitimately be self-hosted over http, so only the storage
 * endpoint is required to be https.
 */
export function checkConfig(env: Env): ConfigReport {
  const missing: string[] = [];
  const warnings: string[] = [];
  const need = (name: string, valid: boolean) => {
    if (!valid) missing.push(name);
    return valid;
  };
  const isUrl = (v: string | undefined) => {
    try {
      return !!v && ["http:", "https:"].includes(new URL(v).protocol);
    } catch {
      return false;
    }
  };

  const appwrite = [
    need("APPWRITE_ENDPOINT", isUrl(env.APPWRITE_ENDPOINT)),
    need("APPWRITE_PROJECT_ID", present(env.APPWRITE_PROJECT_ID)),
    need("APPWRITE_API_KEY", present(env.APPWRITE_API_KEY)),
    need("APPWRITE_DATABASE_ID", present(env.APPWRITE_DATABASE_ID))
  ].every(Boolean);

  const browserAuth = [
    need("NEXT_PUBLIC_APPWRITE_ENDPOINT", isUrl(env.NEXT_PUBLIC_APPWRITE_ENDPOINT)),
    need("NEXT_PUBLIC_APPWRITE_PROJECT_ID", present(env.NEXT_PUBLIC_APPWRITE_PROJECT_ID))
  ].every(Boolean);

  const storage = [
    need("STORAGE_ENDPOINT", isHttpsUrl(env.STORAGE_ENDPOINT)),
    need("STORAGE_BUCKET", present(env.STORAGE_BUCKET)),
    need("STORAGE_ACCESS_KEY_ID", present(env.STORAGE_ACCESS_KEY_ID)),
    need("STORAGE_SECRET_ACCESS_KEY", present(env.STORAGE_SECRET_ACCESS_KEY))
  ].every(Boolean);

  let encryption = false;
  try {
    parseKeyring(env.CREDENTIAL_ENCRYPTION_KEYS);
    encryption = true;
  } catch {
    missing.push("CREDENTIAL_ENCRYPTION_KEYS");
  }

  // Without an allowlist every request is rejected (the Appwrite project's users are not all ours).
  const access = allowlistConfigured(parseAllowlist(env));
  if (!access) missing.push("ALLOWED_USER_EMAILS (or ALLOWED_USER_IDS)");

  // Common mistakes that pass the checks above but break at runtime.
  if (appwrite && browserAuth && trimSlash(env.APPWRITE_ENDPOINT as string) !== trimSlash(env.NEXT_PUBLIC_APPWRITE_ENDPOINT as string)) {
    warnings.push("APPWRITE_ENDPOINT and NEXT_PUBLIC_APPWRITE_ENDPOINT differ");
  }
  if (appwrite && browserAuth && env.APPWRITE_PROJECT_ID !== env.NEXT_PUBLIC_APPWRITE_PROJECT_ID) {
    warnings.push("APPWRITE_PROJECT_ID and NEXT_PUBLIC_APPWRITE_PROJECT_ID differ");
  }
  if (storage && new URL(env.STORAGE_ENDPOINT as string).pathname.replace(/\/+$/, "") !== "") {
    warnings.push("STORAGE_ENDPOINT should not include a path or the bucket name");
  }
  if (storage && present(env.STORAGE_BUCKET) && new URL(env.STORAGE_ENDPOINT as string).hostname.startsWith(`${env.STORAGE_BUCKET}.`)) {
    warnings.push("STORAGE_ENDPOINT should not start with the bucket name");
  }
  if (env.MAX_JOB_COST_USD !== undefined && !(Number(env.MAX_JOB_COST_USD) > 0)) {
    warnings.push("MAX_JOB_COST_USD is invalid; the default of 1 USD is used");
  }

  return { ok: appwrite && browserAuth && storage && encryption && access, checks: { appwrite, browserAuth, storage, encryption, access }, missing, warnings };
}
