import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { AppwriteException, Query, type Models } from "node-appwrite";
import { adminDatabases } from "@/lib/appwrite/server";
import { COLLECTIONS, documentPermissions } from "@/lib/appwrite/schema";
import type { AssetRecord, AssetsRepository, JobRecord, JobsRepository, NewJob } from "./repositories";

/** Deterministic id => duplicate (owner, idempotencyKey) hits Appwrite's 409, atomically. */
export function jobDocumentId(ownerId: string, idempotencyKey: string): string {
  return createHash("sha256").update(`${ownerId}\0${idempotencyKey}`).digest("hex").slice(0, 36);
}

type JobDoc = Models.Document & {
  ownerId: string; projectId: string; capability: JobRecord["capability"]; providerId: string; modelId: string;
  status: JobRecord["status"]; inputAssetIds?: string[]; parameters: string; idempotencyKey: string; requestHash: string;
  progress?: number | null; errorCode?: string | null; estimatedCost?: number | null; currency?: string | null;
};

function toJob(d: JobDoc): JobRecord {
  return {
    id: d.$id, ownerId: d.ownerId, projectId: d.projectId, capability: d.capability, providerId: d.providerId,
    modelId: d.modelId, status: d.status, inputAssetIds: d.inputAssetIds ?? [], parameters: JSON.parse(d.parameters),
    idempotencyKey: d.idempotencyKey, requestHash: d.requestHash, progress: d.progress ?? null,
    errorCode: d.errorCode ?? null, estimatedCost: d.estimatedCost ?? null, currency: d.currency ?? null,
    createdAt: d.$createdAt
  };
}

export function appwriteJobsRepository(): JobsRepository {
  const { databases, databaseId } = adminDatabases();
  const collectionId = COLLECTIONS.jobs;
  return {
    async createIdempotent(job: NewJob) {
      const documentId = jobDocumentId(job.ownerId, job.idempotencyKey);
      try {
        const doc = await databases.createDocument<JobDoc>({
          databaseId, collectionId, documentId,
          data: { ...job, parameters: JSON.stringify(job.parameters), status: "queued" },
          permissions: documentPermissions("jobs", job.ownerId)
        });
        return { job: toJob(doc), created: true };
      } catch (error) {
        if (error instanceof AppwriteException && error.code === 409) {
          const existing = await databases.getDocument<JobDoc>({ databaseId, collectionId, documentId });
          if (existing.ownerId !== job.ownerId) throw error; // cannot happen: id is owner-derived
          return { job: toJob(existing), created: false };
        }
        throw error;
      }
    },
    async listByOwner(ownerId, limit) {
      const res = await databases.listDocuments<JobDoc>({
        databaseId, collectionId,
        queries: [Query.equal("ownerId", ownerId), Query.orderDesc("$createdAt"), Query.limit(limit)]
      });
      return res.documents.map(toJob);
    }
  };
}

type AssetDoc = Models.Document & Omit<AssetRecord, "id"> & { origin?: "upload" | "generated" };

const toAsset = (d: AssetDoc): AssetRecord => ({
  id: d.$id, ownerId: d.ownerId, objectKey: d.objectKey, contentType: d.contentType, size: d.size, status: d.status
});

export function appwriteAssetsRepository(): AssetsRepository {
  const { databases, databaseId } = adminDatabases();
  const collectionId = COLLECTIONS.metadata;
  return {
    async createPendingUpload(input) {
      const doc = await databases.createDocument<AssetDoc>({
        databaseId, collectionId, documentId: randomUUID(),
        data: { ...input, status: "pending", origin: "upload" },
        permissions: documentPermissions("metadata", input.ownerId)
      });
      return toAsset(doc);
    },
    async findOwned(ownerId, ids) {
      if (!ids.length) return [];
      const res = await databases.listDocuments<AssetDoc>({
        databaseId, collectionId,
        queries: [Query.equal("$id", ids), Query.equal("ownerId", ownerId), Query.limit(ids.length)]
      });
      return res.documents.map(toAsset);
    }
  };
}
