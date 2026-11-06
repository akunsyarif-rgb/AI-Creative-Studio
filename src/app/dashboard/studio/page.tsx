"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import {
  ACCEPTED_IMAGE_TYPES, ApiError, MAX_IMAGE_BYTES, defaultParams, downloadAsset, getAssetUrl, imageModels, imageProviders, pollJob, uploadAsset,
  type JobView, type ProviderView
} from "@/lib/client/api";
import { useApi } from "@/lib/client/use-session";

/** amount: null means the provider price is unknown (custom provider without an estimate). */
interface Estimate { amount: number | null; currency: string; notes?: string }

const STATUS_TEXT: Record<JobView["status"], string> = {
  queued: "Queued…", submitted: "Sent to the provider…", processing: "Generating…",
  validating: "Checking and saving the result…", completed: "Done", failed: "Failed", cancelled: "Cancelled"
};

export default function StudioPage() {
  const api = useApi();
  const [prompt, setPrompt] = useState("");
  const [providers, setProviders] = useState<ProviderView[] | null>(null);
  const [providerChoice, setProviderChoice] = useState("");
  const [modelChoice, setModelChoice] = useState("");
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; needsKey?: boolean } | null>(null);
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [job, setJob] = useState<JobView | null>(null);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [resultAssetId, setResultAssetId] = useState<string | null>(null);

  // One idempotency key per logical attempt; reused when the user confirms the cost.
  const attemptKey = useRef<string | null>(null);
  const uploaded = useRef<{ file: File; assetId: string } | null>(null);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

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

  const capability = file ? "image_to_image" : "text_to_image";
  const provider = providers?.find((p) => p.id === providerChoice) ?? providers?.[0];
  const models = imageModels(provider, capability);
  const model = models.find((m) => m.modelId === modelChoice) ?? models[0];
  const params = { ...defaultParams(model), ...Object.fromEntries(Object.entries(overrides).filter(([k]) => model?.parameters.some((p) => p.key === k))) };

  /** Any change to the request invalidates a pending cost confirmation and starts a new attempt. */
  function changed() {
    attemptKey.current = null;
    setEstimate(null);
  }

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
    changed();
  }

  async function submit(confirmation?: { maxCostUsd?: number; unknownCost?: boolean }) {
    if (!provider || !model) return;
    setBusy(true);
    setError(null);
    setResultUrl(null);
    setResultAssetId(null);
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
      setJob(res.job);

      abort.current?.abort();
      abort.current = new AbortController();
      const final = await pollJob(api, res.job.id, setJob, { signal: abort.current.signal });
      if (final.status === "completed" && final.outputAssetIds[0]) {
        setResultAssetId(final.outputAssetIds[0]);
        setResultUrl(await getAssetUrl(api, final.outputAssetIds[0]));
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
            {provider ? `${provider.name} has no model for ${file ? "editing an image" : "text-to-image"}.` : "No image providers are available."}
            {file ? " Remove the reference image or pick another provider." : ""}
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
              <div className="actions">
                <button className="btn" type="button" onClick={() => resultAssetId && void downloadAsset(api, resultAssetId)}>Download</button>
                <Link className="btn" href="/dashboard/library">Open library</Link>
              </div>
              <p className="muted small">AI-generated image. The link expires in a few minutes; the file stays in your private library.</p>
            </>
          )}
        </section>
      )}
    </>
  );
}
