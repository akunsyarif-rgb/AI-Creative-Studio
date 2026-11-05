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
}
