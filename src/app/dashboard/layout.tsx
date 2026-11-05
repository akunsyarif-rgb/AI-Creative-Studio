"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { signOut } from "@/lib/client/auth";
import { useSessionUser } from "@/lib/client/use-session";

const links = [
  { href: "/dashboard/studio", label: "Studio" },
  { href: "/dashboard/library", label: "Library" },
  { href: "/dashboard/keys", label: "API keys" }
];

export default function DashboardLayout({ children }: { children: ReactNode }) {
  const user = useSessionUser();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (user === null) router.replace("/login");
  }, [user, router]);

  if (!user) return <main className="auth-shell"><p className="muted" role="status">Loading…</p></main>;

  return (
    <div className="app-shell">
      <header className="app-bar">
        <Link className="brand" href="/dashboard/studio"><span className="brand-mark">✳</span><span className="brand-text">AI Creative Studio</span></Link>
        <nav className="app-nav" aria-label="Main">
          {links.map((l) => (
            <Link key={l.href} href={l.href} className={pathname === l.href ? "nav-link active" : "nav-link"} aria-current={pathname === l.href ? "page" : undefined}>
              {l.label}
            </Link>
          ))}
          <button className="nav-link" type="button" onClick={async () => { await signOut(); router.replace("/login"); }}>Sign out</button>
        </nav>
      </header>
      <main className={pathname.startsWith("/dashboard/library") ? "app-main wide" : "app-main"}>{children}</main>
    </div>
  );
}
