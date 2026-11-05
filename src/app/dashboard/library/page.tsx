"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ApiError, downloadAsset, fetchJobsPage, getAssetUrl, isActive, type ApiClient, type JobView } from "@/lib/client/api";
import { useApi } from "@/lib/client/use-session";

const STATUS_LABEL: Record<JobView["status"], string> = {
  queued: "Queued", submitted: "Running", processing: "Running", validating: "Saving", completed: "Done", failed: "Failed", cancelled: "Cancelled"
};

/** Loads its signed URL only when scrolled into view, and refreshes it once if it has expired. */
function Thumb({ api, assetId, alt }: { api: ApiClient; assetId: string; alt: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const retried = useRef(false);
  const requested = useRef(false);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const load = () => {
      if (requested.current) return;
      requested.current = true;
      getAssetUrl(api, assetId).then(setUrl).catch(() => setFailed(true));
    };
    if (typeof IntersectionObserver === "undefined") {
      load();
      return;
    }
    const io = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) { load(); io.disconnect(); } }, { rootMargin: "200px" });
    io.observe(el);
    return () => io.disconnect();
  }, [api, assetId]);

  function onError() {
    // Signed URLs live a few minutes; fetch a new one once before giving up.
    if (retried.current) return setFailed(true);
    retried.current = true;
    getAssetUrl(api, assetId).then(setUrl).catch(() => setFailed(true));
  }

  return (
    <div ref={box} className="thumb">
      {failed ? <span className="muted small">Preview unavailable</span> : url ? (
        // Short-lived signed URL from a private bucket; next/image optimisation does not apply.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt={alt} loading="lazy" onError={onError} />
      ) : <span className="spinner" aria-label="Loading preview" />}
    </div>
  );
}

function JobCard({ api, job }: { api: ApiClient; job: JobView }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = job.prompt ? job.prompt.slice(0, 120) : "Generated image";
  const when = job.createdAt ? new Date(job.createdAt).toLocaleString() : "";

  async function save(assetId: string) {
    setBusy(true);
    setError(null);
    try {
      await downloadAsset(api, assetId);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Download failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="panel job-card">
      {job.status === "completed" && job.outputAssetIds.length > 0 ? (
        job.outputAssetIds.map((id) => (
          <div key={id} className="stack">
            <Thumb api={api} assetId={id} alt={`Generated image: ${label}`} />
            <button className="btn" type="button" disabled={busy} onClick={() => void save(id)}>{busy ? "Preparing…" : "Download"}</button>
          </div>
        ))
      ) : (
        <div className="thumb thumb-empty">
          {isActive(job) && <span className="spinner" aria-hidden="true" />}
          <span className="muted small">{job.status === "failed" ? "No image" : STATUS_LABEL[job.status]}</span>
        </div>
      )}
      <div className="row-between">
        <span className={`badge ${job.status === "completed" ? "badge-valid" : job.status === "failed" ? "badge-invalid" : ""}`}>{STATUS_LABEL[job.status]}</span>
        {job.estimatedCost && <span className="muted small">~${job.estimatedCost.amount.toFixed(3)}</span>}
      </div>
      {job.prompt && <p className="job-prompt">{job.prompt}</p>}
      {job.status === "failed" && job.errorMessage && <p className="notice notice-error small" role="alert">{job.errorMessage}</p>}
      {error && <p className="notice notice-error small" role="alert">{error}</p>}
      <p className="muted small">{[job.providerId && job.modelId ? `${job.providerId} · ${job.modelId}` : null, when].filter(Boolean).join(" · ")}</p>
    </article>
  );
}

export default function LibraryPage() {
  const api = useApi();
  const [jobs, setJobs] = useState<JobView[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [tick, setTick] = useState(0);

  // First page (and refresh): newest first.
  useEffect(() => {
    let live = true;
    fetchJobsPage(api)
      .then((p) => {
        if (!live) return;
        setJobs(p.jobs);
        setNextCursor(p.nextCursor);
        setError(null);
      })
      .catch((e) => {
        if (!live) return;
        setError(e instanceof ApiError ? e.message : "Could not load your library.");
        setJobs((j) => j ?? []);
      });
    return () => {
      live = false;
    };
  }, [api, tick]);

  async function loadMore() {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const p = await fetchJobsPage(api, nextCursor);
      // De-duplicate in case new jobs shifted the page boundary.
      setJobs((cur) => [...(cur ?? []), ...p.jobs.filter((j) => !(cur ?? []).some((c) => c.id === j.id))]);
      setNextCursor(p.nextCursor);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not load more.");
    } finally {
      setLoadingMore(false);
    }
  }

  const anyActive = jobs?.some(isActive) ?? false;

  return (
    <>
      <div className="row-between">
        <div>
          <p className="eyebrow">LIBRARY</p>
          <h1 className="page-title">Your creations</h1>
        </div>
        <button className="btn" type="button" onClick={() => setTick((n) => n + 1)}>Refresh</button>
      </div>
      <p className="muted lead">Newest first. Images are private to you; previews use short-lived links.</p>
      {anyActive && <p className="notice notice-warn small" role="status">Some jobs are still running. Press Refresh to update them.</p>}
      {error && <p className="notice notice-error" role="alert">{error}</p>}
      {jobs === null && <p className="muted" role="status">Loading…</p>}
      {jobs && jobs.length === 0 && !error && (
        <section className="panel stack">
          <h2>Nothing here yet</h2>
          <p className="muted">Generate your first image and it will appear here.</p>
          <div className="actions"><Link className="btn btn-primary" href="/dashboard/studio">Open the Studio</Link></div>
        </section>
      )}
      {jobs && jobs.length > 0 && (
        <div className="gallery">{jobs.map((j) => <JobCard key={j.id} api={api} job={j} />)}</div>
      )}
      {nextCursor && (
        <div className="actions" style={{ justifyContent: "center" }}>
          <button className="btn" type="button" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? "Loading…" : "Load more"}</button>
        </div>
      )}
    </>
  );
}
