import { AppwriteException } from "node-appwrite";

type Row = Record<string, unknown> & { $id: string; $createdAt: string; $updatedAt: string; $permissions: string[] };

const err = (code: number, message: string) => new AppwriteException(message, code, "test", "");

/**
 * In-memory stand-in for the parts of the Appwrite TablesDB service we use. It reproduces the
 * behaviours our code relies on: 409 on duplicate ids, 404 on missing rows, async column status,
 * `Query.equal/select/limit/cursorAfter/orderDesc` (parsed from the SDK's JSON query strings).
 */
export function createFakeTables(opts: { columnsAvailableAfterPolls?: number; scopes?: "all" | "legacy-only" } = {}) {
  const databases = new Set<string>();
  const tables = new Map<string, { name: string; permissions: string[]; rowSecurity: boolean; columns: Map<string, { status: string; type: string; args: unknown }>; indexes: Map<string, unknown>; rows: Map<string, Row> }>();
  const calls: string[] = [];
  let polls = 0;
  let clock = 0;
  const tick = () => new Date(Date.UTC(2026, 0, 1, 0, 0, ++clock)).toISOString();
  const table = (id: string) => {
    const t = tables.get(id);
    if (!t) throw err(404, "Table not found");
    return t;
  };
  const guard = () => {
    if (opts.scopes === "legacy-only") throw err(401, "missing scopes (tables.write)");
  };
  const column = (type: string) => async (p: { tableId: string; key: string } & Record<string, unknown>) => {
    guard();
    calls.push(`column:${p.tableId}.${p.key}:${type}`);
    const t = table(p.tableId);
    if (t.columns.has(p.key)) throw err(409, "Column exists");
    t.columns.set(p.key, { status: "processing", type, args: p });
    return {};
  };

  const parse = (queries: string[] = []) => queries.map((q) => JSON.parse(q) as { method: string; attribute?: string; values?: unknown[] });

  const api = {
    async create(p: { databaseId: string }) {
      guard();
      calls.push(`db:${p.databaseId}`);
      if (databases.has(p.databaseId)) throw err(409, "Database exists");
      databases.add(p.databaseId);
      return {};
    },
    async createTable(p: { tableId: string; name: string; permissions?: string[]; rowSecurity?: boolean }) {
      guard();
      calls.push(`table:${p.tableId}`);
      if (tables.has(p.tableId)) throw err(409, "Table exists");
      tables.set(p.tableId, { name: p.name, permissions: p.permissions ?? [], rowSecurity: !!p.rowSecurity, columns: new Map(), indexes: new Map(), rows: new Map() });
      return {};
    },
    async updateTable(p: { tableId: string; permissions?: string[] | null; rowSecurity?: boolean }) {
      guard();
      calls.push(`updateTable:${p.tableId}`);
      const t = table(p.tableId);
      t.permissions = p.permissions ?? [];
      t.rowSecurity = !!p.rowSecurity;
      return {};
    },
    async listColumns(p: { tableId: string }) {
      polls++;
      const t = table(p.tableId);
      if (polls > (opts.columnsAvailableAfterPolls ?? 0)) for (const c of t.columns.values()) c.status = "available";
      return { columns: [...t.columns.entries()].map(([key, c]) => ({ key, status: c.status })) };
    },
    createVarcharColumn: column("varchar"), createTextColumn: column("text"), createEnumColumn: column("enum"),
    createIntegerColumn: column("integer"), createFloatColumn: column("float"), createDatetimeColumn: column("datetime"),
    async createIndex(p: { tableId: string; key: string; columns: string[] }) {
      guard();
      calls.push(`index:${p.tableId}#${p.key}`);
      const t = table(p.tableId);
      for (const c of p.columns) if (t.columns.get(c)?.status !== "available") throw err(400, `Column ${c} not available`);
      if (t.indexes.has(p.key)) throw err(409, "Index exists");
      t.indexes.set(p.key, p);
      return {};
    },

    // ---- rows ----
    async createRow(p: { tableId: string; rowId: string; data: Record<string, unknown>; permissions?: string[] | null }) {
      const t = table(p.tableId);
      if (t.rows.has(p.rowId)) throw err(409, "Row exists");
      const now = tick();
      const row: Row = { ...p.data, $id: p.rowId, $createdAt: now, $updatedAt: now, $permissions: p.permissions ?? [] };
      t.rows.set(p.rowId, row);
      return { ...row };
    },
    async getRow(p: { tableId: string; rowId: string; queries?: string[] }) {
      const row = table(p.tableId).rows.get(p.rowId);
      if (!row) throw err(404, "Row not found");
      const select = parse(p.queries).find((q) => q.method === "select")?.values as string[] | undefined;
      return select ? pick(row, select) : { ...row };
    },
    async updateRow(p: { tableId: string; rowId: string; data?: Record<string, unknown> }) {
      const row = table(p.tableId).rows.get(p.rowId);
      if (!row) throw err(404, "Row not found");
      Object.assign(row, p.data ?? {}, { $updatedAt: tick() });
      return { ...row };
    },
    async deleteRow(p: { tableId: string; rowId: string }) {
      if (!table(p.tableId).rows.delete(p.rowId)) throw err(404, "Row not found");
      return {};
    },
    async listRows(p: { tableId: string; queries?: string[] }) {
      const qs = parse(p.queries);
      let rows = [...table(p.tableId).rows.values()];
      for (const q of qs.filter((x) => x.method === "equal")) {
        rows = rows.filter((r) => (q.values as unknown[]).includes(q.attribute === "$id" ? r.$id : r[q.attribute as string]));
      }
      if (qs.some((q) => q.method === "orderDesc")) rows.sort((a, b) => (a.$createdAt < b.$createdAt ? 1 : -1));
      const cursor = qs.find((q) => q.method === "cursorAfter")?.values?.[0] as string | undefined;
      if (cursor) rows = rows.slice(rows.findIndex((r) => r.$id === cursor) + 1);
      const limit = qs.find((q) => q.method === "limit")?.values?.[0] as number | undefined;
      if (limit) rows = rows.slice(0, limit);
      const select = qs.find((q) => q.method === "select")?.values as string[] | undefined;
      return { total: rows.length, rows: rows.map((r) => (select ? pick(r, select) : { ...r })) };
    }
  };

  return { api, state: { databases, tables }, calls };
}

/** Appwrite's `select` returns the chosen columns plus the system fields. */
function pick(row: Row, cols: string[]): Row {
  const out: Record<string, unknown> = { $id: row.$id, $createdAt: row.$createdAt, $updatedAt: row.$updatedAt, $permissions: row.$permissions };
  for (const c of cols) out[c] = row[c];
  return out as Row;
}
