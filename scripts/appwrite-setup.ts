/**
 * Idempotent Appwrite provisioning for AI Creative Studio (TablesDB).
 * Run manually, only after approving the target project:
 *   APPWRITE_ENDPOINT=... APPWRITE_PROJECT_ID=... APPWRITE_API_KEY=... \
 *   APPWRITE_DATABASE_ID=... npm run appwrite:setup
 * Required API-key scopes: databases.read/write, tables.read/write, columns.read/write, indexes.read/write.
 * The key is read from the environment and never logged.
 */
import { Client, TablesDB } from "node-appwrite";
import { provision } from "../src/lib/appwrite/provision.ts";
import { TABLE_SPECS } from "../src/lib/appwrite/schema.ts";

const REQUIRED = ["APPWRITE_ENDPOINT", "APPWRITE_PROJECT_ID", "APPWRITE_API_KEY", "APPWRITE_DATABASE_ID"] as const;
const missing = REQUIRED.filter((name) => !process.env[name]);
if (missing.length) {
  console.error(`Missing required environment variables: ${missing.join(", ")}`);
  process.exit(1);
}
const env = (name: (typeof REQUIRED)[number]) => process.env[name] as string;

const tables = new TablesDB(
  new Client().setEndpoint(env("APPWRITE_ENDPOINT")).setProject(env("APPWRITE_PROJECT_ID")).setKey(env("APPWRITE_API_KEY"))
);

provision(tables, env("APPWRITE_DATABASE_ID"), TABLE_SPECS, { log: (line) => console.log(line) }).catch((error) => {
  // Appwrite errors carry a safe message (e.g. "missing scopes"); the key itself is never part of it.
  console.error(error instanceof Error ? error.message : "Provisioning failed.");
  process.exit(1);
});
