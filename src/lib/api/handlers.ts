import { createHash } from "node:crypto";
import { z } from "zod";
import { authenticate, type TokenVerifier } from "@/lib/auth/session";
import type { AssetsRepository, JobsRepository, KeysRepository } from "@/lib/data/repositories";
import { CAPABILITIES, type Capability } from "@/lib/providers/types";
import { StorageError, newObjectKey, validateUpload, type ObjectStorage } from "@/lib/storage/r2";
import { apiError, internalError, json, parseJson, unauthorized } from "./http";

/** Which provider/model pairs can run which capability. Empty until adapters are registered. */
export interface ProviderCatalog {
  supports(providerId: string, modelId: string, capability: Capability): boolean;
}

/** Encrypts provider credentials. The default implementation wraps `security/secrets.ts`. */
export interface CredentialVault {
  encrypt(plaintext: string, context: string): Promise<string>;
}

export interface ApiDeps {
  keys: KeysRepository;
  vault: CredentialVault;
  verifyToken: TokenVerifier;
  jobs: JobsRepository;
  assets: AssetsRepository;
  storage: ObjectStorage;
  catalog: ProviderCatalog;
}

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,35}$/, "Invalid id");

export const createJobSchema = z.object({
  projectId: id,
  capability: z.enum(CAPABILITIES),
  providerId: z.string().min(1).max(64),
  modelId: z.string().min(1).max(128),
  inputAssetIds: z.array(id).max(16).default([]),
  parameters: z
    .record(z.string(), z.unknown())
    .default({})
    .refine((p) => JSON.stringify(p).length <= 16000, "parameters too large"),
  idempotencyKey: z.string().min(8).max(128).regex(/^[\w.:-]+$/, "Invalid idempotency key")
});

export const presignSchema = z.object({
  contentType: z.string().min(1).max(128),
  size: z.number().int().positive(),
  originalName: z.string().max(256).optional(),
  projectId: id.optional()
});

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function requestHash(input: z.infer<typeof createJobSchema>): string {
  const { projectId, capability, providerId, modelId, inputAssetIds, parameters } = input;
  const payload = { projectId, capability, providerId, modelId, parameters, inputAssetIds: [...inputAssetIds].sort() };
  return createHash("sha256").update(canonical(payload)).digest("hex");
}

function publicJob(job: Awaited<ReturnType<JobsRepository["listByOwner"]>>[number]) {
  return {
    id: job.id, projectId: job.projectId, capability: job.capability, providerId: job.providerId, modelId: job.modelId,
    status: job.status, inputAssetIds: job.inputAssetIds, progress: job.progress, errorCode: job.errorCode,
    estimatedCost: job.estimatedCost === null ? null : { amount: job.estimatedCost, currency: job.currency, isEstimate: true },
    createdAt: job.createdAt
  };
}

export async function postJob(request: Request, deps: ApiDeps): Promise<Response> {
  try {
    const user = await authenticate(request, deps.verifyToken);
    if (!user) return unauthorized();
    const body = await parseJson(request, createJobSchema);
    if (!body.ok) return body.response;
    const input = body.data;

    // Fail closed: no adapter => nothing is persisted or submitted.
    if (!deps.catalog.supports(input.providerId, input.modelId, input.capability)) {
      return apiError(422, "unsupported_capability", "This provider/model does not support the requested capability.");
    }

    const uniqueAssetIds = [...new Set(input.inputAssetIds)];
    if (uniqueAssetIds.length) {
      const owned = await deps.assets.findOwned(user.userId, uniqueAssetIds);
      const ready = owned.filter((a) => a.status === "uploaded");
      if (ready.length !== uniqueAssetIds.length) {
        // Same answer for missing, foreign or not-yet-uploaded: no id enumeration.
        return apiError(422, "invalid_input_assets", "One or more input assets are unavailable.");
      }
    }

    const hash = requestHash({ ...input, inputAssetIds: uniqueAssetIds });
    const { job, created } = await deps.jobs.createIdempotent({
      ownerId: user.userId, projectId: input.projectId, capability: input.capability, providerId: input.providerId,
      modelId: input.modelId, inputAssetIds: uniqueAssetIds, parameters: input.parameters,
      idempotencyKey: input.idempotencyKey, requestHash: hash
    });
    if (!created && job.requestHash !== hash) {
      return apiError(409, "idempotency_conflict", "This idempotency key was already used with different parameters.");
    }
    return json(created ? 201 : 200, { job: publicJob(job), duplicate: !created });
  } catch (error) {
    return internalError(error);
  }
}

export async function getJobs(request: Request, deps: ApiDeps): Promise<Response> {
  try {
    const user = await authenticate(request, deps.verifyToken);
    if (!user) return unauthorized();
    const limit = Math.min(Math.max(Number(new URL(request.url).searchParams.get("limit")) || 25, 1), 100);
    const jobs = await deps.jobs.listByOwner(user.userId, limit);
    return json(200, { jobs: jobs.map(publicJob) });
  } catch (error) {
    return internalError(error);
  }
}

export async function postPresign(request: Request, deps: ApiDeps): Promise<Response> {
  try {
    const user = await authenticate(request, deps.verifyToken);
    if (!user) return unauthorized();
    const body = await parseJson(request, presignSchema);
    if (!body.ok) return body.response;
    const input = body.data;
    try {
      validateUpload(input.contentType, input.size);
      const objectKey = newObjectKey(user.userId);
      const asset = await deps.assets.createPendingUpload({
        ownerId: user.userId, projectId: input.projectId, objectKey, contentType: input.contentType,
        size: input.size, originalName: input.originalName
      });
      const upload = await deps.storage.presignUpload({
        ownerId: user.userId, key: objectKey, contentType: input.contentType, size: input.size
      });
      return json(201, {
        assetId: asset.id, uploadUrl: upload.url, method: upload.method, headers: upload.headers, expiresAt: upload.expiresAt
      });
    } catch (error) {
      if (error instanceof StorageError) {
        const status = error.code === "too_large" ? 413 : 422;
        return apiError(status, error.code, error.message);
      }
      throw error;
    }
  } catch (error) {
    return internalError(error);
  }
}


const assetIdSchema = id;

/**
 * Confirms a direct-to-R2 upload: HEADs the object and requires the exact size
 * and MIME type declared at presign time. A mismatch rejects the asset and
 * deletes the object. Only then does the asset become usable (`uploaded`).
 * NOTE: this trusts R2's stored Content-Type, which the signed URL pins; it is
 * not a magic-byte inspection of the file contents.
 */
export async function postConfirmUpload(request: Request, deps: ApiDeps, assetId: string): Promise<Response> {
  try {
    const user = await authenticate(request, deps.verifyToken);
    if (!user) return unauthorized();
    if (!assetIdSchema.safeParse(assetId).success) return apiError(404, "not_found", "Asset not found.");

    const [asset] = await deps.assets.findOwned(user.userId, [assetId]);
    if (!asset) return apiError(404, "not_found", "Asset not found.");
    if (asset.status === "uploaded") return json(200, { asset: { id: asset.id, status: "uploaded" } });
    if (asset.status === "rejected") return apiError(409, "asset_rejected", "This upload was rejected. Request a new upload.");

    const head = await deps.storage.headObject({ ownerId: user.userId, key: asset.objectKey });
    if (!head) return apiError(409, "upload_not_found", "No uploaded file found yet. Upload to the signed URL, then confirm.");

    const typeMatches = (head.contentType ?? "").toLowerCase() === asset.contentType.toLowerCase();
    if (head.size !== asset.size || !typeMatches) {
      await deps.assets.setStatus(asset.id, "rejected");
      await deps.storage.deleteObject({ ownerId: user.userId, key: asset.objectKey });
      return apiError(422, "upload_mismatch", "The uploaded file does not match the declared size or type and was removed.");
    }

    await deps.assets.setStatus(asset.id, "uploaded");
    return json(200, { asset: { id: asset.id, status: "uploaded", contentType: asset.contentType, size: asset.size } });
  } catch (error) {
    return internalError(error);
  }
}
