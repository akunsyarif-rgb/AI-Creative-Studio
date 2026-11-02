# Product Roadmap

## Phase 0 — Repository foundation
- [x] Initial README and repository setup.
- [x] Development branch.
- [ ] Application shell, project instructions, architecture, technical spec.
- [ ] Lint, typecheck, test and environment templates.

## Phase 1 — Secure foundation
- Authentication and ownership model.
- Database schema and row-level security.
- Private storage and signed upload/download.
- Server-side BYOK credential vault.
- Provider/model catalog, projects, Library, audit events and cost ledger.
Exit gate: user can authenticate, securely configure a provider, upload a private asset, and see it in Library.

## Phase 2 — Image Studio
- Text-to-image, image-to-image, targeted edits.
- Inpainting/outpainting and upscaling where supported.
- Provider tests, output validation and cost estimates.
Exit gate: end-to-end image workflows work on iPad/iPhone Safari.

## Phase 3 — Video Studio
- Text-to-video, image-to-video, video-to-video where supported.
- Durable asynchronous queue/worker, progress, retry, timeout and cancellation where supported.
- Output validation and storage.
Exit gate: jobs survive refresh/restarts without duplicate paid submissions.

## Phase 4 — AI Editor
- Background/object removal and replacement.
- Enhancement, reframing and version history.
Exit gate: edits are reproducible and never silently overwrite originals.

## Phase 5 — Character Studio
- Consent/authorization workflow.
- Face replacement and character consistency through suitable providers.
- Preview/confirmation, synthetic-media disclosure and deletion.
Exit gate: safeguards and audit behavior are tested.

## Phase 6 — Hardening and personal production
- iPad/iPhone Safari regression, security/dependency audit.
- Provider failure/rate-limit tests, spend caps and usage reporting.
- Backup/restore, accessibility and performance.
- Deployment only after separate user approval.

A feature is not complete because its button exists. Input validation, provider execution, failure handling, storage, cost accounting and mobile UX must all work.