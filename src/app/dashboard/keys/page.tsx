"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { ApiError, parseModelList, type ProviderView } from "@/lib/client/api";
import { useApi } from "@/lib/client/use-session";

interface KeyView {
  providerId: string;
  masked: string;
  validationStatus: "unvalidated" | "valid" | "invalid";
  updatedAt: string;
  custom?: { estimatedCostUsd: number | null } | null;
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

  // "Custom provider" form: any service that offers an OpenAI-style images API.
  const [customOpen, setCustomOpen] = useState(false);
  const [cName, setCName] = useState("");
  const [cUrl, setCUrl] = useState("");
  const [cModels, setCModels] = useState("");
  const [cCost, setCCost] = useState("");
  const [cKey, setCKey] = useState("");
  // Advanced: describe the provider's own request instead of the OpenAI images format.
  const [cStyle, setCStyle] = useState<"openai" | "http">("openai");
  const [hPath, setHPath] = useState("");
  const [hAuthHeader, setHAuthHeader] = useState("Authorization");
  const [hAuthScheme, setHAuthScheme] = useState("Bearer");
  const [hBody, setHBody] = useState('{\n  "model": "{{model}}",\n  "prompt": "{{prompt}}"\n}');
  const [hKind, setHKind] = useState<"json" | "binary">("json");
  const [hRespPath, setHRespPath] = useState("");
  const [hTestPath, setHTestPath] = useState("");

  const [reloadTick, setReloadTick] = useState(0);
  // Editing the models / price of a custom provider (the key and address stay as they are).
  const [editCfg, setEditCfg] = useState<string | null>(null);
  const [eModels, setEModels] = useState("");
  const [eCost, setECost] = useState("");
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

  function saveCustomEdit(event: FormEvent, providerId: string) {
    event.preventDefault();
    const models = parseModelList(eModels);
    void run(providerId, async () => {
      await api.patch(`/api/keys/${providerId}`, { models, estimatedCostUsd: eCost.trim() ? Number(eCost) : null });
      setEditCfg(null);
      return "Provider updated. Your saved key was not changed.";
    });
  }

  function addCustom(event: FormEvent) {
    event.preventDefault();
    const apiKey = cKey.trim();
    const models = parseModelList(cModels);
    void run("custom-new", async () => {
      await api.post("/api/keys", {
        apiKey,
        custom: {
          label: cName.trim(), baseUrl: cUrl.trim(), models, ...(cCost.trim() ? { estimatedCostUsd: Number(cCost) } : {}),
          ...(cStyle === "http"
            ? {
                http: {
                  path: hPath.trim(), authHeader: hAuthHeader.trim(), authScheme: hAuthScheme.trim(), body: hBody, responseKind: hKind,
                  ...(hKind === "json" ? { responsePath: hRespPath.trim() } : {}),
                  ...(hTestPath.trim() ? { testPath: hTestPath.trim() } : {})
                }
              }
            : {})
        }
      });
      setCName(""); setCUrl(""); setCModels(""); setCKey(""); setCustomOpen(false);
      return "Custom provider saved (key encrypted). Test the key, then pick it in the Studio.";
    }).finally(() => setCKey(""));
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
                <h2 id={`k-${p.id}`}>{p.name}{p.custom && <span className="badge" style={{ marginLeft: 8 }}>Custom</span>}</h2>
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
            {key && p.custom && editCfg === p.id && (
              <form onSubmit={(e) => saveCustomEdit(e, p.id)} className="stack">
                <label className="field">
                  <span>Model name(s)</span>
                  <input required autoCapitalize="none" autoCorrect="off" spellCheck={false} value={eModels} onChange={(e) => setEModels(e.target.value)} />
                  <small className="muted">Exactly as the provider names them. Separate several with commas (up to 10).</small>
                </label>
                <label className="field">
                  <span>Cost per image in USD (optional)</span>
                  <input type="number" inputMode="decimal" step="any" min="0.0001" max="100" placeholder="Leave empty if unknown" value={eCost} onChange={(e) => setECost(e.target.value)} />
                </label>
                <p className="muted small">The address and your saved key stay the same.</p>
                <div className="actions">
                  <button className="btn btn-primary" type="submit" disabled={busy === p.id}>Save changes</button>
                  <button className="btn" type="button" onClick={() => setEditCfg(null)}>Cancel</button>
                </div>
              </form>
            )}
            {key && !showForm && editCfg !== p.id && (
              <div className="actions">
                <button className="btn btn-primary" disabled={busy === p.id} type="button"
                  onClick={() => run(p.id, async () => {
                    const r = await api.post<{ validationStatus: string }>(`/api/providers/${p.id}/test`);
                    return r.validationStatus === "valid" ? "The provider accepted this key." : "The provider rejected this key.";
                  })}>
                  {busy === p.id ? "Testing…" : "Test key"}
                </button>
                {p.custom && (
                  <button className="btn" type="button"
                    onClick={() => { setEditCfg(p.id); setEModels(p.models.map((m) => m.modelId).join(", ")); setECost(key.custom?.estimatedCostUsd ? String(key.custom.estimatedCostUsd) : ""); }}>
                    Edit
                  </button>
                )}
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
      {keys && providers && (
        <section className="panel key-card" aria-labelledby="k-custom">
          <div className="row-between">
            <div>
              <h2 id="k-custom">Add another provider</h2>
              <p className="muted small">
                Choose <b>OpenAI-compatible</b> for services with a <span className="mono">POST …/images/generations</span> endpoint, or
                <b>Custom HTTP</b> to describe the provider&apos;s own request from its documentation. Works for services that answer
                directly; APIs that need polling or file uploads are not supported. Text-to-image only.
              </p>
            </div>
            {!customOpen && <button className="btn" type="button" onClick={() => setCustomOpen(true)}>Add</button>}
          </div>
          {customOpen && (
            <form onSubmit={addCustom} className="stack">
              <label className="field">
                <span>Name</span>
                <input required minLength={2} maxLength={64} placeholder="Together AI" value={cName} onChange={(e) => setCName(e.target.value)} />
              </label>
              <label className="field">
                <span>Type</span>
                <select value={cStyle} onChange={(e) => setCStyle(e.target.value as "openai" | "http")}>
                  <option value="openai">OpenAI-compatible images API</option>
                  <option value="http">Custom HTTP request (advanced)</option>
                </select>
              </label>
              <label className="field">
                <span>API address (base URL)</span>
                <input
                  required type="url" inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false} maxLength={300}
                  placeholder="https://api.together.xyz/v1" value={cUrl} onChange={(e) => setCUrl(e.target.value)}
                />
                <small className="muted">{cStyle === "http" ? "Only the site address, for example https://api.example.com (the path goes below). Must start with https://." : "Must start with https://. Do not include /images/generations. For SpicyAPI use https://api.spicyapi.ai/api/v1 (see docs)."}</small>
              </label>
              <label className="field">
                <span>Model name(s)</span>
                <input
                  required autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="black-forest-labs/FLUX.1-schnell"
                  value={cModels} onChange={(e) => setCModels(e.target.value)}
                />
                <small className="muted">Exactly as the provider names them. Separate several with commas (up to 10). {cStyle === "http" ? "If the provider has no model names, enter any label." : ""}</small>
              </label>
              {cStyle === "http" && (
                <div className="stack">
                  <label className="field">
                    <span>Request path</span>
                    <input
                      required autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="/v1/generate or /models/{{model}}"
                      value={hPath} onChange={(e) => setHPath(e.target.value)}
                    />
                    <small className="muted">Added after the address. You may use {"{{model}}"} in it.</small>
                  </label>
                  <div className="grid-2">
                    <label className="field">
                      <span>Key header name</span>
                      <input required autoCapitalize="none" autoCorrect="off" spellCheck={false} value={hAuthHeader} onChange={(e) => setHAuthHeader(e.target.value)} />
                    </label>
                    <label className="field">
                      <span>Prefix before the key</span>
                      <input autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="Bearer (or empty)" value={hAuthScheme} onChange={(e) => setHAuthScheme(e.target.value)} />
                    </label>
                  </div>
                  <label className="field">
                    <span>Request body (JSON)</span>
                    <textarea
                      required rows={6} autoCapitalize="none" autoCorrect="off" spellCheck={false} className="mono"
                      value={hBody} onChange={(e) => setHBody(e.target.value)}
                    />
                    <small className="muted">
                      Placeholders: {"{{prompt}}"}, {"{{model}}"}, {"{{size}}"}, {"{{width}}"}, {"{{height}}"}. {"{{prompt}}"} is required.
                      Do not put your API key here; it is added automatically in the header.
                    </small>
                  </label>
                  <label className="field">
                    <span>The answer contains</span>
                    <select value={hKind} onChange={(e) => setHKind(e.target.value as "json" | "binary")}>
                      <option value="json">JSON with the image inside</option>
                      <option value="binary">The image file itself</option>
                    </select>
                  </label>
                  {hKind === "json" && (
                    <label className="field">
                      <span>Where is the image in the JSON?</span>
                      <input
                        required autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="data.0.b64_json"
                        value={hRespPath} onChange={(e) => setHRespPath(e.target.value)}
                      />
                      <small className="muted">A dotted path, e.g. data.0.b64_json or images.0.url. The value may be base64, a data: link or an https link.</small>
                    </label>
                  )}
                  <label className="field">
                    <span>Key-check path (optional)</span>
                    <input
                      autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="/v1/me"
                      value={hTestPath} onChange={(e) => setHTestPath(e.target.value)}
                    />
                    <small className="muted">A GET address that answers 200 for a valid key. Used by Test key.</small>
                  </label>
                </div>
              )}
              <label className="field">
                <span>Cost per image in USD (optional)</span>
                <input type="number" inputMode="decimal" min="0.0001" max="100" step="any" placeholder="Leave empty if unknown" value={cCost} onChange={(e) => setCCost(e.target.value)} />
                <small className="muted">
                  If you leave this empty, each request asks for your confirmation with a &quot;price unknown&quot; notice, and the spend limit
                  cannot be applied. If you enter a price, you see it before each request and the limit is enforced.
                </small>
              </label>
              <label className="field">
                <span>API key</span>
                <input
                  type="password" name="custom-secret" autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false}
                  required minLength={8} maxLength={2000} value={cKey} onChange={(e) => setCKey(e.target.value)}
                />
              </label>
              <p className="notice notice-warn small">This key is sent to the address above with every request. Only enter addresses you trust, and double-check the spelling.</p>
              <div className="actions">
                <button className="btn btn-primary" type="submit" disabled={busy === "custom-new"}>{busy === "custom-new" ? "Saving…" : "Save provider"}</button>
                <button className="btn" type="button" onClick={() => { setCustomOpen(false); setCKey(""); }}>Cancel</button>
              </div>
            </form>
          )}
        </section>
      )}
      <p className="muted small"><Link href="/dashboard/studio">Go to the Studio →</Link></p>
    </>
  );
}
