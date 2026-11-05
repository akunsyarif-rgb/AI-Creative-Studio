import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { AppwriteException, Query, type Models } from "node-appwrite";
import { adminDatabases } from "@/lib/appwrite/server";
import { COLLECTIONS, documentPermissions } from "@/lib/appwrite/schema";
import type { AssetRecord, AssetsRepository, JobPatch, JobRecord, JobsRepository, KeyMetadata, KeysRepository, NewJob } from "./repositories";

/** Deterministic id => duplicate (owner, idempotencyKey) hits Appwrite's 409, atomically. */
export function jobDocumentId(ownerId: string, idempotencyKey: string): string {
  return createHash("sha256").update(`${ownerId}\0${idempotencyKey}`).digest("hex").slice(0, 36);
}

type JobDoc = Models.Document & {
  ownerId: string; projectId: string; capability: JobRecord["capability"]; providerId: string; modelId: string;
  status: JobRecord["status"]; inputAssetIds?: string[]; parameters: string; idempotencyKey: string; requestHash: string;
  progress?: number | null; errorCode?: string | null; errorMessage?: string | null; outputAssetIds?: string[]; estimatedCost?: number | null; currency?: string | null;
};

function toJob(d: JobDoc): JobRecord {
  return {
    id: d.$id, ownerId: d.ownerId, projectId: d.projectId, capability: d.capability, providerId: d.providerId,
    modelId: d.modelId, status: d.status, inputAssetIds: d.inputAssetIds ?? [], parameters: JSON.parse(d.parameters),
    idempotencyKey: d.idempotencyKey, requestHash: d.requestHash, progress: d.progress ?? null,
    errorCode: d.errorCode ?? null, errorMessage: d.errorMessage ?? null,
    outputAssetIds: d.outputAssetIds ?? [], estimatedCost: d.estimatedCost ?? null, currency: d.currency ?? null,
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
          data: { ...job, parameters: JSON.stringify(job.parameters), status: "queued", ...(job.estimatedCost === undefined ? {} : { currency: job.currency ?? "USD" }) },
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
    async getOwned(ownerId, id) {
      try {
        const doc = await databases.getDocument<JobDoc>({ databaseId, collectionId, documentId: id });
        return doc.ownerId === ownerId ? toJob(doc) : null;
      } catch (error) {
        if (error instanceof AppwriteException && error.code === 404) return null;
        throw error;
      }
    },
    async update(id: string, patch: JobPatch) {
      await databases.updateDocument({ databaseId, collectionId, documentId: id, data: { ...patch } });
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

type AssetDoc = Models.Document & Omit<AssetRecord, "id"> & { origin?: "upload" | "generated"; sourceJobId?: string; parentAssetId?: string };

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
    },
    async createGenerated({ ownerId, projectId, ...rest }) {
      const doc = await databases.createDocument<AssetDoc>({
        databaseId, collectionId, documentId: randomUUID(),
        data: { ownerId, ...(projectId ? { projectId } : {}), ...rest, status: "uploaded", origin: "generated" },
        permissions: documentPermissions("metadata", ownerId)
      });
      return toAsset(doc);
    },
    async setStatus(id, status) {
      await databases.updateDocument({ databaseId, collectionId, documentId: id, data: { status } });
    }
  };
}

type KeyDoc = Models.Document & { ownerId?: string; validatedAt?: string | null; providerId: string; last4?: string | null; validationStatus: KeyMetadata["validationStatus"] };

const toKeyMeta = (d: KeyDoc): KeyMetadata => ({
  providerId: d.providerId, last4: d.last4 ?? null, validationStatus: d.validationStatus,
  createdAt: d.$createdAt, updatedAt: d.$updatedAt
});

const isCode = (error: unknown, code: number) => error instanceof AppwriteException && error.code === code;

export function appwriteKeysRepository(): KeysRepository {
  const { databases, databaseId } = adminDatabases();
  const collectionId = COLLECTIONS.keys;
  // Owner-derived id: a user can only ever address their own key document.
  const idFor = (ownerId: string, providerId: string) => jobDocumentId(ownerId, `key:${providerId}`);
  return {
    async create({ ownerId, providerId, ...secret }) {
      try {
        const doc = await databases.createDocument<KeyDoc>({
          databaseId, collectionId, documentId: idFor(ownerId, providerId),
          data: { ownerId, providerId, ...secret, validationStatus: "unvalidated" },
          permissions: documentPermissions("keys", ownerId)
        });
        return toKeyMeta(doc);
      } catch (error) {
        if (isCode(error, 409)) return null;
        throw error;
      }
    },
    async replace({ ownerId, providerId, ...secret }) {
      try {
        const doc = await databases.updateDocument<KeyDoc>({
          databaseId, collectionId, documentId: idFor(ownerId, providerId),
          data: { ...secret, validationStatus: "unvalidated", validatedAt: null }
        });
        return toKeyMeta(doc);
      } catch (error) {
        if (isCode(error, 404)) return null;
        throw error;
      }
    },
    async get(ownerId, providerId) {
      try {
        // Select only non-secret attributes so ciphertext is never loaded here.
        const doc = await databases.getDocument<KeyDoc>({
          databaseId, collectionId, documentId: idFor(ownerId, providerId),
          queries: [Query.select(["providerId", "last4", "validationStatus"])]
        });
        return toKeyMeta(doc);
      } catch (error) {
        if (isCode(error, 404)) return null;
        throw error;
      }
    },
    async getCiphertext(ownerId, providerId) {
      try {
        const doc = await databases.getDocument<KeyDoc & { ciphertext: string }>({
          databaseId, collectionId, documentId: idFor(ownerId, providerId)
        });
        return doc.ownerId === ownerId ? doc.ciphertext : null;
      } catch (error) {
        if (isCode(error, 404)) return null;
        throw error;
      }
    },
    async setValidation(ownerId, providerId, status) {
      try {
        await databases.updateDocument({
          databaseId, collectionId, documentId: idFor(ownerId, providerId),
          data: { validationStatus: status, validatedAt: new Date().toISOString() }
        });
        return true;
      } catch (error) {
        if (isCode(error, 404)) return false;
        throw error;
      }
    },
    async list(ownerId) {
      const res = await databases.listDocuments<KeyDoc>({
        databaseId, collectionId,
        queries: [Query.equal("ownerId", ownerId), Query.select(["providerId", "last4", "validationStatus"]), Query.limit(100)]
      });
      return res.documents.map(toKeyMeta);
    },
    async delete(ownerId, providerId) {
      try {
        await databases.deleteDocument({ databaseId, collectionId, documentId: idFor(ownerId, providerId) });
        return true;
      } catch (error) {
        if (isCode(error, 404)) return false;
        throw error;
      }
    }
  };
}
