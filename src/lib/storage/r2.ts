import { randomUUID } from "node:crypto";
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

/**
 * Cloudflare R2 (S3-compatible) private object storage. Buckets must have
 * public access disabled; every read/write goes through a short-lived signed
 * URL issued only after the caller has been authorized.
 */

export interface R2Config {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export const MAX_URL_TTL_SECONDS = 900;
const DEFAULT_UPLOAD_TTL_SECONDS = 600;
const DEFAULT_DOWNLOAD_TTL_SECONDS = 300;

const MB = 1024 * 1024;
/** Declared types are re-checked against real bytes after upload (not yet implemented). */
export const UPLOAD_POLICY: Record<string, { kind: "image" | "video"; maxBytes: number }> = {
  "image/png": { kind: "image", maxBytes: 25 * MB },
  "image/jpeg": { kind: "image", maxBytes: 25 * MB },
  "image/webp": { kind: "image", maxBytes: 25 * MB },
  "video/mp4": { kind: "video", maxBytes: 500 * MB },
  "video/quicktime": { kind: "video", maxBytes: 500 * MB },
  "video/webm": { kind: "video", maxBytes: 500 * MB }
};

const OWNER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,35}$/;
const OBJECT_ID_PATTERN = /^[0-9a-f-]{36}$/;

export class StorageError extends Error {
  constructor(
    public readonly code: "invalid_owner" | "invalid_key" | "unsupported_type" | "too_large" | "invalid_size",
    message: string
  ) {
    super(message);
    this.name = "StorageError";
  }
}

export function validateUpload(contentType: string, size: number): void {
  const policy = UPLOAD_POLICY[contentType];
  if (!policy) throw new StorageError("unsupported_type", "Unsupported content type.");
  if (!Number.isInteger(size) || size <= 0) throw new StorageError("invalid_size", "Size must be a positive integer.");
  if (size > policy.maxBytes) throw new StorageError("too_large", "File exceeds the size limit for this type.");
}

/** Server-generated key; the client never chooses object keys. */
export function newObjectKey(ownerId: string): string {
  if (!OWNER_ID_PATTERN.test(ownerId)) throw new StorageError("invalid_owner", "Invalid owner id.");
  return `users/${ownerId}/${randomUUID()}`;
}

/** Throws unless `key` is exactly `users/<ownerId>/<uuid>`. */
export function assertOwnedKey(ownerId: string, key: string): void {
  if (!OWNER_ID_PATTERN.test(ownerId)) throw new StorageError("invalid_owner", "Invalid owner id.");
  const [root, owner, id, ...rest] = key.split("/");
  if (root !== "users" || owner !== ownerId || !OBJECT_ID_PATTERN.test(id ?? "") || rest.length) {
    throw new StorageError("invalid_key", "Object key does not belong to this user.");
  }
}

function clampTtl(ttl: number | undefined, fallback: number): number {
  return Math.max(30, Math.min(ttl ?? fallback, MAX_URL_TTL_SECONDS));
}

export interface PresignedUpload {
  url: string;
  method: "PUT";
  headers: Record<string, string>;
  expiresAt: string;
}

export interface PresignedDownload {
  url: string;
  expiresAt: string;
}

export interface ObjectInfo {
  size: number;
  contentType: string | null;
}

export interface ObjectStorage {
  /** Returns null if the object does not exist. */
  headObject(input: { ownerId: string; key: string }): Promise<ObjectInfo | null>;
  deleteObject(input: { ownerId: string; key: string }): Promise<void>;
  presignUpload(input: { ownerId: string; key: string; contentType: string; size: number; ttlSeconds?: number }): Promise<PresignedUpload>;
  presignDownload(input: { ownerId: string; key: string; filename?: string; ttlSeconds?: number }): Promise<PresignedDownload>;
}

export function createR2Storage(
  config: R2Config,
  now: () => number = Date.now,
  injectedClient?: Pick<S3Client, "send">
): ObjectStorage {
  const client = (injectedClient as S3Client | undefined) ?? new S3Client({
    region: "auto",
    endpoint: config.endpoint,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    // R2 does not support the SDK's default flexible-checksum trailers.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED"
  });

  return {
    async headObject({ ownerId, key }) {
      assertOwnedKey(ownerId, key);
      try {
        const res = await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: key }));
        return { size: res.ContentLength ?? -1, contentType: res.ContentType ?? null };
      } catch (error) {
        const e = error as { name?: string; $metadata?: { httpStatusCode?: number } };
        if (e.name === "NotFound" || e.name === "NoSuchKey" || e.$metadata?.httpStatusCode === 404) return null;
        throw error;
      }
    },

    async deleteObject({ ownerId, key }) {
      assertOwnedKey(ownerId, key);
      await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }));
    },

    async presignUpload({ ownerId, key, contentType, size, ttlSeconds }) {
      assertOwnedKey(ownerId, key);
      validateUpload(contentType, size);
      const ttl = clampTtl(ttlSeconds, DEFAULT_UPLOAD_TTL_SECONDS);
      // ContentType and ContentLength are part of the signature, so the browser
      // cannot upload a different type or a larger body with this URL.
      const url = await getSignedUrl(
        client,
        new PutObjectCommand({ Bucket: config.bucket, Key: key, ContentType: contentType, ContentLength: size }),
        { expiresIn: ttl, signableHeaders: new Set(["content-type", "content-length"]) }
      );
      return { url, method: "PUT", headers: { "Content-Type": contentType }, expiresAt: new Date(now() + ttl * 1000).toISOString() };
    },

    async presignDownload({ ownerId, key, filename, ttlSeconds }) {
      assertOwnedKey(ownerId, key);
      const ttl = clampTtl(ttlSeconds, DEFAULT_DOWNLOAD_TTL_SECONDS);
      const safeName = filename?.replace(/[^\w.\- ]/g, "_").slice(0, 100);
      const url = await getSignedUrl(
        client,
        new GetObjectCommand({
          Bucket: config.bucket,
          Key: key,
          ...(safeName ? { ResponseContentDisposition: `attachment; filename="${safeName}"` } : {})
        }),
        { expiresIn: ttl }
      );
      return { url, expiresAt: new Date(now() + ttl * 1000).toISOString() };
    }
  };
}
