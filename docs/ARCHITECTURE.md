# Architecture

## Product shape
AI Creative Studio is a single-owner, BYOK creative workspace. The initial product includes Image Studio, Video Studio, AI Editor, Character Studio, Projects, Library, and Provider Settings.

## System boundaries

```text
iPad / iPhone / Desktop browser
              |
              v
       Next.js application
              |
       Auth + API validation
              |
       Capability router
              |
       Provider adapter registry
        /       |        \
   Image API  Video API  Editing API
              |
       Async job orchestration
              |
        Result validation
              |
        Cloudflare R2
              |
       Supabase metadata
```

## Responsibilities
- **Next.js:** user interface, authenticated API routes, request validation, orchestration.
- **Supabase PostgreSQL:** projects, asset metadata, jobs, provider/model catalog, job events, cost records, settings.
- **Cloudflare R2:** private source media, generated outputs, previews, and thumbnails.
- **Provider adapters:** translate stable internal capability requests into vendor-specific API calls and normalize responses.
- **Async processing:** dispatch, poll, receive verified callbacks, retry safely, validate outputs, and persist results. Long-running video tasks must not depend on a single web request remaining open.

## Architectural rules
- Frontend components must not call vendor APIs directly.
- Provider-specific payloads must remain inside their adapter.
- Every job has an internal ID, idempotency key, capability, provider/model, status, inputs, outputs, and cost metadata.
- Provider status and internal job status are distinct.
- A job is completed only after the output has been validated and persisted.
- Retries must not accidentally submit duplicate billable work.
- Storage objects are private by default; access is granted through short-lived signed URLs.
- Source assets and previous versions are immutable from the user's perspective.

## Initial capability taxonomy
- Image: text-to-image, image-to-image, image-edit, inpainting, outpainting, upscale.
- Video: text-to-video, image-to-video, video-to-video, extend-video.
- Editing: background removal/replacement, object removal, enhancement, trim/export.
- Character: face replacement and character performance/replacement, subject to provider capability, consent, and quality checks.

## Provider strategy
Start with one validated image provider and one validated video provider. Add other providers through adapters only after confirming current API availability, supported inputs/outputs, pricing, terms, and safety restrictions. Do not assume a provider supports a capability based on its marketing name.

## Security model
- BYOK credentials are handled server-side only.
- Credentials must be encrypted at rest with authenticated encryption and a server-held master key, or stored in a dedicated secret manager.
- Never log credentials or return them to the client after save.
- Enforce owner-only access at the application and database layers.
- Validate uploads by size, MIME type, and file signature where feasible.
- Verify webhook signatures and reject replayed events.
- Keep production secrets separate from preview/development secrets.

## Deployment boundary
This repository setup does not authorize connecting Supabase, Cloudflare, Vercel, or AI providers, nor deploying production resources. Those actions require separate explicit approval.
