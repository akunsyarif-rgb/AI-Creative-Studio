# Roadmap

## Phase 0 — Foundation
- [ ] Application shell and responsive navigation
- [ ] Environment validation and safe configuration
- [ ] Supabase schema and migrations
- [ ] Private R2 upload/download integration
- [ ] Server-side BYOK credential vault
- [ ] Provider and model registry
- [ ] Job lifecycle, idempotency, and recovery design
- [ ] Cost estimate and usage ledger
- [ ] Library metadata and project management
- [ ] Security, lint, typecheck, and test baseline

**Exit criteria:** a user can configure a provider securely, submit a test job, track its status, and persist a validated result without exposing credentials.

## Phase 1 — Image Studio
- [ ] Text-to-image
- [ ] Image-to-image
- [ ] Prompt-based image editing
- [ ] Mask-based inpainting/outpainting where supported
- [ ] Upscale/enhancement where supported
- [ ] Save outputs and prompt metadata to Library

## Phase 2 — Video Studio
- [ ] Text-to-video
- [ ] Image-to-video
- [ ] Video-to-video where supported
- [ ] Video extension where supported
- [ ] Async job progress, polling/webhooks, cancellation where supported
- [ ] Output validation and R2 persistence

## Phase 3 — AI Editor
- [ ] Video trimming and basic export
- [ ] Background removal/replacement
- [ ] Object removal where supported
- [ ] Enhancement and color adjustments
- [ ] Clear distinction between deterministic editing and generative editing

## Phase 4 — Character Studio
- [ ] Character reference library
- [ ] Face detection/tracking pipeline
- [ ] Consent and rights confirmation
- [ ] Face replacement using approved provider/workflow
- [ ] Character performance transfer where supported
- [ ] Full character replacement where supported
- [ ] Temporal consistency checks and transparent synthetic-media labeling

## Phase 5 — Production hardening
- [ ] Recovery and retry tests
- [ ] Cost ceilings and paid-fallback confirmation
- [ ] Storage lifecycle and deletion controls
- [ ] iPad/iPhone Safari regression tests
- [ ] Load, file-size, and network interruption tests
- [ ] Backup and restore procedure
- [ ] Security review and production readiness checklist

## Scope exclusions for initial release
- Public user registration or multi-tenancy
- Payments and subscriptions
- Public model marketplace
- Training custom foundation models
- Professional nonlinear editing suite
- Social network or publishing platform

## Release rule
A phase is not complete because its UI exists. It is complete only after the end-to-end workflow, persistence, failure handling, tests, and documentation meet the acceptance criteria.
