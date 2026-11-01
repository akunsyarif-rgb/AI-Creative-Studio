# AI Creative Studio

A personal, mobile-first AI creative workspace for image generation, image editing, video generation, video editing, and consent-based character transformation.

## Project status

Initial repository setup. The application has not yet been connected to production services or deployed.

## Development

The implementation plan, architecture, security requirements, and development workflow are documented in `CLAUDE.md` and `docs/`.

## Principles

- Personal use with Bring Your Own Key (BYOK).
- Provider-independent capability adapters.
- Server-side secret handling.
- Asynchronous processing for long-running media jobs.
- Cost visibility and explicit paid-model fallback.
- Preserve source assets and project history.

## Safety

Character and face transformation must only be used with the subject's consent or for the user's own likeness. Synthetic media should be represented transparently.
