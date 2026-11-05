import { describe, expect, it } from "vitest";
import { postConfirmUpload, type ApiDeps } from "./handlers";
import type { AssetRecord } from "@/lib/data/repositories";
import type { ObjectInfo } from "@/lib/storage/r2";
import { ALICE, BOB, jsonRequest, verifyToken } from "./test-helpers";

function setup(head: ObjectInfo | null, asset: Partial<AssetRecord> = {}) {
  const assets = new Map<string, AssetRecord>([
    ["a1", { id: "a1", ownerId: "alice", objectKey: "users/alice/123e4567-e89b-12d3-a456-426614174000", contentType: "image/png", size: 2048, status: "pending", ...asset }]
  ]);
  const deleted: string[] = [];
  const heads: string[] = [];
  const deps = {
    verifyToken,
    assets: {
      findOwned: async (owner: string, ids: string[]) => ids.map((i) => assets.get(i)).filter((a): a is AssetRecord => !!a && a.ownerId === owner),
      setStatus: async (id: string, status: AssetRecord["status"]) => { assets.get(id)!.status = status; }
    },
    storage: {
      headObject: async ({ key }: { key: string }) => { heads.push(key); return head; },
      deleteObject: async ({ key }: { key: string }) => { deleted.push(key); }
    }
  } as unknown as ApiDeps;
  return { deps, assets, deleted, heads };
}

const confirm = (deps: ApiDeps, token = ALICE, id = "a1") => postConfirmUpload(jsonRequest(`/api/uploads/${id}/confirm`, { token }), deps, id);

describe("POST /api/uploads/:id/confirm", () => {
  it("marks the asset uploaded when size and MIME match exactly", async () => {
    const { deps, assets } = setup({ size: 2048, contentType: "image/png" });
    const res = await confirm(deps);
    expect(res.status).toBe(200);
    expect(assets.get("a1")!.status).toBe("uploaded");
  });

  it("rejects and deletes the object on size mismatch", async () => {
    const { deps, assets, deleted } = setup({ size: 2049, contentType: "image/png" });
    const res = await confirm(deps);
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("upload_mismatch");
    expect(assets.get("a1")!.status).toBe("rejected");
    expect(deleted).toHaveLength(1);
  });

  it("rejects and deletes the object on MIME mismatch (or missing type)", async () => {
    for (const contentType of ["text/html", "image/jpeg", null]) {
      const { deps, assets, deleted } = setup({ size: 2048, contentType });
      expect((await confirm(deps)).status).toBe(422);
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
    const { deps, heads } = setup({ size: 1, contentType: "x" }, { status: "uploaded" });
    expect((await confirm(deps)).status).toBe(200);
    expect(heads).toHaveLength(0);
  });

  it("does not resurrect rejected assets", async () => {
    const { deps, assets } = setup({ size: 2048, contentType: "image/png" }, { status: "rejected" });
    expect((await confirm(deps)).status).toBe(409);
    expect(assets.get("a1")!.status).toBe("rejected");
  });

  it("returns 404 for other users' or unknown assets, and 401 without auth", async () => {
    const { deps, heads } = setup({ size: 2048, contentType: "image/png" });
    expect((await confirm(deps, BOB)).status).toBe(404);
    expect((await confirm(deps, ALICE, "nope")).status).toBe(404);
    expect((await confirm(deps, ALICE, "../x")).status).toBe(404);
    expect((await postConfirmUpload(jsonRequest("/x"), deps, "a1")).status).toBe(401);
    expect(heads).toHaveLength(0);
  });
});
