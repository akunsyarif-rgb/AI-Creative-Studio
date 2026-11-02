# Architecture

## Product modules
- Image Studio: text-to-image, image-to-image, targeted edits, inpainting/outpainting, upscaling.
- Video Studio: text-to-video, image-to-video, video-to-video, supported video extension and controls.
- AI Editor: background/object removal or replacement, enhancement, reframing.
- Character Studio: consent-based face replacement and character consistency, only where provider capability and policy permit.
- Library: source files, generated assets, versions, job history, and metadata.
- Providers: BYOK credential management, capability catalog, pricing and usage.

## Logical topology
```text
Mobile-first PWA
  -> Authenticated API
  -> Authorization / validation / rate limits
  -> Capability router -> provider adapters
  -> Durable job store -> queue/workflow -> background workers
  -> provider submit/poll/webhook
  -> output validation -> private object storage -> Library
```

This is a proposed architecture, not a claim that infrastructure is provisioned.

## Proposed stack (pending confirmation)
- Next.js App Router, TypeScript, Tailwind CSS.
- Vercel or equivalent application hosting.
- Supabase Postgres/Auth/RLS or Appwrite (decision pending).
- Cloudflare R2 private object storage (decision pending).
- Cloudflare Queues/Workflows or equivalent durable worker system.
- Zod for request validation; Vitest and browser smoke tests.

Do not provision or connect services without explicit approval.

## Domain model
- projects: user-owned creative projects.
- media_assets: source/generated files, object key, type, dimensions, duration, size, checksum, version lineage.
- ai_jobs: capability, inputs, parameters, provider/model, state, progress, idempotency key, errors and timestamps.
- providers and provider_models: capability, constraints, pricing and availability metadata.
- provider_credentials: owner, provider, encrypted-secret reference, validation status; never return secret material.
- job_costs and job_events: estimated/actual spend and sanitized lifecycle history.
- characters: authorized references and consent metadata with strict access controls.
- app_settings: user defaults and budget controls.

All user-owned data requires server-side authorization and database-level ownership policies.

## Job lifecycle
queued -> submitted -> processing -> validating -> completed
Terminal alternatives: failed, cancelled.
Persist before dispatch. Use idempotency keys. Record provider job IDs. Retry only transient errors. Never blindly repeat a billable submission after a timeout. Validate output before completion. Cancellation is provider-dependent.

## Provider adapter contract
Each adapter should implement capabilities(), validateCredentials(secret), estimateCost(request), submitJob(request, idempotencyKey), getJobStatus(providerJobId), and optional cancelJob(providerJobId). Normalize statuses, errors, usage, and output references.

## Cost routing
Prefer eligible local/free options where suitable. Verify pricing; never infer that a model is free from its name. If no viable free option exists, disclose the reason and estimate before paid submission when material. Enforce budget controls and log estimate, actual cost, and fallback reason. Never silently spend.

## Security
Encrypt BYOK secrets at rest and decrypt only server-side for execution. Never put secrets in browser storage, client responses, logs, source maps, or commits. Use private buckets and short-lived signed URLs. Verify webhook signatures and replay protection. Validate actual media MIME, size, duration, and dimensions. Apply rate limits and spend ceilings. Provide deletion controls. Avoid unnecessary biometric/identity data. Face/character workflows require consent or authorization and must not facilitate deceptive or non-consensual use.

## Proposed API
- POST /api/uploads/presign
- POST /api/jobs
- GET /api/jobs/:id
- POST /api/jobs/:id/cancel
- GET /api/providers
- GET /api/models
- POST /api/providers/:id/test
- GET /api/projects
- GET /api/library
- POST /api/webhooks/:provider

All routes require authentication except intentionally public health endpoints.

## Operations
Long-running jobs need durable workers, bounded retries, dead-letter handling, and observability. Production requires reviewed secrets, policies, migrations, backup/restore, deletion tests, and end-to-end testing.