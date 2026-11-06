import type { AssetsRepository, JobRecord, JobPatch, JobsRepository, KeysRepository } from "@/lib/data/repositories";
import { canTransitionJob } from "@/lib/jobs/states";
import { adapterSupports } from "@/lib/providers/resolve";
import { ProviderError, type JobStatus, type ProviderAdapter, type ProviderFile } from "@/lib/providers/types";
import { credentialContext } from "@/lib/security/credential-context";
import { sniffMime } from "@/lib/storage/sniff";
import { StorageError, newObjectKey, validateUpload, type ObjectStorage } from "@/lib/storage/r2";

export interface ExecuteDeps {
  jobs: JobsRepository;
  assets: AssetsRepository;
  keys: KeysRepository;
  storage: ObjectStorage;
  vault: { decrypt(ciphertext: string, context: string): Promise<string> };
  /** Adapters are resolved per job from `job.providerId`; nothing here is provider-specific. */
  resolveAdapter(ownerId: string, providerId: string): Promise<ProviderAdapter | undefined>;
}

class Fail extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

const UNKNOWN_OUTCOME_NOTE = " It may have been billed by the provider; check your provider usage. It was not retried automatically.";

type Output = { contentType: string; data: Uint8Array };

/** Validates provider output (real bytes, size, type) and stores it as generated assets. Throws `Fail`. */
async function storeOutputs(deps: ExecuteDeps, job: JobRecord, outputs: Output[]): Promise<string[]> {
  if (!outputs.length) throw new Fail("invalid_output", "The provider returned no output.");
  for (const file of outputs) {
    try {
      validateUpload(file.contentType, file.data.length);
    } catch (error) {
      if (error instanceof StorageError) throw new Fail("invalid_output", "The provider output was not an accepted file.");
      throw error;
    }
    if (sniffMime(file.data) !== file.contentType) throw new Fail("invalid_output", "The provider output did not match its type.");
  }
  const outputAssetIds: string[] = [];
  for (const file of outputs) {
    const objectKey = newObjectKey(job.ownerId);
    await deps.storage.putObject({ ownerId: job.ownerId, key: objectKey, contentType: file.contentType, data: file.data });
    const asset = await deps.assets.createGenerated({
      ownerId: job.ownerId, projectId: job.projectId, objectKey, contentType: file.contentType, size: file.data.length,
      sourceJobId: job.id, parentAssetId: job.inputAssetIds[0]
    });
    outputAssetIds.push(asset.id);
  }
  return outputAssetIds;
}

/** Decrypts the owner's saved key for a job's provider. Throws `Fail`. */
async function loadSecret(deps: ExecuteDeps, job: JobRecord): Promise<string> {
  const ciphertext = await deps.keys.getCiphertext(job.ownerId, job.providerId);
  if (!ciphertext) throw new Fail("provider_key_missing", "No API key is saved for this provider.");
  try {
    return await deps.vault.decrypt(ciphertext, credentialContext(job.ownerId, job.providerId));
  } catch {
    throw new Fail("credential_error", "The saved API key could not be decrypted. Re-save it.");
  }
}

/**
 * Runs one job end to end: queued -> submitted -> validating -> completed|failed.
 *
 * Safety rules:
 *  - The state is persisted as `submitted` BEFORE the billable call.
 *  - The provider call is made at most once. There is no retry here; a failed
 *    or timed-out call whose outcome is unknown is surfaced to the user rather
 *    than repeated, because repeating could double-bill.
 *  - Output is validated (real bytes, size, type) before `completed`.
 *  - The BYOK secret lives only in this function's scope and is never logged.
 */
export async function executeJob(deps: ExecuteDeps, job: JobRecord): Promise<void> {
  let status: JobStatus = job.status;

  const move = async (to: JobStatus, patch: JobPatch = {}) => {
    if (!canTransitionJob(status, to)) throw new Error(`Illegal job transition ${status} -> ${to}`);
    await deps.jobs.update(job.id, { ...patch, status: to });
    status = to;
  };

  const fail = async (code: string, message: string) => {
    if (canTransitionJob(status, "failed")) await move("failed", { errorCode: code, errorMessage: message.slice(0, 256) });
  };

  try {
    const adapter = await deps.resolveAdapter(job.ownerId, job.providerId);
    if (!adapter || !adapterSupports(adapter, job.modelId, job.capability)) throw new Fail("unsupported_provider", "This provider is not available.");

    const secret = await loadSecret(deps, job);

    const inputFiles: ProviderFile[] = [];
    if (job.inputAssetIds.length) {
      const owned = await deps.assets.findOwned(job.ownerId, job.inputAssetIds);
      if (owned.length !== job.inputAssetIds.length || owned.some((a) => a.status !== "uploaded")) {
        throw new Fail("invalid_input_assets", "An input asset is unavailable.");
      }
      for (const asset of owned) {
        const data = await deps.storage.readObject({ ownerId: job.ownerId, key: asset.objectKey });
        inputFiles.push({ contentType: asset.contentType, data });
      }
    }

    const request = {
      capability: job.capability, modelId: job.modelId, inputAssetIds: job.inputAssetIds, parameters: job.parameters
    };
    adapter.validateRequest(request);

    // Persist before dispatch.
    await move("submitted", { progress: 10 });

    let result;
    try {
      result = await adapter.executeJob(request, job.idempotencyKey, { secret, inputFiles });
    } catch (error) {
      if (error instanceof ProviderError) {
        const note = error.outcomeKnown ? "" : UNKNOWN_OUTCOME_NOTE;
        await fail(error.outcomeKnown ? `provider_${error.code}` : "outcome_unknown", error.message + note);
        return;
      }
      await fail("outcome_unknown", `The provider call failed unexpectedly.${UNKNOWN_OUTCOME_NOTE}`);
      return;
    }

    // A long-running task (video): the provider accepted it. Save its id and stop; the result is collected later
    // by `reconcileJob`, so nothing depends on this request staying alive and nothing is ever submitted twice.
    if (result.status === "processing") {
      if (!result.providerJobId) {
        await fail("outcome_unknown", `The provider accepted the request but returned no task id.${UNKNOWN_OUTCOME_NOTE}`);
        return;
      }
      await move("processing", { progress: result.progress ?? 15, providerJobId: result.providerJobId });
      return;
    }

    await move("validating", { progress: 80, ...(result.providerJobId ? { providerJobId: result.providerJobId } : {}) });
    const outputAssetIds = await storeOutputs(deps, job, result.outputFiles ?? []);
    await move("completed", { progress: 100, outputAssetIds });
  } catch (error) {
    if (error instanceof Fail) {
      await fail(error.code, error.message).catch(() => undefined);
    } else if (error instanceof ProviderError) {
      await fail(`provider_${error.code}`, error.message).catch(() => undefined);
    } else {
      // Log the error name only; messages can carry secrets or provider payloads.
      console.error("job_execution_error", error instanceof Error ? error.name : "unknown");
      const billed = status === "submitted" || status === "validating";
      await fail("internal_error", `Something went wrong.${billed ? UNKNOWN_OUTCOME_NOTE : ""}`).catch(() => undefined);
    }
  }
}

/** Best-effort guard against two requests finishing the same job at once (one serverless instance). */
const reconciling = new Set<string>();
const lastChecked = new Map<string, number>();
const MIN_CHECK_INTERVAL_MS = 3000;

/**
 * Collects the result of a long-running (video) job whose provider task was already accepted. Safe to call as
 * often as you like: it only READS the provider's task (free), never creates one. Returns the job's latest state.
 * Call it from whatever the user is looking at (status endpoint, library); a closed tab loses nothing.
 */
export async function reconcileJob(deps: ExecuteDeps, job: JobRecord, now: () => number = Date.now): Promise<JobRecord> {
  if (job.status !== "processing" || !job.providerJobId) return job;
  if (reconciling.has(job.id) || now() - (lastChecked.get(job.id) ?? 0) < MIN_CHECK_INTERVAL_MS) return job;
  reconciling.add(job.id);
  lastChecked.set(job.id, now());
  const providerJobId = job.providerJobId;
  let status = "processing" as JobStatus; // widened: it changes inside the closures below
  const move = async (to: JobStatus, patch: JobPatch = {}) => {
    if (!canTransitionJob(status, to)) throw new Error(`Illegal job transition ${status} -> ${to}`);
    await deps.jobs.update(job.id, { ...patch, status: to });
    status = to;
  };
  const fail = async (code: string, message: string) => {
    if (canTransitionJob(status, "failed")) await move("failed", { errorCode: code, errorMessage: message.slice(0, 256) });
  };
  try {
    const adapter = await deps.resolveAdapter(job.ownerId, job.providerId);
    if (!adapter?.getJobStatus) throw new Fail("unsupported_provider", "This provider cannot report on running tasks.");
    const secret = await loadSecret(deps, job);
    let result;
    try {
      result = await adapter.getJobStatus(providerJobId, secret);
    } catch (error) {
      if (error instanceof ProviderError) {
        // The provider says the task ended without a result (failed / expired / refused).
        await fail(error.outcomeKnown ? `provider_${error.code}` : "outcome_unknown", error.message + (error.outcomeKnown ? "" : UNKNOWN_OUTCOME_NOTE));
        return (await deps.jobs.getOwned(job.ownerId, job.id)) ?? job;
      }
      throw error;
    }
    if (result.status === "processing" || !result.outputFiles?.length) {
      if (result.progress !== undefined && result.progress !== job.progress) await deps.jobs.update(job.id, { progress: result.progress });
    } else {
      await move("validating", { progress: 90 });
      const outputAssetIds = await storeOutputs(deps, job, result.outputFiles);
      await move("completed", { progress: 100, outputAssetIds });
    }
  } catch (error) {
    if (error instanceof Fail) {
      await fail(error.code, error.message).catch(() => undefined);
    } else {
      // Transient (network, storage): leave the job as it was; the next check tries again. Names only, no payloads.
      console.error("job_reconcile_error", error instanceof Error ? error.name : "unknown");
      if (status === "validating") await fail("internal_error", "Something went wrong while saving the result. The task may have been billed; check your provider usage.").catch(() => undefined);
    }
  } finally {
    reconciling.delete(job.id);
  }
  return (await deps.jobs.getOwned(job.ownerId, job.id)) ?? job;
}
