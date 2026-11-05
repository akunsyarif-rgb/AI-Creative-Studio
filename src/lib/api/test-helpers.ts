import { randomBytes } from "node:crypto";
import type { ApiDeps } from "./handlers";
import { createRateLimiter, type RateLimitRule } from "./rate-limit";
import type { AssetRecord, JobPatch, JobRecord, KeyMetadata, NewJob } from "@/lib/data/repositories";
import {
  ProviderError,
  type CostEstimate,
  type ProviderAdapter,
  type ProviderJobRequest,
  type ProviderJobResult
} from "@/lib/providers/types";
import { createProviderRegistry } from "@/lib/providers/registry";
import { createR2Storage, type ObjectInfo } from "@/lib/storage/r2";
import { decryptWithKeyring, encryptWithKeyring, parseKeyring } from "@/lib/security/secrets-core";

export const ALICE = "token-for-alice-0000000000";
export const BOB = "token-for-bob-000000000000";
const TOKENS: Record<string, string> = { [ALICE]: "alice", [BOB]: "bob" };

export const verifyToken: ApiDeps["verifyToken"] = async (t) => (TOKENS[t] ? { userId: TOKENS[t] } : null);

export function jsonRequest(url: string, init: { token?: string; method?: string; body?: unknown; raw?: string; contentType?: string } = {}) {
  return new Request(`http://localhost${url}`, {
    method: init.method ?? "POST",
    headers: { ...(init.token ? { authorization: `Bearer ${init.token}` } : {}), "content-type": init.contentType ?? "application/json" },
    body: init.raw ?? (init.body === undefined ? undefined : JSON.stringify(init.body))
  });
}

export const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);

export interface FakeAdapterOptions {
  estimate?: CostEstimate | null;
  submit?: (request: ProviderJobRequest, secret: string, inputs: number) => Promise<ProviderJobResult>;
  validCredential?: string;
  credentialError?: ProviderError;
}

export function fakeAdapter(options: FakeAdapterOptions = {}) {
  const calls = { submit: 0, validate: 0 };
  const adapter: ProviderAdapter = {
    config: {
      id: "fake",
      name: "Fake Provider",
      availableModels: [
        {
          modelId: "m1", displayName: "M1", capabilities: ["text_to_image", "image_to_image"],
          parameters: [{ key: "size", label: "Size", default: "s", options: [{ value: "s", label: "Small" }] }]
        }
      ]
    },
    getCapabilities: () => ["text_to_image", "image_to_image"],
    validateRequest(request) {
      if (typeof request.parameters.prompt !== "string" || !request.parameters.prompt) {
        throw new ProviderError("invalid_request", "Invalid parameters: prompt", true);
      }
      if (request.capability === "image_to_image" && request.inputAssetIds.length !== 1) {
        throw new ProviderError("invalid_request", "image_to_image requires exactly one input image.", true);
      }
    },
    async testKey(secret) {
      calls.validate++;
      if (options.credentialError) throw options.credentialError;
      return secret === (options.validCredential ?? "good-key") ? { valid: true } : { valid: false, message: "The provider rejected this API key." };
    },
    estimateCost: async () => options.estimate ?? null,
    async executeJob(request, _key, ctx) {
      calls.submit++;
      if (options.submit) return options.submit(request, ctx.secret, ctx.inputFiles.length);
      return { status: "validating", outputFiles: [{ contentType: "image/png", data: PNG }] };
    }
  };
  return { adapter, calls };
}

export interface TestWorld {
  deps: ApiDeps;
  jobs: Map<string, JobRecord>;
  assets: Map<string, AssetRecord>;
  keys: Map<string, KeyMetadata & { ciphertext: string }>;
  objects: Map<string, { data: Uint8Array; contentType: string }>;
  tasks: (() => Promise<void>)[];
  runTasks(): Promise<void>;
  seedKey(owner: string, provider: string, secret: string): void;
  seedAsset(a: Partial<AssetRecord> & { id: string; ownerId: string }): AssetRecord;
  calls: { submit: number; validate: number };
}

const RING = parseKeyring(`k1:${randomBytes(32).toString("base64")}`);

export function createTestWorld(opts: { adapter?: FakeAdapterOptions; maxJobCostUsd?: number; limits?: Record<string, RateLimitRule>; deps?: Partial<ApiDeps> } = {}): TestWorld {
  const jobs = new Map<string, JobRecord>();
  const assets = new Map<string, AssetRecord>();
  const keys = new Map<string, KeyMetadata & { ciphertext: string }>();
  const objects = new Map<string, { data: Uint8Array; contentType: string }>();
  const tasks: (() => Promise<void>)[] = [];
  let seq = 0;
  const { adapter, calls } = fakeAdapter(opts.adapter);
  const kid = (o: string, p: string) => `${o}/${p}`;
  const keyMeta = (r: KeyMetadata): KeyMetadata => ({ providerId: r.providerId, last4: r.last4, validationStatus: r.validationStatus, createdAt: r.createdAt, updatedAt: r.updatedAt });

  const base = createR2Storage({ endpoint: "https://acct.r2.cloudflarestorage.com", bucket: "b", accessKeyId: "AK", secretAccessKey: "SK" });

  const deps: ApiDeps = {
    verifyToken,
    jobs: {
      async createIdempotent(job: NewJob) {
        const existing = [...jobs.values()].find((j) => j.ownerId === job.ownerId && j.idempotencyKey === job.idempotencyKey);
        if (existing) return { job: existing, created: false };
        const record: JobRecord = {
          ...job, id: `job${++seq}`, status: "queued", progress: null, errorCode: null, errorMessage: null, outputAssetIds: [],
          estimatedCost: job.estimatedCost ?? null, currency: job.currency ?? null, createdAt: "2026-01-01T00:00:00.000Z"
        };
        jobs.set(record.id, record);
        return { job: record, created: true };
      },
      async listByOwner(ownerId, limit) { return [...jobs.values()].filter((j) => j.ownerId === ownerId).slice(0, limit); },
      async getOwned(ownerId, id) { const j = jobs.get(id); return j && j.ownerId === ownerId ? j : null; },
      async update(id: string, patch: JobPatch) { Object.assign(jobs.get(id)!, patch); }
    },
    assets: {
      async createPendingUpload(i) {
        const a: AssetRecord = { id: `asset${++seq}`, ownerId: i.ownerId, objectKey: i.objectKey, contentType: i.contentType, size: i.size, status: "pending" };
        assets.set(a.id, a);
        return a;
      },
      async createGenerated(i) {
        const a: AssetRecord = { id: `gen${++seq}`, ownerId: i.ownerId, objectKey: i.objectKey, contentType: i.contentType, size: i.size, status: "uploaded" };
        assets.set(a.id, a);
        return a;
      },
      async findOwned(ownerId, ids) { return ids.map((i) => assets.get(i)).filter((a): a is AssetRecord => !!a && a.ownerId === ownerId); },
      async setStatus(id, status) { const a = assets.get(id); if (a) a.status = status; }
    },
    keys: {
      async create(i) {
        if (keys.has(kid(i.ownerId, i.providerId))) return null;
        const row = { providerId: i.providerId, last4: i.last4, validationStatus: "unvalidated" as const, createdAt: "t0", updatedAt: "t0", ciphertext: i.ciphertext };
        keys.set(kid(i.ownerId, i.providerId), row);
        return keyMeta(row);
      },
      async replace(i) {
        const row = keys.get(kid(i.ownerId, i.providerId));
        if (!row) return null;
        Object.assign(row, { ciphertext: i.ciphertext, last4: i.last4, validationStatus: "unvalidated", updatedAt: "t1" });
        return keyMeta(row);
      },
      async get(o, p) { const r = keys.get(kid(o, p)); return r ? keyMeta(r) : null; },
      async getCiphertext(o, p) { return keys.get(kid(o, p))?.ciphertext ?? null; },
      async setValidation(o, p, status) { const r = keys.get(kid(o, p)); if (!r) return false; r.validationStatus = status; return true; },
      async list(o) { return [...keys.entries()].filter(([k]) => k.startsWith(`${o}/`)).map(([, r]) => keyMeta(r)); },
      async delete(o, p) { return keys.delete(kid(o, p)); }
    },
    storage: {
      ...base,
      async headObject({ key }): Promise<ObjectInfo | null> {
        const o = objects.get(key);
        return o ? { size: o.data.length, contentType: o.contentType } : null;
      },
      async readObject({ key, bytes }) {
        const o = objects.get(key);
        if (!o) throw new Error("missing object");
        return bytes ? o.data.slice(0, bytes) : o.data;
      },
      async putObject({ key, contentType, data }) {
        if (objects.has(key)) throw new Error("exists");
        objects.set(key, { data, contentType });
      },
      async deleteObject({ key }) { objects.delete(key); }
    },
    vault: {
      encrypt: async (p, c) => encryptWithKeyring(RING, p, c),
      decrypt: async (c, ctx) => decryptWithKeyring(RING, c, ctx)
    },
    providers: createProviderRegistry([adapter]),
    limiter: createRateLimiter(opts.limits ?? { keys: { limit: 1000, windowSeconds: 60 }, uploads: { limit: 1000, windowSeconds: 60 }, providerTest: { limit: 1000, windowSeconds: 60 }, jobs: { limit: 1000, windowSeconds: 60 } }),
    scheduler: { run: (t) => { tasks.push(t); } },
    maxJobCostUsd: opts.maxJobCostUsd ?? 1,
    ...opts.deps
  };

  const world: TestWorld = {
    deps, jobs, assets, keys, objects, tasks, calls,
    async runTasks() { while (tasks.length) await tasks.shift()!(); },
    seedKey(owner, provider, secret) {
      const ciphertext = encryptWithKeyring(RING, secret, `provider-credential:${owner}:${provider}`);
      keys.set(kid(owner, provider), { providerId: provider, last4: null, validationStatus: "unvalidated", createdAt: "t0", updatedAt: "t0", ciphertext });
    },
    seedAsset(a) {
      const record: AssetRecord = { objectKey: `users/${a.ownerId}/123e4567-e89b-12d3-a456-4266141740${String(++seq).padStart(2, "0")}`, contentType: "image/png", size: PNG.length, status: "uploaded", ...a };
      assets.set(record.id, record);
      return record;
    }
  };
  return world;
}
