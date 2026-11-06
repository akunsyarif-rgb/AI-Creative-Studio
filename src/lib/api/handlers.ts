import { createHash } from "node:crypto";
import { z } from "zod";
import { authenticate, type TokenVerifier } from "@/lib/auth/session";
import type { AssetsRepository, CustomProviderConfig, JobRecord, JobsRepository, KeysRepository } from "@/lib/data/repositories";
import { CAPABILITIES } from "@/lib/providers/types";
import { SNIFF_BYTES, sniffMime } from "@/lib/storage/sniff";
import { StorageError, newObjectKey, validateUpload, type ObjectStorage } from "@/lib/storage/r2";
import type { ProviderRegistry } from "@/lib/providers/registry";
import { adapterSupports, resolveAdapter } from "@/lib/providers/resolve";
import type { Lookup } from "@/lib/net/public-url";
import { ProviderError, type ProviderAdapter } from "@/lib/providers/types";
import { credentialContext } from "@/lib/security/credential-context";
import { executeJob, reconcileJob, type ExecuteDeps } from "@/lib/jobs/execute";
import { apiError, internalError, json, parseJson, unauthorized } from "./http";
import { enforceRate, type RateLimiter } from "./rate-limit";

/** Encrypts provider credentials. The default implementation wraps `security/secrets.ts`. */
export interface CredentialVault {
  encrypt(plaintext: string, context: string): Promise<string>;
  decrypt(ciphertext: string, context: string): Promise<string>;
}

/** Runs work after the response is sent. Not durable: see README limitations. */
export interface Scheduler {
  run(task: () => Promise<void>): void;
}

export interface ApiDeps {
  keys: KeysRepository;
  vault: CredentialVault;
  limiter: RateLimiter;
  scheduler: Scheduler;
  /** Hard per-job spend ceiling in USD. Jobs estimated above it are refused. */
  maxJobCostUsd: number;
  verifyToken: TokenVerifier;
  jobs: JobsRepository;
  assets: AssetsRepository;
  storage: ObjectStorage;
  /** Source of truth for available providers/models/capabilities. */
  providers: ProviderRegistry;
  /** Builds the adapter for a user's custom (OpenAI-compatible) provider. */
  buildCustomAdapter: (config: CustomProviderConfig) => ProviderAdapter;
  /** DNS lookup override (tests). Defaults to the system resolver. */
  lookup?: Lookup;
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
  idempotencyKey: z.string().min(8).max(128).regex(/^[\w.:-]+$/, "Invalid idempotency key"),
  /** Explicit consent to spend up to this many USD. Required for paid models; not part of the request hash. */
  confirmedMaxCostUsd: z.number().positive().max(1000).optional(),
  /** Consent for a request whose price is unknown (custom provider without an estimate). Never remembered. */
  confirmUnknownCost: z.boolean().optional()
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

function publicJob(job: JobRecord) {
  return {
    id: job.id, projectId: job.projectId, capability: job.capability, providerId: job.providerId, modelId: job.modelId,
    status: job.status, inputAssetIds: job.inputAssetIds, outputAssetIds: job.outputAssetIds, progress: job.progress,
    errorCode: job.errorCode, errorMessage: job.errorMessage,
    prompt: typeof job.parameters.prompt === "string" ? job.parameters.prompt.slice(0, 300) : null,
    estimatedCost: job.estimatedCost === null ? null : { amount: job.estimatedCost, currency: job.currency, isEstimate: true },
    createdAt: job.createdAt
  };
}

export async function postJob(request: Request, deps: ApiDeps): Promise<Response> {
  try {
    const user = await authenticate(request, deps.verifyToken);
    if (!user) return unauthorized();
    const limited = enforceRate(deps.limiter, "jobs", user.userId);
    if (limited) return limited;
    const body = await parseJson(request, createJobSchema);
    if (!body.ok) return body.response;
    const { confirmedMaxCostUsd, confirmUnknownCost, ...input } = body.data;

    // Fail closed: unknown provider/model/capability => nothing is persisted or submitted.
    const adapter = await resolveAdapter(deps, user.userId, input.providerId);
    if (!adapter || !adapterSupports(adapter, input.modelId, input.capability)) {
      return apiError(422, "unsupported_capability", "This provider/model does not support the requested capability.");
    }

    const uniqueAssetIds = [...new Set(input.inputAssetIds)];
    const jobRequest = {
      capability: input.capability, modelId: input.modelId, inputAssetIds: uniqueAssetIds, parameters: input.parameters
    };
    try {
      adapter.validateRequest(jobRequest);
    } catch (error) {
      if (error instanceof ProviderError) return apiError(422, "invalid_parameters", error.message);
      throw error;
    }

    if (uniqueAssetIds.length) {
      const owned = await deps.assets.findOwned(user.userId, uniqueAssetIds);
      const ready = owned.filter((a) => a.status === "uploaded");
      if (ready.length !== uniqueAssetIds.length) {
        // Same answer for missing, foreign or not-yet-uploaded: no id enumeration.
        return apiError(422, "invalid_input_assets", "One or more input assets are unavailable.");
      }
    }

    if (!(await deps.keys.get(user.userId, input.providerId))) {
      return apiError(422, "provider_key_missing", "Add an API key for this provider first.");
    }

    // Cost disclosure and consent: never spend silently, never exceed the ceiling.
    const estimate = await adapter.estimateCost(jobRequest);
    let knownCost: number | null = null;
    if (estimate) {
      if (estimate.amount === null) {
        // Price unknown: the spend ceiling cannot be applied, so require explicit consent for every request.
        if (confirmUnknownCost !== true) {
          return apiError(409, "cost_confirmation_required", "The price of this request is unknown. Confirm to continue; the provider will charge its own price.", { estimate });
        }
      } else {
        if (estimate.amount > deps.maxJobCostUsd) {
          return apiError(422, "budget_exceeded", `Estimated cost exceeds the per-job limit of ${deps.maxJobCostUsd} ${estimate.currency}.`, { estimate });
        }
        if (confirmedMaxCostUsd === undefined || confirmedMaxCostUsd < estimate.amount) {
          return apiError(409, "cost_confirmation_required", "This is a paid request. Confirm the estimated cost to continue.", { estimate });
        }
        knownCost = estimate.amount;
      }
    }

    const hash = requestHash({ ...input, inputAssetIds: uniqueAssetIds });
    const { job, created } = await deps.jobs.createIdempotent({
      ownerId: user.userId, projectId: input.projectId, capability: input.capability, providerId: input.providerId,
      modelId: input.modelId, inputAssetIds: uniqueAssetIds, parameters: input.parameters,
      idempotencyKey: input.idempotencyKey, requestHash: hash,
      ...(estimate && knownCost !== null ? { estimatedCost: knownCost, currency: estimate.currency } : {})
    });
    if (!created && job.requestHash !== hash) {
      return apiError(409, "idempotency_conflict", "This idempotency key was already used with different parameters.");
    }
    // Only the request that created the job may execute it; duplicates never re-submit.
    if (created) {
      deps.scheduler.run(() => executeJob(executeDepsOf(deps), job));
    }
    return json(created ? 202 : 200, { job: publicJob(job), duplicate: !created });
  } catch (error) {
    return internalError(error);
  }
}

function executeDepsOf(deps: ApiDeps): ExecuteDeps {
  return {
    jobs: deps.jobs, assets: deps.assets, keys: deps.keys, storage: deps.storage, vault: deps.vault,
    resolveAdapter: (ownerId, providerId) => resolveAdapter(deps, ownerId, providerId)
  };
}

export async function getJobById(request: Request, deps: ApiDeps, jobId: string): Promise<Response> {
  try {
    const user = await authenticate(request, deps.verifyToken);
    if (!user) return unauthorized();
    if (!id.safeParse(jobId).success) return apiError(404, "not_found", "Job not found.");
    let job = await deps.jobs.getOwned(user.userId, jobId);
    // A running long task (video) is collected here: looking at the job is what moves it forward. Read-only and free.
    if (job?.status === "processing" && job.providerJobId) job = await reconcileJob(executeDepsOf(deps), job);
    return job ? json(200, { job: publicJob(job) }) : apiError(404, "not_found", "Job not found.");
  } catch (error) {
    return internalError(error);
  }
}

/** Authorized, short-lived download link for one of the caller's uploaded/generated assets. */
export async function getAssetDownload(request: Request, deps: ApiDeps, assetId: string): Promise<Response> {
  try {
    const user = await authenticate(request, deps.verifyToken);
    if (!user) return unauthorized();
    const limited = enforceRate(deps.limiter, "assetRead", user.userId);
    if (limited) return limited;
    if (!id.safeParse(assetId).success) return apiError(404, "not_found", "Asset not found.");
    const [asset] = await deps.assets.findOwned(user.userId, [assetId]);
    if (!asset || asset.status !== "uploaded") return apiError(404, "not_found", "Asset not found.");
    // `?download=1` makes the browser save the file instead of displaying it.
    const asAttachment = new URL(request.url).searchParams.get("download") === "1";
    const ext = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm" }[asset.contentType] ?? "bin";
    const download = await deps.storage.presignDownload({
      ownerId: user.userId, key: asset.objectKey, ...(asAttachment ? { filename: `studio-${asset.id.slice(0, 12)}.${ext}` } : {})
    });
    return json(200, { asset: { id: asset.id, contentType: asset.contentType, size: asset.size }, download });
  } catch (error) {
    return internalError(error);
  }
}

/** Lists built-in providers plus the caller's own custom providers, with their models/parameters (non-secret). */
export async function getProviders(request: Request, deps: ApiDeps): Promise<Response> {
  try {
    const user = await authenticate(request, deps.verifyToken);
    if (!user) return unauthorized();
    const customConfigs = (await deps.keys.listCustom(user.userId)).map((c) => deps.buildCustomAdapter(c).config);
    const view = (c: (typeof customConfigs)[number], custom: boolean) => ({
      id: c.id,
      name: c.name,
      description: c.description ?? null,
      custom,
      models: c.availableModels.map((m) => ({
        modelId: m.modelId,
        displayName: m.displayName,
        capabilities: m.capabilities,
        isFreeTier: m.isFreeTier ?? false,
        parameters: m.parameters ?? []
      }))
    });
    const providers = [...deps.providers.configs().map((c) => view(c, false)), ...customConfigs.map((c) => view(c, true))];
    return json(200, { providers });
  } catch (error) {
    return internalError(error);
  }
}

/** Validates the saved BYOK against the real provider API and records the result. */
export async function postProviderTest(request: Request, deps: ApiDeps, providerId: string): Promise<Response> {
  try {
    const user = await authenticate(request, deps.verifyToken);
    if (!user) return unauthorized();
    const limited = enforceRate(deps.limiter, "providerTest", user.userId);
    if (limited) return limited;
    const adapter = /^[a-z0-9][a-z0-9_-]{1,63}$/.test(providerId) ? await resolveAdapter(deps, user.userId, providerId) : undefined;
    if (!adapter) return apiError(404, "not_found", "Provider not found.");

    const ciphertext = await deps.keys.getCiphertext(user.userId, providerId);
    if (!ciphertext) return apiError(404, "key_not_found", "No API key saved for this provider.");

    let secret: string;
    try {
      secret = await deps.vault.decrypt(ciphertext, credentialContext(user.userId, providerId));
    } catch {
      return apiError(500, "credential_error", "The saved API key could not be decrypted. Re-save it.");
    }

    try {
      const result = await adapter.testKey(secret);
      const validationStatus = result.valid ? "valid" : "invalid";
      await deps.keys.setValidation(user.userId, providerId, validationStatus);
      return json(200, { validationStatus, ...(result.message ? { message: result.message } : {}) });
    } catch (error) {
      // Provider unreachable / rate limited: the key's status is unknown, so leave it unchanged.
      if (error instanceof ProviderError) return apiError(502, "provider_unreachable", error.message);
      throw error;
    }
  } catch (error) {
    return internalError(error);
  }
}

export async function getJobs(request: Request, deps: ApiDeps): Promise<Response> {
  try {
    const user = await authenticate(request, deps.verifyToken);
    if (!user) return unauthorized();
    const params = new URL(request.url).searchParams;
    const limit = Math.min(Math.max(Number(params.get("limit")) || 25, 1), 100);
    const cursor = params.get("cursor") ?? undefined;
    if (cursor !== undefined && !id.safeParse(cursor).success) return apiError(400, "invalid_cursor", "Invalid cursor.");
    const { jobs, nextCursor } = await deps.jobs.listByOwner(user.userId, limit, cursor);
    return json(200, { jobs: jobs.map(publicJob), nextCursor });
  } catch (error) {
    return internalError(error);
  }
}

export async function postPresign(request: Request, deps: ApiDeps): Promise<Response> {
  try {
    const user = await authenticate(request, deps.verifyToken);
    if (!user) return unauthorized();
    const limited = enforceRate(deps.limiter, "uploads", user.userId);
    if (limited) return limited;
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
    const limited = enforceRate(deps.limiter, "uploads", user.userId);
    if (limited) return limited;
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

    // Content-Type is client-declared (and signed), so also inspect the real bytes.
    const start = await deps.storage.readObject({ ownerId: user.userId, key: asset.objectKey, bytes: SNIFF_BYTES });
    if (sniffMime(start) !== asset.contentType.toLowerCase()) {
      await deps.assets.setStatus(asset.id, "rejected");
      await deps.storage.deleteObject({ ownerId: user.userId, key: asset.objectKey });
      return apiError(422, "upload_content_mismatch", "The file contents do not match the declared type and were removed.");
    }

    await deps.assets.setStatus(asset.id, "uploaded");
    return json(200, { asset: { id: asset.id, status: "uploaded", contentType: asset.contentType, size: asset.size } });
  } catch (error) {
    return internalError(error);
  }
}
