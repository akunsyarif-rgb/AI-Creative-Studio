import { AppwriteException, TablesDBIndexType, type TablesDB } from "node-appwrite";
import type { ColumnSpec, TableSpec } from "./schema";

/** The subset of the TablesDB service that provisioning uses (so it can be faked in tests). */
export type ProvisionClient = Pick<
  TablesDB,
  | "get" | "create" | "createTable" | "updateTable" | "listColumns" | "createIndex"
  | "createVarcharColumn" | "createTextColumn" | "createEnumColumn" | "createIntegerColumn" | "createFloatColumn" | "createDatetimeColumn"
>;

export interface ProvisionOptions {
  log?: (line: string) => void;
  /** Max time to wait for columns to become available. */
  waitMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

function isNotFound(error: unknown): boolean {
  return error instanceof AppwriteException && error.code === 404;
}

/**
 * Refuses to touch a pre-existing table that does not look like ours: it must contain
 * only columns from our spec (it may be missing some, e.g. after an interrupted run).
 */
async function assertOurs(tables: ProvisionClient, databaseId: string, spec: TableSpec): Promise<void> {
  const { columns } = await tables.listColumns({ databaseId, tableId: spec.id });
  const ours = new Set(spec.columns.map((c) => c.key));
  const foreign = (columns as { key: string }[]).map((c) => c.key).filter((k) => !ours.has(k));
  if (foreign.length) {
    throw new Error(
      `Table "${spec.id}" already exists but is not managed by this app (unexpected columns: ${foreign.slice(0, 5).join(", ")}). Refusing to modify it.`
    );
  }
}

async function ignoreExists(log: (l: string) => void, label: string, op: () => Promise<unknown>): Promise<void> {
  try {
    await op();
    log(`created  ${label}`);
  } catch (error) {
    if (error instanceof AppwriteException && error.code === 409) {
      log(`exists   ${label}`);
      return;
    }
    throw error;
  }
}

function createColumn(tables: ProvisionClient, databaseId: string, tableId: string, c: ColumnSpec): Promise<unknown> {
  const base = { databaseId, tableId, key: c.key, required: c.required };
  switch (c.type) {
    case "string":
      return tables.createVarcharColumn({ ...base, size: c.size, array: c.array });
    case "text":
      return tables.createTextColumn(base);
    case "enum":
      return tables.createEnumColumn({ ...base, elements: c.elements });
    case "integer":
      return tables.createIntegerColumn({ ...base, min: c.min, max: c.max });
    case "float":
      return tables.createFloatColumn({ ...base, min: c.min });
    case "datetime":
      return tables.createDatetimeColumn(base);
  }
}

async function waitForColumns(tables: ProvisionClient, databaseId: string, tableId: string, opts: Required<Pick<ProvisionOptions, "waitMs" | "sleep">>) {
  const deadline = Date.now() + opts.waitMs;
  for (;;) {
    const { columns } = await tables.listColumns({ databaseId, tableId });
    const list = columns as { key: string; status: string }[];
    const failed = list.filter((c) => c.status === "failed");
    if (failed.length) throw new Error(`Columns failed in ${tableId}: ${failed.map((c) => c.key).join(", ")}`);
    if (list.every((c) => c.status === "available")) return;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for columns in ${tableId}`);
    await opts.sleep(1000);
  }
}

/**
 * Idempotent provisioning: creates what is missing, never deletes, and re-asserts
 * the security settings (table-level permissions + row security) on existing tables.
 */
export async function provision(tables: ProvisionClient, databaseId: string, specs: TableSpec[], options: ProvisionOptions = {}): Promise<void> {
  const log = options.log ?? (() => undefined);
  const wait = { waitMs: options.waitMs ?? 60_000, sleep: options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))) };

  // The database may be shared with other apps (and plans can cap the number of databases), so only
  // create it when it is really absent, and never modify an existing one.
  try {
    await tables.get({ databaseId });
    log(`exists   database ${databaseId}`);
  } catch (error) {
    if (!isNotFound(error)) throw error;
    await ignoreExists(log, `database ${databaseId}`, () => tables.create({ databaseId, name: "AI Creative Studio" }));
  }

  for (const spec of specs) {
    let existed = false;
    try {
      await tables.createTable({ databaseId, tableId: spec.id, name: spec.name, permissions: spec.permissions, rowSecurity: spec.rowSecurity });
      log(`created  table ${spec.id}`);
    } catch (error) {
      if (!(error instanceof AppwriteException && error.code === 409)) throw error;
      existed = true;
      log(`exists   table ${spec.id}`);
    }
    if (existed) await assertOurs(tables, databaseId, spec);
    // Drift protection: always re-assert the security-relevant settings.
    await tables.updateTable({ databaseId, tableId: spec.id, name: spec.name, permissions: spec.permissions, rowSecurity: spec.rowSecurity });

    for (const column of spec.columns) {
      await ignoreExists(log, `${spec.id}.${column.key}`, () => createColumn(tables, databaseId, spec.id, column));
    }
    await waitForColumns(tables, databaseId, spec.id, wait);

    for (const index of spec.indexes) {
      await ignoreExists(log, `${spec.id}#${index.key}`, () =>
        tables.createIndex({
          databaseId, tableId: spec.id, key: index.key, columns: index.columns,
          type: index.type === "unique" ? TablesDBIndexType.Unique : TablesDBIndexType.Key
        })
      );
    }
  }
  log("Appwrite schema is up to date.");
}
