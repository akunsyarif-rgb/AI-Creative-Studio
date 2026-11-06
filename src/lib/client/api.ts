/**
 * Browser-side client for our own /api routes. The JWT comes from a callback so
 * it can be refreshed; secrets are only ever sent in request bodies over HTTPS
 * and are never stored by this module.
 */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export type ApiClient = ReturnType<typeof createApiClient>;

export function createApiClient(getToken: () => Promise<string>, fetchImpl: typeof fetch = fetch) {
  async function request<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const token = await getToken();
    let res: Response;
    try {
      res = await fetchImpl(path, {
        method: init.method ?? "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          ...(init.body === undefined ? {} : { "Content-Type": "application/json" })
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        cache: "no-store"
      });
    } catch {
      throw new ApiError(0, "network_error", "Network error. Check your connection and try again.");
    }
    const payload = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string; details?: unknown } } | null;
    if (!res.ok) {
      const e = payload?.error;
      throw new ApiError(res.status, e?.code ?? "unknown", e?.message ?? `Request failed (${res.status}).`, e?.details);
    }
    return payload as T;
  }
  return {
    get: <T>(path: string) => request<T>(path),
    post: <T>(path: string, body?: unknown) => request<T>(path, { method: "POST", body: body ?? {} }),
    put: <T>(path: string, body: unknown) => request<T>(path, { method: "PUT", body }),
    delete: <T>(path: string) => request<T>(path, { method: "DELETE" })
  };
}

export interface JobView {
  id: string;
  providerId?: string;
  modelId?: string;
  createdAt?: string;
  prompt?: string | null;
  status: "queued" | "submitted" | "processing" | "validating" | "completed" | "failed" | "cancelled";
  progress: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  outputAssetIds: string[];
  estimatedCost: { amount: number; currency: string | null } | null;
}

export const TERMINAL = new Set(["completed", "failed", "cancelled"]);

export const ACCEPTED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

/** Upload a file directly to R2 via a presigned URL, then ask the server to verify it. */
export async function uploadAsset(api: ApiClient, file: File, putImpl: typeof fetch = fetch): Promise<string> {
  const presign = await api.post<{ assetId: string; uploadUrl: string; method: "PUT"; headers: Record<string, string> }>(
    "/api/uploads/presign",
    { contentType: file.type, size: file.size, originalName: file.name }
  );
  let res: Response;
  try {
    res = await putImpl(presign.uploadUrl, { method: presign.method, headers: presign.headers, body: file });
  } catch {
    throw new ApiError(0, "upload_failed", "Upload failed. If this persists, the storage bucket CORS settings may be missing.");
  }
  if (!res.ok) throw new ApiError(res.status, "upload_failed", "Upload to storage failed.");
  await api.post(`/api/uploads/${presign.assetId}/confirm`);
  return presign.assetId;
}

export async function pollJob(
  api: ApiClient,
  jobId: string,
  onUpdate: (job: JobView) => void,
  opts: { intervalMs?: number; timeoutMs?: number; signal?: AbortSignal; sleep?: (ms: number) => Promise<void> } = {}
): Promise<JobView> {
  const { intervalMs = 2000, timeoutMs = 5 * 60_000, signal, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = opts;
  const started = Date.now();
  for (;;) {
    if (signal?.aborted) throw new ApiError(0, "aborted", "Cancelled.");
    const { job } = await api.get<{ job: JobView }>(`/api/jobs/${jobId}`);
    onUpdate(job);
    if (TERMINAL.has(job.status)) return job;
    if (Date.now() - started > timeoutMs) {
      throw new ApiError(0, "poll_timeout", "Still working. Check the job status again in a moment; it will not be re-submitted.");
    }
    await sleep(intervalMs);
  }
}

/** Shape of `GET /api/providers` (static, non-secret provider config). */
export interface ProviderView {
  id: string;
  name: string;
  description: string | null;
  /** True for providers the user defined themselves (OpenAI-compatible endpoints). */
  custom?: boolean;
  models: ModelView[];
}

export interface ModelView {
  modelId: string;
  displayName: string;
  capabilities: string[];
  isFreeTier: boolean;
  parameters: { key: string; label: string; default: string; options: { value: string; label: string }[] }[];
}

const IMAGE_CAPABILITIES = ["text_to_image", "image_to_image"];

/** Models that can serve the Image Studio for the requested capability. */
export function imageModels(provider: ProviderView | undefined, capability: "text_to_image" | "image_to_image"): ModelView[] {
  return (provider?.models ?? []).filter((m) => m.capabilities.includes(capability) && IMAGE_CAPABILITIES.includes(capability));
}

/** Providers that offer at least one image model. */
export function imageProviders(providers: ProviderView[]): ProviderView[] {
  return providers.filter((p) => p.models.some((m) => m.capabilities.some((c) => IMAGE_CAPABILITIES.includes(c))));
}

export function defaultParams(model: ModelView | undefined): Record<string, string> {
  return Object.fromEntries((model?.parameters ?? []).map((p) => [p.key, p.default]));
}

/** One page of the user's jobs, newest first. Pass `nextCursor` from the previous page to continue. */
export async function fetchJobsPage(api: ApiClient, cursor?: string | null, limit = 12): Promise<{ jobs: JobView[]; nextCursor: string | null }> {
  const qs = new URLSearchParams({ limit: String(limit), ...(cursor ? { cursor } : {}) });
  return api.get(`/api/jobs?${qs}`);
}

/** Short-lived signed URL for one of the user's assets (inline view, or save-as with `download`). */
export async function getAssetUrl(api: ApiClient, assetId: string, opts: { download?: boolean } = {}): Promise<string> {
  const { download } = await api.get<{ download: { url: string } }>(`/api/assets/${assetId}${opts.download ? "?download=1" : ""}`);
  return download.url;
}

/** Fetches a fresh attachment URL and hands it to the browser, which saves the file. */
export async function downloadAsset(api: ApiClient, assetId: string, navigate: (url: string) => void = (u) => window.location.assign(u)): Promise<void> {
  navigate(await getAssetUrl(api, assetId, { download: true }));
}

/** Jobs that are still running and worth re-checking. */
export const isActive = (job: Pick<JobView, "status">) => !TERMINAL.has(job.status);

/** Splits a free-form list of model ids (commas, spaces or new lines) into unique, trimmed entries. */
export function parseModelList(text: string): string[] {
  return [...new Set(text.split(/[\s,;]+/).map((m) => m.trim()).filter(Boolean))];
}
