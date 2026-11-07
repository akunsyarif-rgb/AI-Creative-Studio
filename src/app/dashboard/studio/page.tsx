"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import {
  ACCEPTED_IMAGE_TYPES, ApiError, MAX_IMAGE_BYTES, defaultParams, downloadAsset, getAsset, imageModels, imageProviders, pollJob, studioCapability, uploadAsset,
  type JobView, type ProviderView
} from "@/lib/client/api";
import { COMPRESS_TARGET_BYTES, compressImage } from "@/lib/client/compress";
import { useApi } from "@/lib/client/use-session";

/** amount: null means the provider price is unknown (custom provider without an estimate). */
interface Estimate { amount: number | null; currency: string; notes?: string }

const STATUS_TEXT: Record<JobView["status"], string> = {
  queued: "Queued…", submitted: "Sent to the provider…", processing: "Generating… (a video takes a few minutes; you can leave this page, the result will appear in your library)",
  validating: "Checking and saving the result…", completed: "Done", failed: "Failed", cancelled: "Cancelled"
};

/** One submitted job being followed in the background; several can run at once (the server enforces the limits). */
interface Run {
  id: string;
  kind: "image" | "video";
  prompt: string;
  job: JobView;
  assetId: string | null;
  url: string | null;
  isVideo: boolean;
  note: string | null;
}

export default function StudioPage() {
  const api = useApi();
  const [prompt, setPrompt] = useState("");
  const [providers, setProviders] = useState<ProviderView[] | null>(null);
  const [providerChoice, setProviderChoice] = useState("");
  const [modelChoice, setModelChoice] = useState("");
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [file, setFile] = useState<File | null>(null);
  const [compressing, setCompressing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; needsKey?: boolean } | null>(null);
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [mode, setMode] = useState<"image" | "video">("image");

  // One idempotency key per logical attempt; reused when the user confirms the cost.
  const attemptKey = useRef<string | null>(null);
  const uploaded = useRef<{ file: File; assetId: string } | null>(null);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => {
    abort.current = new AbortController();
    return () => abort.current?.abort();
  }, []);

  const patchRun = (id: string, patch: Partial<Run>) => setRuns((cur) => cur.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  /** Follows one job to its end without blocking the form, so the next one can be started meanwhile. */
  async function track(runId: string, jobId: string, kind: "image" | "video") {
    try {
      const final = await pollJob(api, jobId, (job) => patchRun(runId, { job }), {
        signal: abort.current?.signal,
        ...(kind === "video" ? { intervalMs: 6000, timeoutMs: 20 * 60_000 } : { intervalMs: 3000, timeoutMs: 10 * 60_000 })
      });
      if (final.status === "completed" && final.outputAssetIds[0]) {
        const asset = await getAsset(api, final.outputAssetIds[0]);
        patchRun(runId, { assetId: final.outputAssetIds[0], url: asset.url, isVideo: asset.contentType.startsWith("video/") });
      }
    } catch (e) {
      if (e instanceof ApiError && e.code === "aborted") return;
      patchRun(runId, { note: e instanceof ApiError ? e.message : "Lost contact while waiting. The job keeps running; check your library." });
    }
  }

  // Providers/models/parameters come from the server-side registry.
  useEffect(() => {
    let live = true;
    api
      .get<{ providers: ProviderView[] }>("/api/providers")
      .then((r) => live && setProviders(imageProviders(r.providers)))
      .catch((e) => {
        if (!live) return;
        setProviders([]);
        setError({ text: e instanceof ApiError ? e.message : "Could not load providers." });
      });
    return () => {
      live = false;
    };
  }, [api]);

  const capability = studioCapability(mode, !!file);
  const provider = providers?.find((p) => p.id === providerChoice) ?? providers?.[0];
  const models = imageModels(provider, capability);
  const model = models.find((m) => m.modelId === modelChoice) ?? models[0];
  const params = { ...defaultParams(model), ...Object.fromEntries(Object.entries(overrides).filter(([k]) => model?.parameters.some((p) => p.key === k))) };

  /** Any change to the request invalidates a pending cost confirmation and starts a new attempt. */
  function changed() {
    attemptKey.current = null;
    setEstimate(null);
  }

  async function onFile(event: ChangeEvent<HTMLInputElement>) {
    const input = event.target;
    let f = input.files?.[0] ?? null;
    setError(null);
    if (f && !(ACCEPTED_IMAGE_TYPES as readonly string[]).includes(f.type)) {
      setError({ text: "Use a PNG, JPEG or WebP image." });
      input.value = "";
      return;
    }
    if (f && f.size > MAX_IMAGE_BYTES) {
      setError({ text: "Image is too large (max 25 MB)." });
      input.value = "";
      return;
    }
    if (f && f.size > COMPRESS_TARGET_BYTES) {
      setCompressing(true);
      try {
        f = await compressImage(f); // a smaller JPEG copy; the original stays on the device
      } catch (e) {
        setError({ text: e instanceof Error ? e.message : "This image could not be shrunk." });
        input.value = "";
        setCompressing(false);
        return;
      }
      setCompressing(false);
    }
    setFile(f);
    changed();
  }

  async function submit(confirmation?: { maxCostUsd?: number; unknownCost?: boolean }) {
    if (!provider || !model) return;
    setBusy(true);
    setError(null);
    try {
      let inputAssetId: string | undefined;
      if (file) {
        if (uploaded.current?.file !== file) {
          uploaded.current = { file, assetId: await uploadAsset(api, file) };
        }
        inputAssetId = uploaded.current.assetId;
      }
      attemptKey.current ??= crypto.randomUUID();
      const res = await api.post<{ job: JobView }>("/api/jobs", {
        projectId: "default",
        capability,
        providerId: provider.id,
        modelId: model.modelId,
        inputAssetIds: inputAssetId ? [inputAssetId] : [],
        parameters: { prompt: prompt.trim(), ...params },
        idempotencyKey: attemptKey.current,
        ...(confirmation?.maxCostUsd === undefined ? {} : { confirmedMaxCostUsd: confirmation.maxCostUsd }),
        ...(confirmation?.unknownCost ? { confirmUnknownCost: true } : {})
      });
      setEstimate(null);
      attemptKey.current = null; // next click is a new job
      const kind = mode;
      setRuns((cur) => [{ id: res.job.id, kind, prompt: prompt.trim(), job: res.job, assetId: null, url: null, isVideo: false, note: null }, ...cur].slice(0, 8));
      void track(res.job.id, res.job.id, kind); // not awaited: the form is free again right away
    } catch (e) {
      if (e instanceof ApiError && e.code === "cost_confirmation_required") {
        const est = (e.details as { estimate?: Estimate } | undefined)?.estimate;
        if (est) setEstimate(est);
        else setError({ text: e.message });
      } else if (e instanceof ApiError && e.code === "provider_key_missing") {
        setError({ text: e.message, needsKey: true });
      } else if (e instanceof ApiError && e.code === "aborted") {
        /* navigated away */
      } else {
        setError({ text: e instanceof ApiError ? e.message : "Something went wrong." });
      }
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    void submit();
  }

  return (
    <>
      <p className="eyebrow">STUDIO</p>
      <h1 className="page-title">Create</h1>
      <p className="muted lead">Describe what you want. Add an image to edit it or to start a video from it. You can start more while others run (up to 3 at once, at most 2 videos). Results are saved privately to your library.</p>

      <form className="panel stack" onSubmit={onSubmit}>
        <div className="field" role="group" aria-label="What to create">
          <span>Create</span>
          <div className="actions">
            <button type="button" className={`btn ${mode === "image" ? "btn-primary" : ""}`} aria-pressed={mode === "image"}
              onClick={() => { setMode("image"); setModelChoice(""); setOverrides({}); changed(); }}>Image</button>
            <button type="button" className={`btn ${mode === "video" ? "btn-primary" : ""}`} aria-pressed={mode === "video"}
              onClick={() => { setMode("video"); setModelChoice(""); setOverrides({}); changed(); }}>Video</button>
          </div>
        </div>
        <label className="field">
          <span>Prompt</span>
          <textarea required maxLength={4000} rows={5} value={prompt} onChange={(e) => { setPrompt(e.target.value); changed(); }} placeholder="A watercolor fox reading a map under a lantern…" />
        </label>
        <div className="grid-2">
          <label className="field">
            <span>Provider</span>
            <select
              value={provider?.id ?? ""} disabled={!providers?.length}
              onChange={(e) => { setProviderChoice(e.target.value); setModelChoice(""); setOverrides({}); changed(); }}
            >
              {!providers && <option value="">Loading…</option>}
              {providers?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Model</span>
            <select
              value={model?.modelId ?? ""} disabled={!models.length}
              onChange={(e) => { setModelChoice(e.target.value); setOverrides({}); changed(); }}
            >
              {!models.length && <option value="">None available</option>}
              {models.map((m) => <option key={m.modelId} value={m.modelId}>{m.displayName}{m.isFreeTier ? " (free)" : ""}</option>)}
            </select>
          </label>
        </div>
        {providers && !models.length && (
          <p className="notice notice-warn" role="status">
            {provider ? `${provider.name} has no model for ${mode === "video" ? (file ? "image-to-video" : "text-to-video") : file ? "editing an image" : "text-to-image"}.` : "No providers are available."}
            {file ? " Remove the image or pick another provider." : mode === "video" ? " Add a model ending in /text-to-video or /image-to-video on the API keys page." : ""}
          </p>
        )}
        {model && model.parameters.length > 0 && (
          <div className="grid-2">
            {model.parameters.map((p) => (
              <label className="field" key={p.key}>
                <span>{p.label}</span>
                <select value={params[p.key]} onChange={(e) => { setOverrides({ ...overrides, [p.key]: e.target.value }); changed(); }}>
                  {p.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </label>
            ))}
          </div>
        )}
        <label className="field">
          <span>{mode === "video" ? "Start image (optional)" : "Reference image (optional)"}</span>
          <input type="file" accept={ACCEPTED_IMAGE_TYPES.join(",")} onChange={onFile} />
          {compressing && <small className="muted" role="status">Shrinking the photo to under 2 MB…</small>}
          {file && !compressing && <small className="muted">{file.name} · {(file.size / 1024).toFixed(0)} KB. Only use images you own or have permission to edit.</small>}
        </label>

        {error && (
          <p className="notice notice-error" role="alert">
            {error.text} {error.needsKey && <Link href="/dashboard/keys">Add a key →</Link>}
          </p>
        )}

        {estimate ? (
          <div className="notice notice-warn" role="alert">
            {estimate.amount === null ? (
              <>
                <strong>The price of this request is unknown.</strong>
                <p>{provider?.name ?? "The provider"} will charge its own price to your account. {estimate.notes}</p>
                <p className="small">Check their pricing first. The spend limit cannot be applied to an unknown price. Nothing has been sent yet.</p>
              </>
            ) : (
              <>
                <strong>This is a paid request.</strong>
                <p>Estimated cost: about <b>${estimate.amount.toFixed(3)} {estimate.currency}</b>. {estimate.notes}</p>
                <p className="small">Billed by {provider?.name ?? "the provider"} to your own account. Nothing has been sent yet.</p>
              </>
            )}
            <div className="actions">
              <button
                className="btn btn-primary" type="button" disabled={busy}
                onClick={() => void submit(estimate.amount === null ? { unknownCost: true } : { maxCostUsd: estimate.amount })}
              >
                {busy ? "Working…" : estimate.amount === null ? "Confirm and generate (price unknown)" : `Confirm and generate (~$${estimate.amount.toFixed(3)})`}
              </button>
              <button className="btn" type="button" disabled={busy} onClick={() => setEstimate(null)}>Cancel</button>
            </div>
          </div>
        ) : (
          <button className="btn btn-primary" type="submit" disabled={busy || !prompt.trim() || !model}>
            {busy ? "Working…" : mode === "video" ? "Create video" : file ? "Edit image" : "Generate image"}
          </button>
        )}
      </form>

      {runs.map((run) => {
        const working = !["completed", "failed", "cancelled"].includes(run.job.status);
        return (
          <section className="panel stack" aria-live="polite" aria-label="Result" key={run.id}>
            <div className="row-between">
              <h2>{STATUS_TEXT[run.job.status]}</h2>
              {working && <span className="spinner" aria-hidden="true" />}
            </div>
            <p className="muted small">{run.kind === "video" ? "Video" : "Image"}: {run.prompt.slice(0, 120)}</p>
            {run.job.status === "failed" && <p className="notice notice-error" role="alert">{run.job.errorMessage ?? "The job failed."}</p>}
            {run.note && <p className="notice notice-warn small" role="status">{run.note}</p>}
            {run.url && (
              <>
                {run.isVideo ? (
                  <video className="result-img" src={run.url} controls playsInline preload="metadata" aria-label={`Generated video for: ${run.prompt.slice(0, 120)}`} />
                ) : (
                  <>
                    {/* Short-lived signed URL from our private bucket; next/image optimisation does not apply. */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img className="result-img" src={run.url} alt={`Generated image for: ${run.prompt.slice(0, 120)}`} />
                  </>
                )}
                <div className="actions">
                  <button className="btn" type="button" onClick={() => run.assetId && void downloadAsset(api, run.assetId)}>Download</button>
                  <Link className="btn" href="/dashboard/library">Open library</Link>
                </div>
                <p className="muted small">AI-generated {run.isVideo ? "video" : "image"}. The link expires in a few minutes; the file stays in your private library.</p>
              </>
            )}
          </section>
        );
      })}
    </>
  );
}
