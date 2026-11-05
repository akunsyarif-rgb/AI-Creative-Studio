import "server-only";
import { z } from "zod";
import { verifyAppwriteJwt } from "@/lib/appwrite/server";
import { appwriteAssetsRepository, appwriteJobsRepository, appwriteKeysRepository } from "@/lib/data/appwrite-repositories";
import { encryptProviderCredential } from "@/lib/security/secrets";
import { createR2Storage } from "@/lib/storage/r2";
import type { ApiDeps, ProviderCatalog } from "./handlers";

const storageEnv = z.object({
  STORAGE_ENDPOINT: z.url(),
  STORAGE_BUCKET: z.string().min(1),
  STORAGE_ACCESS_KEY_ID: z.string().min(1),
  STORAGE_SECRET_ACCESS_KEY: z.string().min(1)
});

/** No provider adapters exist yet, so nothing is runnable. Replace when adapters are registered. */
const emptyCatalog: ProviderCatalog = { supports: () => false };

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
    vault: { encrypt: encryptProviderCredential },
    storage: createR2Storage({
      endpoint: env.data.STORAGE_ENDPOINT,
      bucket: env.data.STORAGE_BUCKET,
      accessKeyId: env.data.STORAGE_ACCESS_KEY_ID,
      secretAccessKey: env.data.STORAGE_SECRET_ACCESS_KEY
    }),
    catalog: emptyCatalog
  };
  return cached;
}
