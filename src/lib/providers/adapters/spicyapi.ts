import { createHash } from "node:crypto";
import { z } from "zod";
import { readLimited } from "@/lib/net/public-url";
import type { CustomProviderConfig } from "@/lib/data/repositories";
import { sniffMime } from "@/lib/storage/sniff";
import { MAX_IMAGE_BYTES, createSafeIO, mapStatus, type SafeIODeps } from "./safe-io";
import {
  ProviderError,
  type CostEstimate,
  type ProviderAdapter,
  type ProviderConfig,
  type ProviderExecutionContext,
  type ProviderJobRequest,
  type ProviderJobResult
} from "../types";

/**
 * SpicyAPI's native asynchronous task API (https://docs.spicyapi.ai), text-to-image only:
 *   POST /api/v1/jobs/createTask      {model, input:{prompt}}  -> 202 {data:{taskId, estimatedCost}}   (billable, ONE attempt)
 *   GET  /api/v1/jobs/recordInfo?taskId=...                    -> state queued|running|succeeded|failed|expired (free)
 *   data.output.assets[0].url                                  -> signed download link
 *
 * Model ids come from the user's own SpicyAPI catalog and are saved like any custom provider's models.
 * Only `prompt` is sent in `input`: other fields differ per model and unknown ones are rejected (nothing charged).
 * Out of scope on purpose: image-to-image, reference images and the "subject swap" (face/head replacement) tools.
 * The price is unknown to the app (the hold is returned only after acceptance), so each request needs explicit
 * consent; set a spend cap on the SpicyAPI key for a hard limit.
 */

export const SPICY_HOST = "api.spicyapi.ai";
export const SPICY_API_BASE = `https://${SPICY_HOST}/api/v1`;

/** True when a custom provider's base URL points at SpicyAPI's own API host. */
export function isSpicyBaseUrl(baseUrl: string): boolean {
  try {
    const u = new URL(baseUrl);
    return u.protocol === "https:" && u.hostname === SPICY_HOST;
  } catch {
    return false;
  }
}

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const MAX_JSON_BYTES = 1024 * 1024;
const PARAMS = z.object({ prompt: z.string().trim().min(1).max(4000) }).strict();

/** Total time spent waiting for one task. The route allows 300 s, so stay well inside it. */
export const POLL_BUDGET_MS = 240_000;

export interface SpicyDeps extends SafeIODeps {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

interface Envelope {
  code?: unknown;
  msg?: unknown;
  data?: Record<string, unknown>;
}

async function readEnvelope(res: Response): Promise<Envelope> {
  try {
    return JSON.parse(new TextDecoder().decode(await readLimited(res, MAX_JSON_BYTES))) as Envelope;
  } catch {
    return {};
  }
}

/** Business codes from the docs (40201 balance, 40202 spend cap, 40301 model not allowed, 40901 conflict, ...). */
function mapCreateError(status: number, code: unknown, msg: unknown): ProviderError {
  if (status === 402 || code === 40201 || code === 40202) {
    return new ProviderError("insufficient_funds", code === 40202 ? "The SpicyAPI spend cap for this key was reached." : "The SpicyAPI balance is too low.", true);
  }
  if (status === 403 && code === 40301) return new ProviderError("invalid_request", "This SpicyAPI key is not allowed to use that model.", true);
  if (status === 409) return new ProviderError("invalid_request", "SpicyAPI reported a conflicting request. Nothing was charged.", true);
  if (status === 413) return new ProviderError("invalid_request", "The request was too large.", true);
  // SpicyAPI documents that an error from createTask holds and charges nothing, so the outcome is known.
  const mapped = mapStatus(status);
  // SpicyAPI's validation text (e.g. unknown model, bad field) is safe to show and explains a 400.
  const detail = status === 400 && typeof msg === "string" ? ` SpicyAPI says: ${msg.replace(/[^\x20-\x7E]/g, " ").slice(0, 200)}` : "";
  return new ProviderError(mapped.code, `${mapped.message}${detail}`, true);
}

export function createSpicyApiAdapter(cfg: CustomProviderConfig, deps: SpicyDeps = {}): ProviderAdapter {
  const config: ProviderConfig = {
    id: cfg.providerId,
    name: cfg.label,
    description: "SpicyAPI (native task API). Text-to-image only. The price is not known in advance, so you confirm each request; set a spend cap on the key.",
    availableModels: cfg.models.map((modelId) => ({ modelId, displayName: modelId, capabilities: ["text_to_image" as const], isFreeTier: false, parameters: [] }))
  };
  const io = createSafeIO(SPICY_API_BASE, deps);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const auth = (secret: string) => ({ Authorization: `Bearer ${secret}`, Accept: "application/json" });

  async function pollTask(taskId: string, secret: string): Promise<Record<string, unknown>> {
    const started = now();
    let delay = 2000;
    for (;;) {
      await sleep(delay);
      delay = Math.min(delay + 1000, 8000);
      let res: Response | null = null;
      try {
        res = await io.call(`/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`, { method: "GET", headers: auth(secret) });
      } catch {
        res = null; // reading is free: try again until the budget is spent
      }
      if (res && (res.status === 401 || res.status === 403)) throw new ProviderError("auth", `SpicyAPI rejected the API key while waiting. The task (${taskId}) may still be billed.`, false);
      if (res?.ok) {
        const data = (await readEnvelope(res)).data ?? {};
        const state = data.state;
        if (state === "succeeded" || state === "failed" || state === "expired") return data;
      }
      if (now() - started >= POLL_BUDGET_MS) {
        throw new ProviderError("timeout", `SpicyAPI did not finish task ${taskId} in time. It may still finish and be billed; check your SpicyAPI task history. It was not submitted again.`, false);
      }
    }
  }

  return {
    config,
    getCapabilities: () => ["text_to_image"],

    validateRequest(request) {
      if (!cfg.models.includes(request.modelId) || request.capability !== "text_to_image") {
        throw new ProviderError("invalid_request", "Unsupported model or capability.", true);
      }
      const parsed = PARAMS.safeParse(request.parameters);
      if (!parsed.success) throw new ProviderError("invalid_request", "Invalid parameters: only a prompt is supported for SpicyAPI.", true);
      if (request.inputAssetIds.length > 0) throw new ProviderError("invalid_request", "This provider does not accept input images.", true);
    },

    async testKey(secret) {
      // The model catalog is free to read and needs a valid key.
      const res = await io.call("/models?modality=image", { method: "GET", headers: auth(secret) });
      if (res.ok) return { valid: true };
      if (res.status === 401 || res.status === 403) return { valid: false, message: "SpicyAPI rejected this API key." };
      throw mapStatus(res.status);
    },

    async estimateCost(): Promise<CostEstimate | null> {
      return cfg.estimatedCostUsd === null
        ? { amount: null, currency: "USD", isEstimate: true, notes: "SpicyAPI holds the price when the task is accepted (often cents per image). Set a spend cap on the key for a hard limit." }
        : { amount: cfg.estimatedCostUsd, currency: "USD", isEstimate: true, notes: "Your own estimate; SpicyAPI's hold may differ." };
    },

    async executeJob(request: ProviderJobRequest, idempotencyKey: string, context: ProviderExecutionContext): Promise<ProviderJobResult> {
      const params = PARAMS.parse(request.parameters);
      // One attempt only. The idempotency key (derived from the job's) is for SpicyAPI's own replay protection.
      const res = await io.call("/jobs/createTask", {
        method: "POST",
        headers: { ...auth(context.secret), "Content-Type": "application/json", "Idempotency-Key": createHash("sha256").update(`studio:${idempotencyKey}`).digest("hex").slice(0, 48) },
        body: JSON.stringify({ model: request.modelId, input: { prompt: params.prompt } })
      });
      const envelope = await readEnvelope(res);
      if (!res.ok) throw mapCreateError(res.status, envelope.code, envelope.msg);
      const taskId = envelope.data?.taskId;
      if (typeof taskId !== "string" || !/^job_[A-Za-z0-9]{6,64}$/.test(taskId)) {
        throw new ProviderError("unknown", "SpicyAPI accepted the request but returned no task id. Check your SpicyAPI task history before retrying.", false);
      }

      const done = await pollTask(taskId, context.secret);
      if (done.state !== "succeeded") {
        const code = done.errorCode;
        if (code === "content_rejected") throw new ProviderError("content_policy", "SpicyAPI refused this prompt. It may have been charged; check the task history.", false);
        // Failed and expired tasks normally release the hold.
        throw new ProviderError(done.state === "expired" ? "timeout" : "unavailable", `SpicyAPI could not finish the task (${typeof code === "string" ? code : String(done.state)}). The hold is normally released.`, true);
      }
      const assets = (done.output as { assets?: { url?: unknown }[] } | undefined)?.assets;
      const url = assets?.[0]?.url;
      if (typeof url !== "string") throw new ProviderError("unknown", `The task ${taskId} succeeded but returned no image link.`, false);

      const data = await io.downloadImage(url);
      if (data.length === 0 || data.length > MAX_IMAGE_BYTES) throw new ProviderError("unknown", "SpicyAPI returned an invalid image.", false);
      const contentType = sniffMime(data);
      if (!contentType || !IMAGE_TYPES.has(contentType)) throw new ProviderError("unknown", "SpicyAPI returned an unsupported image type.", false);
      const cost = typeof done.cost === "string" ? Number(done.cost) : NaN;
      return {
        providerJobId: taskId,
        status: "validating",
        outputFiles: [{ contentType, data }],
        ...(Number.isFinite(cost) ? { estimatedCost: { amount: cost, currency: "USD", isEstimate: true as const, notes: "Final charge reported by SpicyAPI." } } : {})
      };
    }
  };
}
