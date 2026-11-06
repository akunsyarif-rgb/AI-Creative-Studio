import { createHash } from "node:crypto";
import { z } from "zod";
import { readLimited } from "@/lib/net/public-url";
import type { CustomProviderConfig } from "@/lib/data/repositories";
import { sniffMime } from "@/lib/storage/sniff";
import { MAX_IMAGE_BYTES, MAX_VIDEO_BYTES, createSafeIO, mapStatus, type SafeIODeps } from "./safe-io";
import { userPriceFor } from "../pricing";
import {
  ProviderError,
  type CostEstimate,
  type Capability,
  type ProviderAdapter,
  type ProviderConfig,
  type ProviderExecutionContext,
  type ProviderJobRequest,
  type ProviderJobResult
} from "../types";

/**
 * SpicyAPI's native asynchronous task API (https://docs.spicyapi.ai): text-to-image and single-image edit:
 *   POST /api/v1/jobs/createTask      {model, input:{prompt}}  -> 202 {data:{taskId, estimatedCost}}   (billable, ONE attempt)
 *   GET  /api/v1/jobs/recordInfo?taskId=...                    -> state queued|running|succeeded|failed|expired (free)
 *   data.output.assets[0].url                                  -> signed download link
 *
 * Model ids come from the user's own SpicyAPI catalog and are saved like any custom provider's models.
 * What a model can do is read from its id suffix (`.../text-to-image`, `.../edit`). Text-to-image sends only `prompt`.
 * Edit reads the model's own input schema first (free) and sends only fields it declares, failing BEFORE any
 * billable call when a required field cannot be filled. Out of scope on purpose: the "subject swap"
 * (face/head replacement) tools and multi-image inputs.
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
const VIDEO_TYPES = new Set(["video/mp4", "video/webm", "video/quicktime"]);
const MAX_JSON_BYTES = 1024 * 1024;
const PARAMS = z.object({ prompt: z.string().trim().min(1).max(4000) }).strict();
const VIDEO_PARAMS = z.object({ prompt: z.string().trim().min(1).max(4000), duration: z.coerce.number().int().min(1).max(30).optional() }).strict();
const DURATION_PARAM = {
  key: "duration", label: "Length (seconds)", default: "5",
  options: ["3", "5", "8", "10", "15"].map((v) => ({ value: v, label: `${v} seconds` }))
};
const isVideo = (c: Capability) => c === "text_to_video" || c === "image_to_video";
/** Inputs travel as data: URIs (SpicyAPI documents only "small" ones), so keep them modest. */
export const MAX_EDIT_INPUT_BYTES = 3 * 1024 * 1024;

/** What a SpicyAPI model id can do, from its task suffix. Anything unrecognised is treated as text-to-image. */
export function capabilitiesForModel(modelId: string): Capability[] {
  if (/\/edit$/.test(modelId)) return ["image_to_image"];
  if (/\/image-to-video$/.test(modelId)) return ["image_to_video"];
  if (/\/text-to-video$/.test(modelId)) return ["text_to_video"];
  return ["text_to_image"];
}

function encodeModelPath(modelId: string): string {
  return modelId.split("/").map(encodeURIComponent).join("/");
}

interface SchemaProperty { type?: unknown; default?: unknown; minItems?: unknown; maxItems?: unknown; enum?: unknown; minimum?: unknown; maximum?: unknown }

interface InputPlan { prompt: string; dataUri?: string; duration?: number }

/**
 * Builds `input` from the model's own schema; throws a known-outcome error (nothing billable happened) if it cannot.
 * Sends only fields the schema declares. `dataUri` set = the model must accept one input image.
 */
export function buildInput(schema: unknown, plan: InputPlan): Record<string, unknown> {
  const s = schema as { properties?: Record<string, SchemaProperty>; required?: unknown } | null;
  const props = s && typeof s === "object" ? s.properties : undefined;
  if (!props || typeof props !== "object") throw new ProviderError("invalid_request", "Could not read this model's input fields, so nothing was sent.", true);
  if (!("prompt" in props)) throw new ProviderError("invalid_request", "This model does not take a text prompt.", true);
  const input: Record<string, unknown> = { prompt: plan.prompt };
  if (plan.dataUri !== undefined) {
    const array = props.image_urls;
    if (array && (array.type === "array" || array.type === undefined)) {
      if (typeof array.minItems === "number" && array.minItems > 1) throw new ProviderError("invalid_request", `This model needs at least ${array.minItems} input images; only one is supported here.`, true);
      input.image_urls = [plan.dataUri];
    } else if (props.image_url) {
      input.image_url = plan.dataUri;
    } else {
      throw new ProviderError("invalid_request", "This model does not accept an input image. Choose a different model.", true);
    }
  }
  if (plan.duration !== undefined) {
    const key = "duration_seconds" in props ? "duration_seconds" : "duration" in props ? "duration" : null;
    if (key) {
      const d = props[key];
      if (Array.isArray(d.enum) && !d.enum.some((v) => Number(v) === plan.duration)) {
        throw new ProviderError("invalid_request", `This model allows lengths of ${d.enum.slice(0, 8).join(", ")} seconds. Nothing was sent.`, true);
      }
      if ((typeof d.minimum === "number" && plan.duration < d.minimum) || (typeof d.maximum === "number" && plan.duration > d.maximum)) {
        throw new ProviderError("invalid_request", `This model allows ${d.minimum ?? "any"}–${d.maximum ?? "any"} seconds. Nothing was sent.`, true);
      }
      input[key] = d.type === "string" ? String(plan.duration) : plan.duration;
    }
  }
  const required = Array.isArray(s?.required) ? (s!.required as unknown[]).filter((k): k is string => typeof k === "string") : [];
  const missing = required.filter((k) => !(k in input) && props[k]?.default === undefined);
  if (missing.length) throw new ProviderError("invalid_request", `This model needs fields this app cannot fill yet (${missing.slice(0, 5).join(", ")}). Nothing was sent.`, true);
  return input;
}

/** Edit input: prompt plus exactly one image. */
export function buildEditInput(schema: unknown, prompt: string, dataUri: string): Record<string, unknown> {
  return buildInput(schema, { prompt, dataUri });
}

/** The error for a task that ended without a result. Failed and expired tasks normally release the hold. */
function taskEndedError(done: Record<string, unknown>): ProviderError {
  const code = done.errorCode;
  if (code === "content_rejected") return new ProviderError("content_policy", "SpicyAPI refused this prompt. It may have been charged; check the task history.", false);
  return new ProviderError(done.state === "expired" ? "timeout" : "unavailable", `SpicyAPI could not finish the task (${typeof code === "string" ? code : String(done.state)}). The hold is normally released.`, true);
}

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
    description: "SpicyAPI (native task API). Images (text-to-image, single-image edit) and video (text-to-video, image-to-video; collected in the background). The price is not known in advance, so you confirm each request; set a spend cap on the key.",
    availableModels: cfg.models.map((modelId) => {
      const capabilities = capabilitiesForModel(modelId);
      return { modelId, displayName: modelId, capabilities, isFreeTier: false, parameters: capabilities.some(isVideo) ? [DURATION_PARAM] : [] };
    })
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
    getCapabilities: () => [...new Set(cfg.models.flatMap(capabilitiesForModel))],

    validateRequest(request) {
      if (!cfg.models.includes(request.modelId) || !capabilitiesForModel(request.modelId).includes(request.capability)) {
        throw new ProviderError("invalid_request", "Unsupported model or capability.", true);
      }
      const parsed = (isVideo(request.capability) ? VIDEO_PARAMS : PARAMS).safeParse(request.parameters);
      if (!parsed.success) throw new ProviderError("invalid_request", "Invalid parameters for this model.", true);
      const wanted = request.capability === "image_to_image" || request.capability === "image_to_video" ? 1 : 0;
      if (request.inputAssetIds.length !== wanted) {
        throw new ProviderError("invalid_request", wanted ? "Choose exactly one image to edit." : "This model does not accept input images.", true);
      }
    },

    async testKey(secret) {
      // The model catalog is free to read and needs a valid key.
      const res = await io.call("/models?modality=image", { method: "GET", headers: auth(secret) });
      if (res.ok) return { valid: true };
      if (res.status === 401 || res.status === 403) return { valid: false, message: "SpicyAPI rejected this API key." };
      throw mapStatus(res.status);
    },

    async estimateCost(request?: ProviderJobRequest): Promise<CostEstimate | null> {
      const price = userPriceFor(cfg, request?.modelId);
      return price === null
        ? { amount: null, currency: "USD", isEstimate: true, notes: "SpicyAPI holds the price when the task is accepted (often cents per image). Set a spend cap on the key for a hard limit." }
        : { amount: price, currency: "USD", isEstimate: true, notes: "Your own estimate; SpicyAPI's hold may differ." };
    },

    /** One free read of a running task. Transient problems keep it "processing"; only a definite end throws. */
    async getJobStatus(providerJobId, secret): Promise<ProviderJobResult> {
      if (!/^job_[A-Za-z0-9]{6,64}$/.test(providerJobId)) throw new ProviderError("invalid_request", "Invalid task id.", true);
      let res: Response;
      try {
        res = await io.call(`/jobs/recordInfo?taskId=${encodeURIComponent(providerJobId)}`, { method: "GET", headers: auth(secret) });
      } catch {
        return { providerJobId, status: "processing" };
      }
      if (res.status === 401 || res.status === 403) throw new ProviderError("auth", `SpicyAPI rejected the API key while collecting the result. Task ${providerJobId} may still be billed.`, false);
      if (res.status === 404) throw new ProviderError("unavailable", `SpicyAPI does not know task ${providerJobId}.`, true);
      if (!res.ok) return { providerJobId, status: "processing" };
      const data = (await readEnvelope(res)).data ?? {};
      if (data.state === "failed" || data.state === "expired") throw taskEndedError(data);
      if (data.state !== "succeeded") return { providerJobId, status: "processing", progress: data.state === "running" ? 40 : 15 };
      const url = (data.output as { assets?: { url?: unknown }[] } | undefined)?.assets?.[0]?.url;
      if (typeof url !== "string") throw new ProviderError("unknown", `The task ${providerJobId} succeeded but returned no file link.`, false);
      const bytes = await io.downloadFile(url, MAX_VIDEO_BYTES);
      const contentType = sniffMime(bytes);
      if (bytes.length === 0 || !contentType || !(VIDEO_TYPES.has(contentType) || IMAGE_TYPES.has(contentType))) {
        throw new ProviderError("unknown", "SpicyAPI returned an unsupported file type.", false);
      }
      const cost = typeof data.cost === "string" ? Number(data.cost) : NaN;
      return {
        providerJobId, status: "validating", outputFiles: [{ contentType, data: bytes }],
        ...(Number.isFinite(cost) ? { estimatedCost: { amount: cost, currency: "USD", isEstimate: true as const, notes: "Final charge reported by SpicyAPI." } } : {})
      };
    },

    async executeJob(request: ProviderJobRequest, idempotencyKey: string, context: ProviderExecutionContext): Promise<ProviderJobResult> {
      const video = isVideo(request.capability);
      const params = (video ? VIDEO_PARAMS : PARAMS).parse(request.parameters) as { prompt: string; duration?: number };
      let input: Record<string, unknown> = { prompt: params.prompt };
      if (request.capability === "image_to_image" || request.capability === "image_to_video" || request.capability === "text_to_video") {
        const withImage = request.capability !== "text_to_video";
        const file = context.inputFiles[0];
        if (withImage && !file) throw new ProviderError("invalid_request", "The input image is missing.", true);
        if (withImage && file.data.length > MAX_EDIT_INPUT_BYTES) {
          throw new ProviderError("invalid_request", "That image is too large to send (limit 3 MB). Use a smaller or compressed copy. Nothing was sent.", true);
        }
        // Reading the model's fields is free; do it before anything billable so a mismatch costs nothing.
        const meta = await io.call(`/models/${encodeModelPath(request.modelId)}`, { method: "GET", headers: auth(context.secret) });
        const metaBody = await readEnvelope(meta);
        if (!meta.ok) throw mapCreateError(meta.status, metaBody.code, undefined);
        const schema = (metaBody.data as { inputSchema?: unknown } | undefined)?.inputSchema;
        input = buildInput(schema, {
          prompt: params.prompt, ...(video && params.duration !== undefined ? { duration: params.duration } : {}),
          ...(withImage ? { dataUri: `data:${file.contentType};base64,${Buffer.from(file.data).toString("base64")}` } : {})
        });
      }
      // One attempt only. The idempotency key (derived from the job's) is for SpicyAPI's own replay protection.
      const res = await io.call("/jobs/createTask", {
        method: "POST",
        headers: { ...auth(context.secret), "Content-Type": "application/json", "Idempotency-Key": createHash("sha256").update(`studio:${idempotencyKey}`).digest("hex").slice(0, 48) },
        body: JSON.stringify({ model: request.modelId, input })
      });
      const envelope = await readEnvelope(res);
      if (!res.ok) throw mapCreateError(res.status, envelope.code, envelope.msg);
      const taskId = envelope.data?.taskId;
      if (typeof taskId !== "string" || !/^job_[A-Za-z0-9]{6,64}$/.test(taskId)) {
        throw new ProviderError("unknown", "SpicyAPI accepted the request but returned no task id. Check your SpicyAPI task history before retrying.", false);
      }

      // Video takes minutes: hand the task id back and let the job runner collect the result later (getJobStatus).
      if (video) return { providerJobId: taskId, status: "processing", progress: 15 };

      const done = await pollTask(taskId, context.secret);
      if (done.state !== "succeeded") throw taskEndedError(done);
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
