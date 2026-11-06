import { describe, expect, it } from "vitest";
import { TABLES, TABLE_PREFIX, TABLE_SPECS, rowPermissions } from "./schema";

describe("Appwrite row-level security policy", () => {
  it("enables row security and grants nothing at table level", () => {
    for (const c of TABLE_SPECS) {
      expect(c.rowSecurity).toBe(true);
      expect(c.permissions).toEqual([]);
    }
  });

  it("scopes job permissions to the owner, read-only", () => {
    expect(rowPermissions("jobs", "u1")).toEqual(['read("user:u1")']);
  });

  it("lets owners manage their metadata but nobody else", () => {
    const perms = rowPermissions("metadata", "u1");
    expect(perms).toEqual(['read("user:u1")', 'update("user:u1")', 'delete("user:u1")']);
    expect(perms.join()).not.toMatch(/any|users|guests/);
  });

  it("gives users no access to encrypted credentials", () => {
    expect(rowPermissions("keys", "u1")).toEqual([]);
  });

  it("requires an owner id", () => {
    expect(() => rowPermissions("jobs", "")).toThrow();
  });

  it("every collection has an ownerId attribute and index for owner-scoped queries", () => {
    for (const c of TABLE_SPECS) {
      expect(c.columns.some((a) => a.key === "ownerId" && a.required)).toBe(true);
      expect(c.indexes.some((i) => i.columns[0] === "ownerId")).toBe(true);
    }
  });

  it("prefixes every table id so the app can share a database, and keeps ids and kinds in sync", () => {
    expect(TABLE_SPECS.map((t) => t.kind)).toEqual(["jobs", "keys", "metadata"]);
    for (const t of TABLE_SPECS) {
      expect(t.id).toBe(TABLES[t.kind]);
      expect(t.id.startsWith(TABLE_PREFIX)).toBe(true);
    }
    expect(new Set(TABLE_SPECS.map((t) => t.id)).size).toBe(3);
  });

  it("defines optional, non-secret columns for custom providers on the keys table", () => {
    const keys = TABLE_SPECS.find((t) => t.kind === "keys")!;
    for (const key of ["label", "baseUrl", "models", "estimatedCostUsd"]) {
      const col = keys.columns.find((c) => c.key === key);
      expect(col, key).toBeDefined();
      expect(col!.required).toBe(false);
    }
    expect(keys.columns.find((c) => c.key === "models")!.type).toBe("text");
  });

  it("stores the optional HTTP template of a custom provider as unbounded text", () => {
    const col = TABLE_SPECS.find((t) => t.kind === "keys")!.columns.find((c) => c.key === "httpConfig");
    expect(col).toMatchObject({ type: "text", required: false });
  });
});
