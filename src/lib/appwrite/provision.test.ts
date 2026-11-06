import { describe, expect, it } from "vitest";
import { provision, type ProvisionClient } from "./provision";
import { TABLES, TABLE_SPECS } from "./schema";
import { createFakeTables } from "./fake-tables";

const run = (fake = createFakeTables(), opts: Parameters<typeof provision>[3] = {}) =>
  provision(fake.api as unknown as ProvisionClient, "studio", TABLE_SPECS, { sleep: async () => undefined, ...opts });

describe("provision (TablesDB)", () => {
  it("creates the database, all three tables, every column and index", async () => {
    const fake = createFakeTables();
    await run(fake);
    expect([...fake.state.databases]).toEqual(["studio"]);
    expect([...fake.state.tables.keys()]).toEqual(["studio_jobs", "studio_keys", "studio_metadata"]);
    for (const spec of TABLE_SPECS) {
      const t = fake.state.tables.get(spec.id)!;
      expect([...t.columns.keys()].sort()).toEqual(spec.columns.map((c) => c.key).sort());
      expect([...t.indexes.keys()].sort()).toEqual(spec.indexes.map((i) => i.key).sort());
    }
  });

  it("enables row security and grants no table-level permissions, and re-asserts them on existing tables", async () => {
    const fake = createFakeTables();
    await run(fake);
    for (const t of fake.state.tables.values()) {
      expect(t.rowSecurity).toBe(true);
      expect(t.permissions).toEqual([]);
    }
    // Simulate drift (someone opened a table up), then re-run: setup must close it again.
    const jobs = fake.state.tables.get(TABLES.jobs)!;
    jobs.rowSecurity = false;
    jobs.permissions = ['read("any")'];
    await run(fake);
    expect(jobs.rowSecurity).toBe(true);
    expect(jobs.permissions).toEqual([]);
  });

  it("is idempotent: a second run creates nothing new and does not fail", async () => {
    const fake = createFakeTables();
    await run(fake);
    const lines: string[] = [];
    await run(fake, { log: (l) => lines.push(l) });
    expect(lines.filter((l) => l.startsWith("created"))).toEqual([]);
    expect(lines.filter((l) => l.startsWith("exists")).length).toBeGreaterThan(20);
  });

  it("uses the right column types, including unbounded text for parameters and a secret-sized varchar", async () => {
    const fake = createFakeTables();
    await run(fake);
    const type = (t: string, c: string) => fake.state.tables.get(`studio_${t}`)!.columns.get(c)!.type;
    expect(type("jobs", "parameters")).toBe("text");
    expect(type("jobs", "status")).toBe("enum");
    expect(type("jobs", "progress")).toBe("integer");
    expect(type("jobs", "estimatedCost")).toBe("float");
    expect(type("keys", "ciphertext")).toBe("varchar");
    expect(type("keys", "validatedAt")).toBe("datetime");
    expect((fake.state.tables.get(TABLES.keys)!.columns.get("ciphertext")!.args as { size: number }).size).toBe(4096);
  });

  it("waits for columns to become available before creating indexes", async () => {
    const fake = createFakeTables({ columnsAvailableAfterPolls: 3 });
    await run(fake);
    const firstIndex = fake.calls.findIndex((c) => c.startsWith("index:"));
    const lastColumn = fake.calls.map((c, i) => (c.startsWith("column:studio_jobs.") ? i : -1)).filter((i) => i >= 0).pop()!;
    expect(firstIndex).toBeGreaterThan(lastColumn);
  });

  it("fails clearly when a column fails or never becomes available", async () => {
    const fake = createFakeTables();
    const original = fake.api.listColumns;
    fake.api.listColumns = async (p) => ({ columns: [...(await original(p)).columns, { key: "broken", status: "failed" }] });
    await expect(run(fake)).rejects.toThrow(/Columns failed in studio_jobs: broken/);

    const slow = createFakeTables({ columnsAvailableAfterPolls: 10_000 });
    await expect(run(slow, { waitMs: -1 })).rejects.toThrow(/Timed out/);
  });

  it("surfaces missing-scope errors instead of swallowing them", async () => {
    await expect(run(createFakeTables({ scopes: "legacy-only" }))).rejects.toThrow(/missing scopes/);
  });

  it("uses prefixed table ids so it can share a database with other apps", async () => {
    expect(TABLE_SPECS.map((t) => t.id)).toEqual(["studio_jobs", "studio_keys", "studio_metadata"]);
    for (const t of TABLE_SPECS) expect(t.id.startsWith("studio_")).toBe(true);
  });

  it("does not create or modify a database that already exists (plan limit of one database)", async () => {
    const fake = createFakeTables({ existingDatabases: ["presensi"], maxDatabases: 1 });
    const lines: string[] = [];
    await provision(fake.api as unknown as ProvisionClient, "presensi", TABLE_SPECS, { sleep: async () => undefined, log: (l) => lines.push(l) });
    expect(fake.calls.filter((c) => c.startsWith("db:"))).toEqual([]);
    expect(lines).toContain("exists   database presensi");
    expect([...fake.state.databases]).toEqual(["presensi"]);
    expect([...fake.state.tables.keys()]).toEqual(["studio_jobs", "studio_keys", "studio_metadata"]);
  });

  it("surfaces the plan-limit error when a new database is needed but not allowed", async () => {
    const fake = createFakeTables({ existingDatabases: ["presensi"], maxDatabases: 1 });
    await expect(provision(fake.api as unknown as ProvisionClient, "studio", TABLE_SPECS, { sleep: async () => undefined })).rejects.toThrow(/maximum number of databases/);
  });

  it("refuses to modify a pre-existing table that is not ours, leaving it untouched", async () => {
    const fake = createFakeTables({ existingDatabases: ["presensi"] });
    await fake.api.createTable({ tableId: "studio_jobs", name: "Someone else's", permissions: ['read("users")'], rowSecurity: false });
    await fake.api.createVarcharColumn({ tableId: "studio_jobs", key: "student_name", size: 100, required: true });
    fake.state.tables.get("studio_jobs")!.columns.get("student_name")!.status = "available";
    await expect(provision(fake.api as unknown as ProvisionClient, "presensi", TABLE_SPECS, { sleep: async () => undefined })).rejects.toThrow(/not managed by this app \(unexpected columns: student_name\)/);
    const t = fake.state.tables.get("studio_jobs")!;
    expect(t.permissions).toEqual(['read("users")']);
    expect(t.rowSecurity).toBe(false);
    expect(fake.calls).not.toContain("updateTable:studio_jobs");
    expect([...t.columns.keys()]).toEqual(["student_name"]);
  });

  it("completes a partially provisioned table of its own (resume after an interrupted run)", async () => {
    const fake = createFakeTables({ existingDatabases: ["presensi"] });
    await fake.api.createTable({ tableId: "studio_jobs", name: "Jobs" });
    await fake.api.createVarcharColumn({ tableId: "studio_jobs", key: "ownerId", size: 36, required: true });
    await provision(fake.api as unknown as ProvisionClient, "presensi", TABLE_SPECS, { sleep: async () => undefined });
    expect(fake.state.tables.get("studio_jobs")!.columns.size).toBe(TABLE_SPECS[0].columns.length);
  });

  it("only touches the database it is given", async () => {
    const fake = createFakeTables();
    await run(fake);
    expect(fake.calls.filter((c) => c.startsWith("db:"))).toEqual(["db:studio"]);
  });
});
