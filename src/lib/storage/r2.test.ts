import { describe, expect, it } from "vitest";
import { StorageError, assertOwnedKey, createR2Storage, newObjectKey, validateUpload } from "./r2";

const storage = createR2Storage(
  { endpoint: "https://acct.r2.cloudflarestorage.com", bucket: "studio", accessKeyId: "AKIATEST", secretAccessKey: "test-secret" },
  () => Date.UTC(2026, 0, 1)
);

describe("object keys", () => {
  it("generates per-user keys the owner passes and others fail", () => {
    const key = newObjectKey("user1");
    expect(key).toMatch(/^users\/user1\/[0-9a-f-]{36}$/);
    expect(() => assertOwnedKey("user1", key)).not.toThrow();
    expect(() => assertOwnedKey("user2", key)).toThrow(StorageError);
  });

  it("rejects traversal, nesting and bad owner ids", () => {
    const id = "123e4567-e89b-12d3-a456-426614174000";
    expect(() => assertOwnedKey("user1", `users/user1/../user2/${id}`)).toThrow(StorageError);
    expect(() => assertOwnedKey("user1", `users/user1/${id}/extra`)).toThrow(StorageError);
    expect(() => assertOwnedKey("user1", "users/user1/not-a-uuid")).toThrow(StorageError);
    expect(() => newObjectKey("../x")).toThrow(StorageError);
    expect(() => newObjectKey("a/b")).toThrow(StorageError);
  });
});

describe("upload policy", () => {
  it("accepts allowed types within limits", () => {
    expect(() => validateUpload("image/png", 1024)).not.toThrow();
    expect(() => validateUpload("video/mp4", 100 * 1024 * 1024)).not.toThrow();
  });
  it("rejects unsupported types, oversize and invalid sizes", () => {
    expect(() => validateUpload("image/svg+xml", 10)).toThrow(/Unsupported/);
    expect(() => validateUpload("text/html", 10)).toThrow(/Unsupported/);
    expect(() => validateUpload("image/png", 26 * 1024 * 1024)).toThrow(/size limit/);
    expect(() => validateUpload("image/png", 0)).toThrow(StorageError);
    expect(() => validateUpload("image/png", 1.5)).toThrow(StorageError);
  });
});

describe("presigned URLs", () => {
  const key = newObjectKey("user1");

  it("signs content type and length into the upload URL with a bounded expiry", async () => {
    const up = await storage.presignUpload({ ownerId: "user1", key, contentType: "image/png", size: 2048, ttlSeconds: 99999 });
    const url = new URL(up.url);
    expect(url.hostname).toBe("studio.acct.r2.cloudflarestorage.com");
    expect(url.pathname).toContain(key);
    expect(url.searchParams.get("X-Amz-Expires")).toBe("900");
    const signed = url.searchParams.get("X-Amz-SignedHeaders") ?? "";
    expect(signed).toContain("content-type");
    expect(signed).toContain("content-length");
    expect(up.method).toBe("PUT");
    expect(up.expiresAt).toBe("2026-01-01T00:15:00.000Z");
    expect(up.url).not.toContain("test-secret");
  });

  it("refuses to presign for another user's key or a disallowed type", async () => {
    await expect(storage.presignUpload({ ownerId: "user2", key, contentType: "image/png", size: 1 })).rejects.toThrow(StorageError);
    await expect(storage.presignUpload({ ownerId: "user1", key, contentType: "text/html", size: 1 })).rejects.toThrow(StorageError);
    await expect(storage.presignDownload({ ownerId: "user2", key })).rejects.toThrow(StorageError);
  });

  it("issues short-lived download URLs with a sanitized filename", async () => {
    const dl = await storage.presignDownload({ ownerId: "user1", key, filename: 'a"b/../c.png' });
    const url = new URL(dl.url);
    expect(url.searchParams.get("X-Amz-Expires")).toBe("300");
    expect(url.searchParams.get("response-content-disposition")).toBe('attachment; filename="a_b_.._c.png"');
  });
});

describe("headObject / deleteObject", () => {
  const key = newObjectKey("user1");
  const fake = (impl: (cmd: { constructor: { name: string }; input: unknown }) => unknown) =>
    createR2Storage({ endpoint: "https://a.r2.cloudflarestorage.com", bucket: "b", accessKeyId: "AK", secretAccessKey: "SK" }, Date.now, {
      send: (async (cmd: never) => impl(cmd)) as never
    });

  it("returns size and content type", async () => {
    const s = fake(() => ({ ContentLength: 10, ContentType: "image/png" }));
    expect(await s.headObject({ ownerId: "user1", key })).toEqual({ size: 10, contentType: "image/png" });
  });

  it("returns null when the object does not exist, rethrows other errors", async () => {
    const missing = fake(() => { throw Object.assign(new Error("x"), { name: "NotFound", $metadata: { httpStatusCode: 404 } }); });
    expect(await missing.headObject({ ownerId: "user1", key })).toBeNull();
    const broken = fake(() => { throw Object.assign(new Error("x"), { name: "InternalError", $metadata: { httpStatusCode: 500 } }); });
    await expect(broken.headObject({ ownerId: "user1", key })).rejects.toThrow();
  });

  it("refuses keys that belong to someone else without calling R2", async () => {
    let calls = 0;
    const s = fake(() => { calls++; return {}; });
    await expect(s.headObject({ ownerId: "user2", key })).rejects.toThrow(StorageError);
    await expect(s.deleteObject({ ownerId: "user2", key })).rejects.toThrow(StorageError);
    expect(calls).toBe(0);
  });
});
