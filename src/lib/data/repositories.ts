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
  estimatedCost: number | null;
  currency: string | null;
  createdAt: string;
}

export type NewJob = Pick<
  JobRecord,
  "ownerId" | "projectId" | "capability" | "providerId" | "modelId" | "inputAssetIds" | "parameters" | "idempotencyKey" | "requestHash"
>;

export interface JobsRepository {
  /** Atomic: the same (owner, idempotencyKey) can only ever create one job. */
  createIdempotent(job: NewJob): Promise<{ job: JobRecord; created: boolean }>;
  listByOwner(ownerId: string, limit: number): Promise<JobRecord[]>;
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
  list(ownerId: string): Promise<KeyMetadata[]>;
  delete(ownerId: string, providerId: string): Promise<boolean>;
}
