# AI Creative Studio

A personal, mobile-first AI creative workspace for image generation, image editing, video generation, video editing, and consent-based character transformation.

## Project status

Working MVP, not yet deployed. Implemented: email/password login (Appwrite), BYOK key vault (AES-256-GCM, rotatable),
private R2 uploads with size/MIME/magic-byte verification, a provider registry (OpenAI and OpenRouter image adapters),
single-attempt job execution with cost confirmation and a per-job spend ceiling, and the Studio, Library and API-keys UI.
Not yet built: video, the AI editor, Character Studio, durable background workers, spend reporting.
Known limitations and unverified provider details are listed in `docs/MVP_SETUP.md`.

## Development

```bash
npm ci
npm run lint && npm run typecheck && npm test && npm run build
```

Setup of Appwrite, the R2 bucket and hosting (including a terminal-free path for iPad) is in `docs/MVP_SETUP.md`.
After deploying, open `/api/health` to confirm the configuration is complete (it never shows secret values).
The implementation plan, architecture and security requirements are in `CLAUDE.md` and `docs/`.

## Principles

- Personal use with Bring Your Own Key (BYOK).
- Provider-independent capability adapters.
- Server-side secret handling.
- Asynchronous processing for long-running media jobs.
- Cost visibility and explicit paid-model fallback.
- Preserve source assets and project history.

## Safety

Character and face transformation must only be used with the subject's consent or for the user's own likeness. Synthetic media should be represented transparently.
