/**
 * Idempotent Appwrite provisioning for AI Creative Studio.
 * Run manually, only after approving the target project:
 *   APPWRITE_ENDPOINT=... APPWRITE_PROJECT_ID=... APPWRITE_API_KEY=... \
 *   APPWRITE_DATABASE_ID=... npm run appwrite:setup
 * The API key needs databases.write, collections.write, attributes.write,
 * indexes.write. It is read from the environment and never logged.
 */
import { AppwriteException, Client, Databases, DatabasesIndexType } from "node-appwrite";
import { COLLECTION_SPECS, type AttributeSpec } from "../src/lib/appwrite/schema.ts";

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}

const databaseId = env("APPWRITE_DATABASE_ID");
const databases = new Databases(
  new Client().setEndpoint(env("APPWRITE_ENDPOINT")).setProject(env("APPWRITE_PROJECT_ID")).setKey(env("APPWRITE_API_KEY"))
);

async function ignoreExists<T>(label: string, op: () => Promise<T>): Promise<void> {
  try {
    await op();
    console.log(`created  ${label}`);
  } catch (error) {
    if (error instanceof AppwriteException && error.code === 409) {
      console.log(`exists   ${label}`);
      return;
    }
    throw error;
  }
}

function createAttribute(collectionId: string, a: AttributeSpec): Promise<unknown> {
  const base = { databaseId, collectionId, key: a.key, required: a.required };
  switch (a.type) {
    case "string":
      return databases.createStringAttribute({ ...base, size: a.size, array: a.array });
    case "enum":
      return databases.createEnumAttribute({ ...base, elements: a.elements });
    case "integer":
      return databases.createIntegerAttribute({ ...base, min: a.min, max: a.max });
    case "float":
      return databases.createFloatAttribute({ ...base, min: a.min });
    case "datetime":
      return databases.createDatetimeAttribute(base);
  }
}

async function waitForAttributes(collectionId: string): Promise<void> {
  for (let i = 0; i < 60; i++) {
    const { attributes } = await databases.listAttributes({ databaseId, collectionId });
    const failed = attributes.filter((a) => a.status === "failed");
    if (failed.length) throw new Error(`Attributes failed in ${collectionId}: ${failed.map((a) => a.key).join(", ")}`);
    if (attributes.every((a) => a.status === "available")) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Timed out waiting for attributes in ${collectionId}`);
}

async function main() {
  await ignoreExists(`database ${databaseId}`, () => databases.create({ databaseId, name: "AI Creative Studio" }));
  for (const spec of COLLECTION_SPECS) {
    await ignoreExists(`collection ${spec.id}`, () =>
      databases.createCollection({
        databaseId,
        collectionId: spec.id,
        name: spec.name,
        permissions: spec.permissions,
        documentSecurity: spec.documentSecurity
      })
    );
    // Re-assert security settings on existing collections (drift protection).
    await databases.updateCollection({
      databaseId,
      collectionId: spec.id,
      name: spec.name,
      permissions: spec.permissions,
      documentSecurity: spec.documentSecurity
    });
    for (const attribute of spec.attributes) {
      await ignoreExists(`${spec.id}.${attribute.key}`, () => createAttribute(spec.id, attribute));
    }
    await waitForAttributes(spec.id);
    for (const index of spec.indexes) {
      await ignoreExists(`${spec.id}#${index.key}`, () =>
        databases.createIndex({ databaseId, collectionId: spec.id, key: index.key, type: index.type === "unique" ? DatabasesIndexType.Unique : DatabasesIndexType.Key, attributes: index.attributes })
      );
    }
  }
  console.log("Appwrite schema is up to date.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
