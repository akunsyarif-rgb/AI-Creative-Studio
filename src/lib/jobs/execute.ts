import type { AssetsRepository, JobRecord, JobPatch, JobsRepository, KeysRepository } from "@/lib/data/repositories";
import { canTransitionJob } from "@/lib/jobs/states";
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
  adapter(providerId: string): ProviderAdapter | undefined;
}

class Fail extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

const UNKNOWN_OUTCOME_NOTE = " It may have been billed by the provider; check your provider usage. It was not retried automatically.";

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
    const adapter = deps.adapter(job.providerId);
    if (!adapter) throw new Fail("unsupported_provider", "This provider is not available.");

    const ciphertext = await deps.keys.getCiphertext(job.ownerId, job.providerId);
    if (!ciphertext) throw new Fail("provider_key_missing", "No API key is saved for this provider.");

    let secret: string;
    try {
      secret = await deps.vault.decrypt(ciphertext, credentialContext(job.ownerId, job.providerId));
    } catch {
      throw new Fail("credential_error", "The saved API key could not be decrypted. Re-save it.");
    }

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
      result = await adapter.submitJob(request, job.idempotencyKey, { secret, inputFiles });
    } catch (error) {
      if (error instanceof ProviderError) {
        const note = error.outcomeKnown ? "" : UNKNOWN_OUTCOME_NOTE;
        await fail(error.outcomeKnown ? `provider_${error.code}` : "outcome_unknown", error.message + note);
        return;
      }
      await fail("outcome_unknown", `The provider call failed unexpectedly.${UNKNOWN_OUTCOME_NOTE}`);
      return;
    }

    await move("validating", { progress: 80 });

    const outputs = result.outputFiles ?? [];
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
