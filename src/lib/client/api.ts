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
