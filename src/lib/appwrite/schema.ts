import { Permission, Role } from "node-appwrite";

/**
 * Appwrite database schema + document-level security (DLS) policy.
 *
 * Policy (enforced by Appwrite, not just by our API):
 *  - Collections grant NO collection-level permissions to anyone (not even
 *    `create`): every document is created by our server (API key), which stamps
 *    the owner's permissions on it.
 *  - `documentSecurity: true` makes per-document permissions the only way a
 *    signed-in user can touch a document. A user can only match documents whose
 *    permissions name `user:<their id>`.
 *  - jobs/metadata: owner may read (metadata also update/delete). Job state,
 *    cost and provider ids are written only by the server, so a client cannot
 *    forge a "completed" job or erase billing records.
 *  - keys: NO user permissions at all. Ciphertext is only reachable with the
 *    server API key; routes must also check `ownerId`.
 */

export const COLLECTIONS = {
  jobs: "jobs",
  keys: "keys",
  metadata: "metadata"
} as const;

export type CollectionId = (typeof COLLECTIONS)[keyof typeof COLLECTIONS];

export type AttributeSpec =
  | { type: "string"; key: string; size: number; required: boolean; array?: boolean }
  | { type: "enum"; key: string; elements: string[]; required: boolean }
  | { type: "integer"; key: string; required: boolean; min?: number; max?: number }
  | { type: "float"; key: string; required: boolean; min?: number }
  | { type: "datetime"; key: string; required: boolean };

export interface IndexSpec {
  key: string;
  type: "key" | "unique";
  attributes: string[];
}

export interface CollectionSpec {
  id: CollectionId;
  name: string;
  documentSecurity: true;
  /** Collection-level permissions. Intentionally empty: see policy above. */
  permissions: string[];
  attributes: AttributeSpec[];
  indexes: IndexSpec[];
}

export const JOB_STATUSES = ["queued", "submitted", "processing", "validating", "completed", "failed", "cancelled"];

export const COLLECTION_SPECS: CollectionSpec[] = [
  {
    id: "jobs",
    name: "Jobs",
    documentSecurity: true,
    permissions: [],
    attributes: [
      { type: "string", key: "ownerId", size: 36, required: true },
      { type: "string", key: "projectId", size: 36, required: true },
      { type: "string", key: "capability", size: 32, required: true },
      { type: "string", key: "providerId", size: 64, required: true },
      { type: "string", key: "modelId", size: 128, required: true },
      { type: "enum", key: "status", elements: JOB_STATUSES, required: true },
      { type: "string", key: "inputAssetIds", size: 36, required: false, array: true },
      { type: "string", key: "parameters", size: 16384, required: true },
      { type: "string", key: "idempotencyKey", size: 128, required: true },
      { type: "string", key: "requestHash", size: 64, required: true },
      { type: "string", key: "providerJobId", size: 256, required: false },
      { type: "integer", key: "progress", required: false, min: 0, max: 100 },
      { type: "string", key: "errorCode", size: 64, required: false },
      { type: "float", key: "estimatedCost", required: false, min: 0 },
      { type: "float", key: "actualCost", required: false, min: 0 },
      { type: "string", key: "currency", size: 3, required: false }
    ],
    indexes: [
      { key: "idx_owner", type: "key", attributes: ["ownerId"] },
      { key: "idx_owner_status", type: "key", attributes: ["ownerId", "status"] },
      { key: "idx_owner_idem", type: "unique", attributes: ["ownerId", "idempotencyKey"] }
    ]
  },
  {
    id: "keys",
    name: "Provider keys",
    documentSecurity: true,
    permissions: [],
    attributes: [
      { type: "string", key: "ownerId", size: 36, required: true },
      { type: "string", key: "providerId", size: 64, required: true },
      { type: "string", key: "ciphertext", size: 4096, required: true },
      { type: "string", key: "keyId", size: 16, required: true },
      { type: "string", key: "last4", size: 4, required: false },
      { type: "enum", key: "validationStatus", elements: ["unvalidated", "valid", "invalid"], required: true },
      { type: "datetime", key: "validatedAt", required: false }
    ],
    indexes: [{ key: "uniq_owner_provider", type: "unique", attributes: ["ownerId", "providerId"] }]
  },
  {
    id: "metadata",
    name: "Asset metadata",
    documentSecurity: true,
    permissions: [],
    attributes: [
      { type: "string", key: "ownerId", size: 36, required: true },
      { type: "string", key: "projectId", size: 36, required: false },
      { type: "string", key: "objectKey", size: 512, required: true },
      { type: "string", key: "contentType", size: 128, required: true },
      { type: "integer", key: "size", required: true, min: 0 },
      { type: "enum", key: "status", elements: ["pending", "uploaded", "rejected"], required: true },
      { type: "enum", key: "origin", elements: ["upload", "generated"], required: true },
      { type: "string", key: "originalName", size: 256, required: false },
      { type: "string", key: "parentAssetId", size: 36, required: false },
      { type: "string", key: "sourceJobId", size: 36, required: false }
    ],
    indexes: [
      { key: "idx_owner", type: "key", attributes: ["ownerId"] },
      { key: "uniq_object_key", type: "unique", attributes: ["objectKey"] }
    ]
  }
];

/** Document-level permissions for a newly created document, by collection. */
export function documentPermissions(collection: CollectionId, ownerId: string): string[] {
  if (!ownerId) throw new Error("ownerId is required to build document permissions.");
  const owner = Role.user(ownerId);
  switch (collection) {
    case "keys":
      return []; // server-only
    case "jobs":
      return [Permission.read(owner)]; // server-written state
    case "metadata":
      return [Permission.read(owner), Permission.update(owner), Permission.delete(owner)];
  }
}
