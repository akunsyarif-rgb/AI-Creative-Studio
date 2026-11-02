"use client";

const workspaces = [
  { title: "Image Studio", description: "Create images, edit references, and upscale results." },
  { title: "Video Studio", description: "Generate video from prompts, images, and source clips." },
  { title: "AI Editor", description: "Remove, replace, enhance, and reframe media." },
  { title: "Character Studio", description: "Consent-based face and character workflows." }
];

export default function Home() {
  return (
    <main className="shell">
      <header className="topbar">
        <a className="brand" href="/"><span className="brand-mark">✳</span>AI Creative Studio</a>
        <span className="private-label">PERSONAL WORKSPACE</span>
      </header>
      <section className="hero">
        <p className="eyebrow">YOUR CREATIVE WORKSPACE</p>
        <h1>Make something<br />worth keeping.</h1>
        <p className="intro">One workspace for image creation, video production, and thoughtful editing. Connect your own AI providers when setup is ready.</p>
      </section>
      <section className="section-heading">
        <div><p className="eyebrow">WORKSPACES</p><h2>Choose a studio</h2></div>
        <span className="count">04 MODULES</span>
      </section>
      <section className="workspace-grid" aria-label="Creative workspaces">
        {workspaces.map((workspace, index) => (
          <article className="workspace-card" key={workspace.title}>
            <div className="card-topline"><span className="card-index">0{index + 1}</span><span className="status">Planned</span></div>
            <div><h3>{workspace.title}</h3><p>{workspace.description}</p></div>
            <span className="card-arrow" aria-hidden="true">↗</span>
          </article>
        ))}
      </section>
      <section className="setup-note">
        <span className="note-icon">⌁</span>
        <div><h2>Built around your own providers</h2><p>API credentials will be stored securely on the server. No provider keys are needed in this initial preview, and no generation jobs are sent yet.</p></div>
      </section>
      <footer><span>AI CREATIVE STUDIO</span><span>FOUNDATION BUILD · 0.1.0</span></footer>
    </main>
  );
}