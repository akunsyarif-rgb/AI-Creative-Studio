"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import {
  ACCEPTED_IMAGE_TYPES, ApiError, MAX_IMAGE_BYTES, pollJob, uploadAsset, type JobView
} from "@/lib/client/api";
import { useApi } from "@/lib/client/use-session";

interface Estimate { amount: number; currency: string; notes?: string }

const SIZES = [
  { value: "1024x1024", label: "Square 1024×1024" },
  { value: "1024x1536", label: "Portrait 1024×1536" },
  { value: "1536x1024", label: "Landscape 1536×1024" }
];
const QUALITIES = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" }
];

const STATUS_TEXT: Record<JobView["status"], string> = {
  queued: "Queued…", submitted: "Sent to the provider…", processing: "Generating…",
  validating: "Checking and saving the result…", completed: "Done", failed: "Failed", cancelled: "Cancelled"
};

export default function StudioPage() {
  const api = useApi();
  const [prompt, setPrompt] = useState("");
  const [size, setSize] = useState("1024x1024");
  const [quality, setQuality] = useState("medium");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; needsKey?: boolean } | null>(null);
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [job, setJob] = useState<JobView | null>(null);
  const [resultUrl, setResultUrl] = useState<string | null>(null);

  // One idempotency key per logical attempt; reused when the user confirms the cost.
  const attemptKey = useRef<string | null>(null);
  const uploaded = useRef<{ file: File; assetId: string } | null>(null);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  function onFile(event: ChangeEvent<HTMLInputElement>) {
    const f = event.target.files?.[0] ?? null;
    setError(null);
    if (f && !(ACCEPTED_IMAGE_TYPES as readonly string[]).includes(f.type)) {
      setError({ text: "Use a PNG, JPEG or WebP image." });
      event.target.value = "";
      return;
    }
    if (f && f.size > MAX_IMAGE_BYTES) {
      setError({ text: "Image is too large (max 25 MB)." });
      event.target.value = "";
      return;
    }
    setFile(f);
    attemptKey.current = null;
    setEstimate(null);
  }

  async function submit(confirmedMaxCostUsd?: number) {
    setBusy(true);
    setError(null);
    setResultUrl(null);
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
        capability: file ? "image_to_image" : "text_to_image",
        providerId: "openai",
        modelId: "gpt-image-1",
        inputAssetIds: inputAssetId ? [inputAssetId] : [],
        parameters: { prompt: prompt.trim(), size, quality },
        idempotencyKey: attemptKey.current,
        ...(confirmedMaxCostUsd === undefined ? {} : { confirmedMaxCostUsd })
      });
      setEstimate(null);
      attemptKey.current = null; // next click is a new job
      setJob(res.job);

      abort.current?.abort();
      abort.current = new AbortController();
      const final = await pollJob(api, res.job.id, setJob, { signal: abort.current.signal });
      if (final.status === "completed" && final.outputAssetIds[0]) {
        const { download } = await api.get<{ download: { url: string } }>(`/api/assets/${final.outputAssetIds[0]}`);
        setResultUrl(download.url);
      }
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

  const working = job !== null && !["completed", "failed", "cancelled"].includes(job.status);

  return (
    <>
      <p className="eyebrow">IMAGE STUDIO</p>
      <h1 className="page-title">Create an image</h1>
      <p className="muted lead">Describe what you want. Add a reference image to edit it instead. Results are saved privately to your library.</p>

      <form className="panel stack" onSubmit={onSubmit}>
        <label className="field">
          <span>Prompt</span>
          <textarea required maxLength={4000} rows={5} value={prompt} onChange={(e) => { setPrompt(e.target.value); attemptKey.current = null; setEstimate(null); }} placeholder="A watercolor fox reading a map under a lantern…" />
        </label>
        <div className="grid-2">
          <label className="field">
            <span>Size</span>
            <select value={size} onChange={(e) => { setSize(e.target.value); attemptKey.current = null; setEstimate(null); }}>
              {SIZES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Quality</span>
            <select value={quality} onChange={(e) => { setQuality(e.target.value); attemptKey.current = null; setEstimate(null); }}>
              {QUALITIES.map((q) => <option key={q.value} value={q.value}>{q.label}</option>)}
            </select>
          </label>
        </div>
        <label className="field">
          <span>Reference image (optional)</span>
          <input type="file" accept={ACCEPTED_IMAGE_TYPES.join(",")} onChange={onFile} />
          {file && <small className="muted">{file.name} · {(file.size / 1024).toFixed(0)} KB. Only use images you own or have permission to edit.</small>}
        </label>

        {error && (
          <p className="notice notice-error" role="alert">
            {error.text} {error.needsKey && <Link href="/dashboard/keys">Add a key →</Link>}
          </p>
        )}

        {estimate ? (
          <div className="notice notice-warn" role="alert">
            <strong>This is a paid request.</strong>
            <p>Estimated cost: about <b>${estimate.amount.toFixed(3)} {estimate.currency}</b>. {estimate.notes}</p>
            <p className="small">Billed by OpenAI to your own account. Nothing has been sent yet.</p>
            <div className="actions">
              <button className="btn btn-primary" type="button" disabled={busy} onClick={() => void submit(estimate.amount)}>
                {busy ? "Working…" : `Confirm and generate (~$${estimate.amount.toFixed(3)})`}
              </button>
              <button className="btn" type="button" disabled={busy} onClick={() => setEstimate(null)}>Cancel</button>
            </div>
          </div>
        ) : (
          <button className="btn btn-primary" type="submit" disabled={busy || !prompt.trim()}>
            {busy ? "Working…" : file ? "Edit image" : "Generate image"}
          </button>
        )}
      </form>

      {job && (
        <section className="panel stack" aria-live="polite" aria-label="Result">
          <div className="row-between">
            <h2>{STATUS_TEXT[job.status]}</h2>
            {working && <span className="spinner" aria-hidden="true" />}
          </div>
          {job.status === "failed" && <p className="notice notice-error" role="alert">{job.errorMessage ?? "The job failed."}</p>}
          {resultUrl && (
            <>
              {/* Short-lived signed URL from our private bucket; next/image optimisation does not apply. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img className="result-img" src={resultUrl} alt={`Generated image for: ${prompt.trim().slice(0, 120)}`} />
              <div className="actions"><a className="btn" href={resultUrl} download="image.png">Download</a></div>
              <p className="muted small">AI-generated image. The link expires in a few minutes; the file stays in your private library.</p>
            </>
          )}
        </section>
      )}
    </>
  );
}
