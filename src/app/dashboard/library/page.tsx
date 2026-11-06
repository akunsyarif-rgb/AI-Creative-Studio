"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ApiError, downloadAsset, fetchJobsPage, getAsset, isActive, type ApiClient, type JobView } from "@/lib/client/api";
import { useApi } from "@/lib/client/use-session";

const STATUS_LABEL: Record<JobView["status"], string> = {
  queued: "Queued", submitted: "Running", processing: "Running", validating: "Saving", completed: "Done", failed: "Failed", cancelled: "Cancelled"
};

/** Loads its signed URL only when scrolled into view, and refreshes it once if it has expired. */
function Thumb({ api, assetId, alt }: { api: ApiClient; assetId: string; alt: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [isVideo, setIsVideo] = useState(false);
  const [failed, setFailed] = useState(false);
  const retried = useRef(false);
  const requested = useRef(false);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const load = () => {
      if (requested.current) return;
      requested.current = true;
      getAsset(api, assetId).then((a) => { setIsVideo(a.contentType.startsWith("video/")); setUrl(a.url); }).catch(() => setFailed(true));
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
    getAsset(api, assetId).then((a) => { setIsVideo(a.contentType.startsWith("video/")); setUrl(a.url); }).catch(() => setFailed(true));
  }

  return (
    <div ref={box} className={`thumb${isVideo ? " thumb-video" : ""}`}>
      {failed ? <span className="muted small">Preview unavailable</span> : url && isVideo ? (
        <video src={url} controls playsInline preload="metadata" aria-label={alt} onError={onError} />
      ) : url ? (
        // Short-lived signed URL from a private bucket; next/image optimisation does not apply.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt={alt} loading="lazy" onError={onError} />
      ) : <span className="spinner" aria-label="Loading preview" />}
    </div>
  );
}

function JobCard({ api, job, onDeleted }: { api: ApiClient; job: JobView; onDeleted: (id: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = job.prompt ? job.prompt.slice(0, 120) : "Generated item";
  const when = job.createdAt ? new Date(job.createdAt).toLocaleString() : "";

  async function remove() {
    if (!window.confirm("Delete this item permanently? This cannot be undone.")) return;
    setBusy(true);
    setError(null);
    try {
      await api.delete(`/api/jobs/${job.id}`);
      onDeleted(job.id);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Delete failed.");
      setBusy(false);
    }
  }

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
            <Thumb api={api} assetId={id} alt={`Generated: ${label}`} />
            <button className="btn" type="button" disabled={busy} onClick={() => void save(id)}>{busy ? "Preparing…" : "Download"}</button>
          </div>
        ))
      ) : (
        <div className="thumb thumb-empty">
          {isActive(job) && <span className="spinner" aria-hidden="true" />}
          <span className="muted small">{job.status === "failed" ? "Nothing created" : STATUS_LABEL[job.status]}</span>
        </div>
      )}
      <div className="row-between">
        <span className={`badge ${job.status === "completed" ? "badge-valid" : job.status === "failed" ? "badge-invalid" : ""}`}>{STATUS_LABEL[job.status]}</span>
        {job.estimatedCost && <span className="muted small">~${job.estimatedCost.amount.toFixed(3)}</span>}
      </div>
      {job.prompt && <p className="job-prompt">{job.prompt}</p>}
      {job.status === "failed" && job.errorMessage && <p className="notice notice-error small" role="alert">{job.errorMessage}</p>}
      {error && <p className="notice notice-error small" role="alert">{error}</p>}
      {!isActive(job) && (
        <button className="btn btn-danger" type="button" disabled={busy} onClick={() => void remove()}>{busy ? "Working…" : "Delete"}</button>
      )}
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

  function removeJob(id: string) {
    const rest = (jobs ?? []).filter((c) => c.id !== id);
    setJobs(rest);
    // "Load more" continues after the last loaded job, so if that one is gone move the cursor back (or reload).
    if (nextCursor === id) {
      if (rest.length) setNextCursor(rest[rest.length - 1].id);
      else { setNextCursor(null); setTick((n) => n + 1); }
    }
  }

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

  // A running video is collected when it is looked at: re-read each running job every few seconds (read-only, free).
  useEffect(() => {
    if (!anyActive) return;
    let live = true;
    const timer = setInterval(async () => {
      const running = (jobs ?? []).filter(isActive);
      for (const j of running) {
        try {
          const { job } = await api.get<{ job: JobView }>(`/api/jobs/${j.id}`);
          if (!live) return;
          setJobs((cur) => (cur ?? []).map((c) => (c.id === job.id ? { ...c, ...job, prompt: c.prompt ?? job.prompt } : c)));
        } catch {
          /* try again on the next tick */
        }
      }
    }, 8000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [api, anyActive, jobs]);

  return (
    <>
      <div className="row-between">
        <div>
          <p className="eyebrow">LIBRARY</p>
          <h1 className="page-title">Your creations</h1>
        </div>
        <button className="btn" type="button" onClick={() => setTick((n) => n + 1)}>Refresh</button>
      </div>
      <p className="muted lead">Newest first. Your creations are private to you; previews use short-lived links.</p>
      {anyActive && <p className="notice notice-warn small" role="status">Some jobs are still running (videos take a few minutes). This page updates by itself.</p>}
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
        <div className="gallery">{jobs.map((j) => <JobCard key={j.id} api={api} job={j} onDeleted={removeJob} />)}</div>
      )}
      {nextCursor && (
        <div className="actions" style={{ justifyContent: "center" }}>
          <button className="btn" type="button" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? "Loading…" : "Load more"}</button>
        </div>
      )}
    </>
  );
}
