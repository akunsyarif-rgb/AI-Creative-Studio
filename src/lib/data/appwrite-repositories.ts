import { createHash, randomUUID } from "node:crypto";
import { AppwriteException, Query, type Models, type TablesDB } from "node-appwrite";
import { TABLES, rowPermissions } from "@/lib/appwrite/schema";
import type { AssetRecord, AssetsRepository, CustomProviderConfig, HttpTemplate, JobPatch, JobRecord, JobsRepository, KeyMetadata, KeysRepository, NewJob } from "./repositories";

/** The TablesDB methods the repositories use; the real admin client is injected by `api/deps.ts`. */
export type RowsClient = Pick<TablesDB, "createRow" | "getRow" | "listRows" | "updateRow" | "deleteRow">;
export interface RepoContext {
  tables: RowsClient;
  databaseId: string;
}

/** Deterministic id => duplicate (owner, idempotencyKey) hits Appwrite's 409, atomically. */
export function deterministicId(ownerId: string, idempotencyKey: string): string {
  return createHash("sha256").update(`${ownerId}\0${idempotencyKey}`).digest("hex").slice(0, 36);
}

type JobRow = Models.Row & {
  ownerId: string; projectId: string; capability: JobRecord["capability"]; providerId: string; modelId: string;
  status: JobRecord["status"]; inputAssetIds?: string[]; parameters: string; idempotencyKey: string; requestHash: string;
  progress?: number | null; errorCode?: string | null; errorMessage?: string | null; outputAssetIds?: string[]; estimatedCost?: number | null; currency?: string | null;
  providerJobId?: string | null;
};

function toJob(d: JobRow): JobRecord {
  return {
    id: d.$id, ownerId: d.ownerId, projectId: d.projectId, capability: d.capability, providerId: d.providerId,
    modelId: d.modelId, status: d.status, inputAssetIds: d.inputAssetIds ?? [], parameters: JSON.parse(d.parameters),
    idempotencyKey: d.idempotencyKey, requestHash: d.requestHash, progress: d.progress ?? null,
    errorCode: d.errorCode ?? null, errorMessage: d.errorMessage ?? null,
    outputAssetIds: d.outputAssetIds ?? [], providerJobId: d.providerJobId ?? null, estimatedCost: d.estimatedCost ?? null, currency: d.currency ?? null,
    createdAt: d.$createdAt
  };
}

export function appwriteJobsRepository({ tables, databaseId }: RepoContext): JobsRepository {
  const tableId = TABLES.jobs;
  return {
    async createIdempotent(job: NewJob) {
      const rowId = deterministicId(job.ownerId, job.idempotencyKey);
      try {
        const doc = await tables.createRow<JobRow>({
          databaseId, tableId, rowId,
          data: { ...job, parameters: JSON.stringify(job.parameters), status: "queued", ...(job.estimatedCost === undefined ? {} : { currency: job.currency ?? "USD" }) },
          permissions: rowPermissions("jobs", job.ownerId)
        });
        return { job: toJob(doc), created: true };
      } catch (error) {
        if (error instanceof AppwriteException && error.code === 409) {
          const existing = await tables.getRow<JobRow>({ databaseId, tableId, rowId });
          if (existing.ownerId !== job.ownerId) throw error; // cannot happen: id is owner-derived
          return { job: toJob(existing), created: false };
        }
        throw error;
      }
    },
    async getOwned(ownerId, id) {
      try {
        const doc = await tables.getRow<JobRow>({ databaseId, tableId, rowId: id });
        return doc.ownerId === ownerId ? toJob(doc) : null;
      } catch (error) {
        if (error instanceof AppwriteException && error.code === 404) return null;
        throw error;
      }
    },
    async update(id: string, patch: JobPatch) {
      await tables.updateRow({ databaseId, tableId, rowId: id, data: { ...patch } });
    },
    async delete(ownerId, id) {
      try {
        const doc = await tables.getRow<JobRow>({ databaseId, tableId, rowId: id, queries: [Query.select(["ownerId"])] });
        if (doc.ownerId !== ownerId) return false;
        await tables.deleteRow({ databaseId, tableId, rowId: id });
        return true;
      } catch (error) {
        if (error instanceof AppwriteException && error.code === 404) return false;
        throw error;
      }
    },
    async listByOwner(ownerId, limit, cursor) {
      // Fetch one extra row to know whether another page exists.
      const res = await tables.listRows<JobRow>({
        databaseId, tableId,
        queries: [
          Query.equal("ownerId", ownerId), Query.orderDesc("$createdAt"), Query.limit(limit + 1),
          ...(cursor ? [Query.cursorAfter(cursor)] : [])
        ]
      });
      const page = res.rows.slice(0, limit).map(toJob);
      return { jobs: page, nextCursor: res.rows.length > limit ? page[page.length - 1].id : null };
    }
  };
}

type AssetRow = Models.Row & Omit<AssetRecord, "id"> & { origin?: "upload" | "generated"; sourceJobId?: string; parentAssetId?: string };

const toAsset = (d: AssetRow): AssetRecord => ({
  id: d.$id, ownerId: d.ownerId, objectKey: d.objectKey, contentType: d.contentType, size: d.size, status: d.status
});

export function appwriteAssetsRepository({ tables, databaseId }: RepoContext): AssetsRepository {
  const tableId = TABLES.metadata;
  return {
    async createPendingUpload(input) {
      const doc = await tables.createRow<AssetRow>({
        databaseId, tableId, rowId: randomUUID(),
        data: { ...input, status: "pending", origin: "upload" },
        permissions: rowPermissions("metadata", input.ownerId)
      });
      return toAsset(doc);
    },
    async findOwned(ownerId, ids) {
      if (!ids.length) return [];
      const res = await tables.listRows<AssetRow>({
        databaseId, tableId,
        queries: [Query.equal("$id", ids), Query.equal("ownerId", ownerId), Query.limit(ids.length)]
      });
      return res.rows.map(toAsset);
    },
    async createGenerated({ ownerId, projectId, ...rest }) {
      const doc = await tables.createRow<AssetRow>({
        databaseId, tableId, rowId: randomUUID(),
        data: { ownerId, ...(projectId ? { projectId } : {}), ...rest, status: "uploaded", origin: "generated" },
        permissions: rowPermissions("metadata", ownerId)
      });
      return toAsset(doc);
    },
    async setStatus(id, status) {
      await tables.updateRow({ databaseId, tableId, rowId: id, data: { status } });
    },
    async delete(ownerId, id) {
      try {
        const doc = await tables.getRow<AssetRow>({ databaseId, tableId, rowId: id, queries: [Query.select(["ownerId"])] });
        if (doc.ownerId !== ownerId) return false;
        await tables.deleteRow({ databaseId, tableId, rowId: id });
        return true;
      } catch (error) {
        if (error instanceof AppwriteException && error.code === 404) return false;
        throw error;
      }
    }
  };
}

type KeyRow = Models.Row & {
  ownerId?: string; validatedAt?: string | null; providerId: string; last4?: string | null;
  validationStatus: KeyMetadata["validationStatus"];
  label?: string | null; baseUrl?: string | null; models?: string | null; estimatedCostUsd?: number | null; httpConfig?: string | null;
};

/** Non-secret columns only: ciphertext is never selected by metadata reads. */
const META_COLUMNS = ["providerId", "last4", "validationStatus", "label", "baseUrl", "models", "estimatedCostUsd", "httpConfig"];

/**
 * The `models` column holds a JSON array of ids, or `{ids, prices}` when per-model prices exist (no schema change;
 * older rows stay readable and rows without prices stay a plain array).
 */
export function encodeModels(models: string[], prices: Record<string, number> | undefined): string {
  const entries = Object.entries(prices ?? {}).filter(([id]) => models.includes(id));
  return JSON.stringify(entries.length ? { ids: models, prices: Object.fromEntries(entries) } : models);
}

export function decodeModels(raw: string | null | undefined): { models: string[]; prices: Record<string, number> } {
  try {
    const parsed = JSON.parse(raw ?? "[]") as unknown;
    const ids = Array.isArray(parsed) ? parsed : (parsed as { ids?: unknown })?.ids;
    const models = Array.isArray(ids) ? ids.filter((m): m is string => typeof m === "string") : [];
    const rawPrices = !Array.isArray(parsed) ? (parsed as { prices?: unknown })?.prices : undefined;
    const prices: Record<string, number> = {};
    if (rawPrices && typeof rawPrices === "object") {
      for (const [id, v] of Object.entries(rawPrices)) if (models.includes(id) && typeof v === "number" && Number.isFinite(v) && v > 0) prices[id] = v;
    }
    return { models, prices };
  } catch {
    return { models: [], prices: {} };
  }
}

function toCustom(d: KeyRow): CustomProviderConfig | null {
  if (!d.baseUrl) return null;
  const { models, prices } = decodeModels(d.models);
  let http: HttpTemplate | null = null;
  if (d.httpConfig) {
    try {
      const parsed = JSON.parse(d.httpConfig) as Partial<HttpTemplate>;
      if (typeof parsed.path === "string" && typeof parsed.body === "string" && (parsed.responseKind === "json" || parsed.responseKind === "binary")) {
        http = {
          path: parsed.path, authHeader: parsed.authHeader ?? "Authorization", authScheme: parsed.authScheme ?? "Bearer", body: parsed.body,
          responseKind: parsed.responseKind, responsePath: parsed.responsePath ?? null, testPath: parsed.testPath ?? null
        };
      }
    } catch {
      http = null;
    }
  }
  return { providerId: d.providerId, label: d.label ?? d.providerId, baseUrl: d.baseUrl, models, estimatedCostUsd: d.estimatedCostUsd ?? null, ...(Object.keys(prices).length ? { modelPrices: prices } : {}), http };
}

const toKeyMeta = (d: KeyRow): KeyMetadata => ({
  providerId: d.providerId, last4: d.last4 ?? null, validationStatus: d.validationStatus, custom: toCustom(d),
  createdAt: d.$createdAt, updatedAt: d.$updatedAt
});

const isCode = (error: unknown, code: number) => error instanceof AppwriteException && error.code === code;

export function appwriteKeysRepository({ tables, databaseId }: RepoContext): KeysRepository {
  const tableId = TABLES.keys;
  // Owner-derived id: a user can only ever address their own key document.
  const idFor = (ownerId: string, providerId: string) => deterministicId(ownerId, `key:${providerId}`);
  return {
    async create({ ownerId, providerId, custom, ...secret }) {
      try {
        const doc = await tables.createRow<KeyRow>({
          databaseId, tableId, rowId: idFor(ownerId, providerId),
          data: {
            ownerId, providerId, ...secret, validationStatus: "unvalidated",
            ...(custom ? { label: custom.label, baseUrl: custom.baseUrl, models: encodeModels(custom.models, custom.modelPrices), ...(custom.estimatedCostUsd === null ? {} : { estimatedCostUsd: custom.estimatedCostUsd }), ...(custom.http ? { httpConfig: JSON.stringify(custom.http) } : {}) } : {})
          },
          permissions: rowPermissions("keys", ownerId)
        });
        return toKeyMeta(doc);
      } catch (error) {
        if (isCode(error, 409)) return null;
        throw error;
      }
    },
    async replace({ ownerId, providerId, ...secret }) {
      try {
        const doc = await tables.updateRow<KeyRow>({
          databaseId, tableId, rowId: idFor(ownerId, providerId),
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
        // Select only non-secret columns so ciphertext is never loaded here.
        const doc = await tables.getRow<KeyRow>({
          databaseId, tableId, rowId: idFor(ownerId, providerId),
          queries: [Query.select(META_COLUMNS)]
        });
        return toKeyMeta(doc);
      } catch (error) {
        if (isCode(error, 404)) return null;
        throw error;
      }
    },
    async getCustomConfig(ownerId, providerId) {
      try {
        const row = await tables.getRow<KeyRow>({
          databaseId, tableId, rowId: idFor(ownerId, providerId), queries: [Query.select(META_COLUMNS)]
        });
        return toCustom(row);
      } catch (error) {
        if (isCode(error, 404)) return null;
        throw error;
      }
    },
    async updateCustom({ ownerId, providerId, models, estimatedCostUsd, modelPrices }) {
      // Only an existing custom row of this owner (owner-derived id) can be changed.
      if (!(await this.getCustomConfig(ownerId, providerId))) return null;
      try {
        const doc = await tables.updateRow<KeyRow>({
          databaseId, tableId, rowId: idFor(ownerId, providerId),
          data: { models: encodeModels(models, modelPrices), estimatedCostUsd }
        });
        return toKeyMeta(doc);
      } catch (error) {
        if (isCode(error, 404)) return null;
        throw error;
      }
    },
    async listCustom(ownerId) {
      const res = await tables.listRows<KeyRow>({
        databaseId, tableId, queries: [Query.equal("ownerId", ownerId), Query.select(META_COLUMNS), Query.limit(100)]
      });
      return res.rows.map(toCustom).filter((c): c is CustomProviderConfig => c !== null);
    },
    async getCiphertext(ownerId, providerId) {
      try {
        const doc = await tables.getRow<KeyRow & { ciphertext: string }>({
          databaseId, tableId, rowId: idFor(ownerId, providerId)
        });
        return doc.ownerId === ownerId ? doc.ciphertext : null;
      } catch (error) {
        if (isCode(error, 404)) return null;
        throw error;
      }
    },
    async setValidation(ownerId, providerId, status) {
      try {
        await tables.updateRow({
          databaseId, tableId, rowId: idFor(ownerId, providerId),
          data: { validationStatus: status, validatedAt: new Date().toISOString() }
        });
        return true;
      } catch (error) {
        if (isCode(error, 404)) return false;
        throw error;
      }
    },
    async list(ownerId) {
      const res = await tables.listRows<KeyRow>({
        databaseId, tableId,
        queries: [Query.equal("ownerId", ownerId), Query.select(META_COLUMNS), Query.limit(100)]
      });
      return res.rows.map(toKeyMeta);
    },
    async delete(ownerId, providerId) {
      try {
        await tables.deleteRow({ databaseId, tableId, rowId: idFor(ownerId, providerId) });
        return true;
      } catch (error) {
        if (isCode(error, 404)) return false;
        throw error;
      }
    }
  };
}
