import { describe, expect, it } from "vitest";
import { postConfirmUpload, type ApiDeps } from "./handlers";
import type { AssetRecord } from "@/lib/data/repositories";
import { ALICE, BOB, PNG, createTestWorld, jsonRequest } from "./test-helpers";

const KEY = "users/alice/123e4567-e89b-12d3-a456-426614174000";

function setup(object: { data: Uint8Array; contentType: string } | null, asset: Partial<AssetRecord> = {}) {
  const w = createTestWorld();
  w.seedAsset({ id: "a1", ownerId: "alice", objectKey: KEY, contentType: "image/png", size: object?.data.length ?? 2048, status: "pending", ...asset });
  if (object) w.objects.set(KEY, object);
  const deleted: string[] = [];
  const del = w.deps.storage.deleteObject;
  w.deps.storage.deleteObject = async (i) => { deleted.push(i.key); return del(i); };
  const reads: string[] = [];
  const read = w.deps.storage.readObject;
  w.deps.storage.readObject = async (i) => { reads.push(i.key); return read(i); };
  return { deps: w.deps, assets: w.assets, deleted, reads, w };
}

const png = (extra = 0) => ({ data: Uint8Array.from([...PNG, ...new Array(extra).fill(1)]), contentType: "image/png" });
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);

const confirm = (deps: ApiDeps, token = ALICE, id = "a1") => postConfirmUpload(jsonRequest(`/api/uploads/${id}/confirm`, { token }), deps, id);

describe("POST /api/uploads/:id/confirm", () => {
  it("marks the asset uploaded when size, MIME and magic bytes all match", async () => {
    const o = png(100);
    const { deps, assets } = setup(o, { size: o.data.length });
    const res = await confirm(deps);
    expect(res.status).toBe(200);
    expect(assets.get("a1")!.status).toBe("uploaded");
  });

  it("rejects and deletes the object on size mismatch", async () => {
    const { deps, assets, deleted } = setup(png(100), { size: 5 });
    const res = await confirm(deps);
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("upload_mismatch");
    expect(assets.get("a1")!.status).toBe("rejected");
    expect(deleted).toHaveLength(1);
  });

  it("rejects and deletes the object on declared MIME mismatch", async () => {
    const o = { ...png(10), contentType: "text/html" };
    const { deps, assets, deleted } = setup(o, { size: o.data.length });
    expect((await confirm(deps)).status).toBe(422);
    expect(assets.get("a1")!.status).toBe("rejected");
    expect(deleted).toHaveLength(1);
  });

  it("rejects files whose real bytes are not the declared type (magic bytes)", async () => {
    const html = new TextEncoder().encode("<html><script>alert(1)</script></html>");
    for (const data of [html, JPEG]) {
      const { deps, assets, deleted } = setup({ data, contentType: "image/png" }, { size: data.length });
      const res = await confirm(deps);
      expect(res.status).toBe(422);
      expect((await res.json()).error.code).toBe("upload_content_mismatch");
      expect(assets.get("a1")!.status).toBe("rejected");
      expect(deleted).toHaveLength(1);
    }
  });

  it("stays pending (409) when nothing has been uploaded yet", async () => {
    const { deps, assets, deleted } = setup(null);
    const res = await confirm(deps);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("upload_not_found");
    expect(assets.get("a1")!.status).toBe("pending");
    expect(deleted).toHaveLength(0);
  });

  it("is idempotent for already-uploaded assets and does not re-check storage", async () => {
    const { deps, reads } = setup(png(), { status: "uploaded" });
    expect((await confirm(deps)).status).toBe(200);
    expect(reads).toHaveLength(0);
  });

  it("does not resurrect rejected assets", async () => {
    const { deps, assets } = setup(png(), { status: "rejected" });
    expect((await confirm(deps)).status).toBe(409);
    expect(assets.get("a1")!.status).toBe("rejected");
  });

  it("returns 404 for other users' or unknown assets, and 401 without auth", async () => {
    const { deps, reads } = setup(png());
    expect((await confirm(deps, BOB)).status).toBe(404);
    expect((await confirm(deps, ALICE, "nope")).status).toBe(404);
    expect((await confirm(deps, ALICE, "../x")).status).toBe(404);
    expect((await postConfirmUpload(jsonRequest("/x"), deps, "a1")).status).toBe(401);
    expect(reads).toHaveLength(0);
  });

  it("is rate limited", async () => {
    const w = createTestWorld({ limits: { uploads: { limit: 1, windowSeconds: 60 }, keys: { limit: 1, windowSeconds: 60 }, providerTest: { limit: 1, windowSeconds: 60 }, jobs: { limit: 1, windowSeconds: 60 } } });
    await postConfirmUpload(jsonRequest("/x", { token: ALICE }), w.deps, "nope");
    expect((await postConfirmUpload(jsonRequest("/x", { token: ALICE }), w.deps, "nope")).status).toBe(429);
  });
});
