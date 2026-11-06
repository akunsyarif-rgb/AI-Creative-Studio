import { describe, expect, it } from "vitest";
import { provision, type ProvisionClient } from "./provision";
import { TABLE_SPECS } from "./schema";
import { createFakeTables } from "./fake-tables";

const run = (fake = createFakeTables(), opts: Parameters<typeof provision>[3] = {}) =>
  provision(fake.api as unknown as ProvisionClient, "studio", TABLE_SPECS, { sleep: async () => undefined, ...opts });

describe("provision (TablesDB)", () => {
  it("creates the database, all three tables, every column and index", async () => {
    const fake = createFakeTables();
    await run(fake);
    expect([...fake.state.databases]).toEqual(["studio"]);
    expect([...fake.state.tables.keys()]).toEqual(["jobs", "keys", "metadata"]);
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
    const jobs = fake.state.tables.get("jobs")!;
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
    const type = (t: string, c: string) => fake.state.tables.get(t)!.columns.get(c)!.type;
    expect(type("jobs", "parameters")).toBe("text");
    expect(type("jobs", "status")).toBe("enum");
    expect(type("jobs", "progress")).toBe("integer");
    expect(type("jobs", "estimatedCost")).toBe("float");
    expect(type("keys", "ciphertext")).toBe("varchar");
    expect(type("keys", "validatedAt")).toBe("datetime");
    expect((fake.state.tables.get("keys")!.columns.get("ciphertext")!.args as { size: number }).size).toBe(4096);
  });

  it("waits for columns to become available before creating indexes", async () => {
    const fake = createFakeTables({ columnsAvailableAfterPolls: 3 });
    await run(fake);
    const firstIndex = fake.calls.findIndex((c) => c.startsWith("index:"));
    const lastColumn = fake.calls.map((c, i) => (c.startsWith("column:jobs.") ? i : -1)).filter((i) => i >= 0).pop()!;
    expect(firstIndex).toBeGreaterThan(lastColumn);
  });

  it("fails clearly when a column fails or never becomes available", async () => {
    const fake = createFakeTables();
    const original = fake.api.listColumns;
    fake.api.listColumns = async (p) => ({ columns: [...(await original(p)).columns, { key: "broken", status: "failed" }] });
    await expect(run(fake)).rejects.toThrow(/Columns failed in jobs: broken/);

    const slow = createFakeTables({ columnsAvailableAfterPolls: 10_000 });
    await expect(run(slow, { waitMs: -1 })).rejects.toThrow(/Timed out/);
  });

  it("surfaces missing-scope errors instead of swallowing them", async () => {
    await expect(run(createFakeTables({ scopes: "legacy-only" }))).rejects.toThrow(/missing scopes/);
  });

  it("only touches the database it is given", async () => {
    const fake = createFakeTables();
    await run(fake);
    expect(fake.calls.filter((c) => c.startsWith("db:"))).toEqual(["db:studio"]);
  });
});
