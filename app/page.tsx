import {
  Aperture,
  ArrowUpRight,
  Clapperboard,
  FolderOpen,
  Image as ImageIcon,
  KeyRound,
  Sparkles,
  Users,
  WandSparkles,
} from "lucide-react";

const workspaces = [
  {
    title: "Image Studio",
    description: "Create and transform images.",
    icon: ImageIcon,
    status: "Planned",
  },
  {
    title: "Video Studio",
    description: "Generate video from prompts and images.",
    icon: Clapperboard,
    status: "Planned",
  },
  {
    title: "AI Editor",
    description: "Edit media with AI-assisted tools.",
    icon: WandSparkles,
    status: "Planned",
  },
  {
    title: "Character Studio",
    description: "Manage references and consent-based character workflows.",
    icon: Users,
    status: "Planned",
  },
];

const utilities = [
  { title: "My Library", description: "Your generated and uploaded assets.", icon: FolderOpen },
  { title: "AI Providers", description: "Configure your own provider API keys.", icon: KeyRound },
];

export default function HomePage() {
  return (
    <main className="mx-auto min-h-screen w-full max-w-7xl px-5 py-8 sm:px-8 lg:px-10">
      <header className="flex items-center justify-between border-b border-[var(--border)] pb-6">
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-2xl bg-white text-zinc-950">
            <Aperture size={22} />
          </div>
          <div>
            <p className="font-semibold tracking-tight">Creative Studio</p>
            <p className="text-xs text-[var(--muted)]">PERSONAL AI WORKSPACE</p>
          </div>
        </div>
        <span className="rounded-full border border-[var(--border)] px-3 py-1.5 text-xs text-[var(--muted)]">
          Foundation setup
        </span>
      </header>

      <section className="py-12 sm:py-16">
        <div className="mb-4 flex items-center gap-2 text-sm text-[var(--muted)]">
          <Sparkles size={16} />
          One workspace. Multiple creative capabilities.
        </div>
        <h1 className="max-w-3xl text-4xl font-semibold tracking-tight sm:text-6xl">
          Make your ideas <span className="text-zinc-500">visual.</span>
        </h1>
        <p className="mt-5 max-w-xl text-base leading-7 text-[var(--muted)]">
          A private creative workspace for generating, editing, and organizing images and videos with the AI providers you choose.
        </p>
      </section>

      <section>
        <div className="mb-5 flex items-end justify-between">
          <div>
            <p className="text-sm font-medium">Creative workspaces</p>
            <p className="mt-1 text-sm text-[var(--muted)]">Your production tools, in one place.</p>
          </div>
          <span className="text-xs text-[var(--muted)]">4 modules</span>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {workspaces.map((item) => {
            const Icon = item.icon;
            return (
              <article key={item.title} className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 transition-colors hover:border-zinc-600">
                <div className="flex items-start justify-between">
                  <div className="flex size-11 items-center justify-center rounded-xl bg-[var(--surface-raised)]">
                    <Icon size={21} />
                  </div>
                  <span className="rounded-full bg-[var(--surface-raised)] px-2.5 py-1 text-[11px] text-[var(--muted)]">{item.status}</span>
                </div>
                <h2 className="mt-5 font-medium">{item.title}</h2>
                <p className="mt-1 text-sm leading-6 text-[var(--muted)]">{item.description}</p>
              </article>
            );
          })}
        </div>
      </section>

      <section className="mt-10">
        <p className="mb-4 text-sm font-medium">Workspace utilities</p>
        <div className="grid gap-3 sm:grid-cols-2">
          {utilities.map((item) => {
            const Icon = item.icon;
            return (
              <article key={item.title} className="flex items-center gap-4 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5">
                <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-[var(--surface-raised)]">
                  <Icon size={19} />
                </div>
                <div className="min-w-0 flex-1">
                  <h2 className="text-sm font-medium">{item.title}</h2>
                  <p className="mt-1 text-sm text-[var(--muted)]">{item.description}</p>
                </div>
                <ArrowUpRight size={17} className="text-[var(--muted)]" />
              </article>
            );
          })}
        </div>
      </section>

      <footer className="mt-16 border-t border-[var(--border)] py-6 text-xs leading-6 text-[var(--muted)]">
        Initial foundation only. AI integrations, storage, and production services are not connected yet.
      </footer>
    </main>
  );
}
