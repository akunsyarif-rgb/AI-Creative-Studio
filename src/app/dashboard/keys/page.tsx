"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { ApiError, type ProviderView } from "@/lib/client/api";
import { useApi } from "@/lib/client/use-session";

interface KeyView {
  providerId: string;
  masked: string;
  validationStatus: "unvalidated" | "valid" | "invalid";
  updatedAt: string;
}

const STATUS_LABEL = { unvalidated: "Not tested", valid: "Valid", invalid: "Rejected" } as const;

export default function KeysPage() {
  const api = useApi();
  const [keys, setKeys] = useState<KeyView[] | null>(null);
  const [providers, setProviders] = useState<ProviderView[] | null>(null);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const [reloadTick, setReloadTick] = useState(0);
  const reload = () => setReloadTick((n) => n + 1);

  useEffect(() => {
    let live = true;
    // Providers come from the server-side registry, so new adapters appear here automatically.
    Promise.all([api.get<{ keys: KeyView[] }>("/api/keys"), api.get<{ providers: ProviderView[] }>("/api/providers")])
      .then(([k, p]) => {
        if (!live) return;
        setKeys(k.keys);
        setProviders(p.providers);
      })
      .catch((e) => {
        if (!live) return;
        setMessage({ kind: "error", text: e instanceof ApiError ? e.message : "Could not load keys." });
        setKeys([]);
        setProviders([]);
      });
    return () => {
      live = false;
    };
  }, [api, reloadTick]);

  async function run(providerId: string, action: () => Promise<string>) {
    setBusy(providerId);
    setMessage(null);
    try {
      setMessage({ kind: "ok", text: await action() });
      reload();
    } catch (e) {
      setMessage({ kind: "error", text: e instanceof ApiError ? e.message : "Something went wrong." });
    } finally {
      setSecret(""); // never keep the key in memory longer than needed
      setBusy(null);
    }
  }

  function save(event: FormEvent, providerId: string, exists: boolean) {
    event.preventDefault();
    const apiKey = secret.trim();
    void run(providerId, async () => {
      if (exists) await api.put(`/api/keys/${providerId}`, { apiKey });
      else await api.post("/api/keys", { providerId, apiKey });
      setEditing(null);
      return exists ? "Key replaced. Test it to confirm it works." : "Key saved (encrypted). Test it to confirm it works.";
    });
  }

  return (
    <>
      <p className="eyebrow">PROVIDERS</p>
      <h1 className="page-title">API keys</h1>
      <p className="muted lead">Bring your own key. Keys are encrypted on the server and can never be shown again; only the last characters are displayed.</p>
      {message && <p className={`notice ${message.kind === "ok" ? "notice-ok" : "notice-error"}`} role={message.kind === "error" ? "alert" : "status"}>{message.text}</p>}
      {(keys === null || providers === null) && <p className="muted" role="status">Loading…</p>}
      {keys && providers && providers.length === 0 && <p className="muted">No providers are available.</p>}
      {keys && providers && providers.map((p) => {
        const key = keys.find((k) => k.providerId === p.id);
        const showForm = !key || editing === p.id;
        return (
          <section className="panel key-card" key={p.id} aria-labelledby={`k-${p.id}`}>
            <div className="row-between">
              <div>
                <h2 id={`k-${p.id}`}>{p.name}</h2>
                {p.description && <p className="muted small">{p.description}</p>}
              </div>
              {key && <span className={`badge badge-${key.validationStatus}`}>{STATUS_LABEL[key.validationStatus]}</span>}
            </div>
            {key && <p className="mono masked" aria-label="Saved key (masked)">{key.masked}</p>}
            {showForm && (
              <form onSubmit={(e) => save(e, p.id, !!key)} className="stack">
                <label className="field">
                  <span>{key ? "New API key" : "API key"}</span>
                  <input
                    type="password" name="provider-secret" autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false}
                    required minLength={8} maxLength={2000} placeholder="sk-…" value={secret} onChange={(e) => setSecret(e.target.value)}
                  />
                </label>
                <div className="actions">
                  <button className="btn btn-primary" type="submit" disabled={busy === p.id}>{key ? "Replace key" : "Save key"}</button>
                  {key && <button className="btn" type="button" onClick={() => { setEditing(null); setSecret(""); }}>Cancel</button>}
                </div>
              </form>
            )}
            {key && !showForm && (
              <div className="actions">
                <button className="btn btn-primary" disabled={busy === p.id} type="button"
                  onClick={() => run(p.id, async () => {
                    const r = await api.post<{ validationStatus: string }>(`/api/providers/${p.id}/test`);
                    return r.validationStatus === "valid" ? "The provider accepted this key." : "The provider rejected this key.";
                  })}>
                  {busy === p.id ? "Testing…" : "Test key"}
                </button>
                <button className="btn" type="button" onClick={() => { setEditing(p.id); setSecret(""); }}>Replace</button>
                <button className="btn btn-danger" disabled={busy === p.id} type="button"
                  onClick={() => { if (window.confirm(`Delete the saved ${p.name} key?`)) void run(p.id, async () => { await api.delete(`/api/keys/${p.id}`); return "Key deleted."; }); }}>
                  Delete
                </button>
              </div>
            )}
          </section>
        );
      })}
      <p className="muted small"><Link href="/dashboard/studio">Go to the Studio →</Link></p>
    </>
  );
}
