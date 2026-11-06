"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { authConfigured, authErrorMessage, currentUser, signIn, signUp } from "@/lib/client/auth";

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Already signed in on this browser: go straight to the studio instead of showing a form that cannot create a second session.
  useEffect(() => {
    let live = true;
    currentUser().then((u) => {
      if (live && u) router.replace("/dashboard/studio");
    });
    return () => {
      live = false;
    };
  }, [router]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      // Emails are case-insensitive; normalise so iPad auto-capitalisation cannot cause mismatches.
      const normalised = email.trim().toLowerCase();
      await (mode === "signin" ? signIn(normalised, password) : signUp(normalised, password));
      router.replace("/dashboard/studio");
    } catch (e) {
      setError(authErrorMessage(e, mode));
      setBusy(false);
    }
  }

  return (
    <main className="auth-shell">
      <Link className="brand" href="/"><span className="brand-mark">✳</span>AI Creative Studio</Link>
      <form className="panel auth-card" onSubmit={onSubmit} aria-labelledby="auth-title">
        <p className="eyebrow">PERSONAL WORKSPACE</p>
        <h1 id="auth-title" className="page-title">{mode === "signin" ? "Sign in" : "Create account"}</h1>
        {!authConfigured && (
          <p className="notice notice-error" role="alert">Authentication is not configured. Set NEXT_PUBLIC_APPWRITE_ENDPOINT and NEXT_PUBLIC_APPWRITE_PROJECT_ID.</p>
        )}
        <label className="field">
          <span>Email</span>
          <input type="email" inputMode="email" autoComplete="email" autoCapitalize="none" autoCorrect="off" spellCheck={false} required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="field">
          <span>Password</span>
          <input
            type="password"
            autoComplete={mode === "signin" ? "current-password" : "new-password"}
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {error && <p className="notice notice-error" role="alert">{error}</p>}
        <button className="btn btn-primary" type="submit" disabled={busy || !authConfigured}>
          {busy ? "Please wait…" : mode === "signin" ? "Sign in" : "Create account"}
        </button>
        <button className="btn btn-link" type="button" onClick={() => { setMode(mode === "signin" ? "signup" : "signin"); setError(null); }}>
          {mode === "signin" ? "New here? Create an account" : "Have an account? Sign in"}
        </button>
      </form>
    </main>
  );
}
