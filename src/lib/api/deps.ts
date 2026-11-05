import "server-only";
import { after } from "next/server";
import { z } from "zod";
import { verifyAppwriteJwt } from "@/lib/appwrite/server";
import { appwriteAssetsRepository, appwriteJobsRepository, appwriteKeysRepository } from "@/lib/data/appwrite-repositories";
import { createOpenAIAdapter } from "@/lib/providers/openai";
import { decryptProviderCredential, encryptProviderCredential } from "@/lib/security/secrets";
import { createR2Storage } from "@/lib/storage/r2";
import type { ApiDeps, ProviderCatalog } from "./handlers";
import { createRateLimiter } from "./rate-limit";

const storageEnv = z.object({
  STORAGE_ENDPOINT: z.url(),
  STORAGE_BUCKET: z.string().min(1),
  STORAGE_ACCESS_KEY_ID: z.string().min(1),
  STORAGE_SECRET_ACCESS_KEY: z.string().min(1)
});

const adapters = [createOpenAIAdapter()];

const catalog: ProviderCatalog = {
  adapter: (providerId) => adapters.find((a) => a.providerId === providerId),
  supports: (providerId, modelId, capability) =>
    !!adapters
      .find((a) => a.providerId === providerId)
      ?.models()
      .some((m) => m.modelId === modelId && m.capabilities.includes(capability))
};

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
  cached = {
    verifyToken: verifyAppwriteJwt,
    jobs: appwriteJobsRepository(),
    assets: appwriteAssetsRepository(),
    keys: appwriteKeysRepository(),
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
    catalog
  };
  return cached;
}
