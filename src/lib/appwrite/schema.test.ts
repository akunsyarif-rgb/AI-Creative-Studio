import { describe, expect, it } from "vitest";
import { COLLECTION_SPECS, documentPermissions } from "./schema";

describe("Appwrite DLS policy", () => {
  it("enables document security and grants nothing at collection level", () => {
    for (const c of COLLECTION_SPECS) {
      expect(c.documentSecurity).toBe(true);
      expect(c.permissions).toEqual([]);
    }
  });

  it("scopes job permissions to the owner, read-only", () => {
    expect(documentPermissions("jobs", "u1")).toEqual(['read("user:u1")']);
  });

  it("lets owners manage their metadata but nobody else", () => {
    const perms = documentPermissions("metadata", "u1");
    expect(perms).toEqual(['read("user:u1")', 'update("user:u1")', 'delete("user:u1")']);
    expect(perms.join()).not.toMatch(/any|users|guests/);
  });

  it("gives users no access to encrypted credentials", () => {
    expect(documentPermissions("keys", "u1")).toEqual([]);
  });

  it("requires an owner id", () => {
    expect(() => documentPermissions("jobs", "")).toThrow();
  });

  it("every collection has an ownerId attribute and index for owner-scoped queries", () => {
    for (const c of COLLECTION_SPECS) {
      expect(c.attributes.some((a) => a.key === "ownerId" && a.required)).toBe(true);
      expect(c.indexes.some((i) => i.attributes[0] === "ownerId")).toBe(true);
    }
  });
});
