import "server-only";
import { after } from "next/server";
import { z } from "zod";
import { adminTables, verifyAppwriteJwt } from "@/lib/appwrite/server";
import { parseAllowlist, withAllowlist } from "@/lib/auth/allowlist";
import { appwriteAssetsRepository, appwriteJobsRepository, appwriteKeysRepository } from "@/lib/data/appwrite-repositories";
import { providerRegistry } from "@/lib/providers";
import { createOpenAICompatibleAdapter } from "@/lib/providers/adapters/openai-compatible";
import { decryptProviderCredential, encryptProviderCredential } from "@/lib/security/secrets";
import { createR2Storage } from "@/lib/storage/r2";
import type { ApiDeps } from "./handlers";
import { createRateLimiter } from "./rate-limit";

const storageEnv = z.object({
  STORAGE_ENDPOINT: z.url(),
  STORAGE_BUCKET: z.string().min(1),
  STORAGE_ACCESS_KEY_ID: z.string().min(1),
  STORAGE_SECRET_ACCESS_KEY: z.string().min(1)
});

function maxJobCostUsd(): number {
  const parsed = Number(process.env.MAX_JOB_COST_USD);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

let cached: ApiDeps | undefined;

/** Built lazily so `next build` and unit tests never need live credentials. */
export function getApiDeps(): ApiDeps {
  if (cached) return cached;
  const env = storageEnv.safeParse(process.env);
  if (!env.success) throw new Error("R2 storage is not configured (missing or invalid STORAGE_* variables).");
  const repo = adminTables();
  cached = {
    // The Appwrite project may be shared with other apps, so valid sign-in is not enough:
    // only explicitly allowed accounts may use this app. Fails closed when no allowlist is set.
    verifyToken: withAllowlist(verifyAppwriteJwt, parseAllowlist(process.env)),
    jobs: appwriteJobsRepository(repo),
    assets: appwriteAssetsRepository(repo),
    keys: appwriteKeysRepository(repo),
    vault: { encrypt: encryptProviderCredential, decrypt: decryptProviderCredential },
    limiter: createRateLimiter(),
    scheduler: { run: (task) => after(task) },
    maxJobCostUsd: maxJobCostUsd(),
    storage: createR2Storage({
      endpoint: env.data.STORAGE_ENDPOINT,
      bucket: env.data.STORAGE_BUCKET,
      accessKeyId: env.data.STORAGE_ACCESS_KEY_ID,
      secretAccessKey: env.data.STORAGE_SECRET_ACCESS_KEY
    }),
    providers: providerRegistry,
    buildCustomAdapter: (config) => createOpenAICompatibleAdapter(config)
  };
  return cached;
}
