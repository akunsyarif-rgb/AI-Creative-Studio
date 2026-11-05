import type { Capability, JobStatus } from "@/lib/providers/types";

export interface JobRecord {
  id: string;
  ownerId: string;
  projectId: string;
  capability: Capability;
  providerId: string;
  modelId: string;
  status: JobStatus;
  inputAssetIds: string[];
  parameters: Record<string, unknown>;
  idempotencyKey: string;
  requestHash: string;
  progress: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  outputAssetIds: string[];
  estimatedCost: number | null;
  currency: string | null;
  createdAt: string;
}

export type NewJob = Pick<
  JobRecord,
  "ownerId" | "projectId" | "capability" | "providerId" | "modelId" | "inputAssetIds" | "parameters" | "idempotencyKey" | "requestHash"
> & { estimatedCost?: number; currency?: string };

export interface JobPatch {
  status?: JobStatus;
  progress?: number;
  errorCode?: string;
  errorMessage?: string;
  outputAssetIds?: string[];
}

export interface JobsRepository {
  /** Atomic: the same (owner, idempotencyKey) can only ever create one job. */
  createIdempotent(job: NewJob): Promise<{ job: JobRecord; created: boolean }>;
  /** Newest first. `cursor` is the id of the last job of the previous page. */
  listByOwner(ownerId: string, limit: number, cursor?: string): Promise<{ jobs: JobRecord[]; nextCursor: string | null }>;
  getOwned(ownerId: string, id: string): Promise<JobRecord | null>;
  /** Server-side only. Callers must validate the transition with `canTransitionJob`. */
  update(id: string, patch: JobPatch): Promise<void>;
}

export interface AssetRecord {
  id: string;
  ownerId: string;
  objectKey: string;
  contentType: string;
  size: number;
  status: "pending" | "uploaded" | "rejected";
}

export interface AssetsRepository {
  createPendingUpload(input: {
    ownerId: string;
    projectId?: string;
    objectKey: string;
    contentType: string;
    size: number;
    originalName?: string;
  }): Promise<AssetRecord>;
  /** Records a server-generated output (already stored in R2) as an `uploaded` asset. */
  createGenerated(input: {
    ownerId: string;
    projectId?: string;
    objectKey: string;
    contentType: string;
    size: number;
    sourceJobId: string;
    parentAssetId?: string;
  }): Promise<AssetRecord>;
  /** Returns only assets owned by `ownerId`; callers compare counts to detect foreign/missing ids. */
  findOwned(ownerId: string, ids: string[]): Promise<AssetRecord[]>;
  setStatus(id: string, status: AssetRecord["status"]): Promise<void>;
}

/** Public metadata only. Ciphertext never leaves the repository layer except via `getCiphertext`. */
export interface KeyMetadata {
  providerId: string;
  last4: string | null;
  validationStatus: "unvalidated" | "valid" | "invalid";
  createdAt: string;
  updatedAt: string;
}

export interface KeysRepository {
  /** Atomic; returns null if a key for this provider already exists. */
  create(input: { ownerId: string; providerId: string; ciphertext: string; keyId: string; last4: string | null }): Promise<KeyMetadata | null>;
  /** Returns null if no key exists. */
  replace(input: { ownerId: string; providerId: string; ciphertext: string; keyId: string; last4: string | null }): Promise<KeyMetadata | null>;
  get(ownerId: string, providerId: string): Promise<KeyMetadata | null>;
  /** Only for server-side execution: returns the encrypted secret. Never expose in responses. */
  getCiphertext(ownerId: string, providerId: string): Promise<string | null>;
  setValidation(ownerId: string, providerId: string, status: "valid" | "invalid"): Promise<boolean>;
  list(ownerId: string): Promise<KeyMetadata[]>;
  delete(ownerId: string, providerId: string): Promise<boolean>;
}
