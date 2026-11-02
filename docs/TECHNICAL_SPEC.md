# Technical Specification v1.0

## Capabilities
text_to_image, image_to_image, image_edit, inpaint, outpaint, image_upscale, text_to_video, image_to_video, video_to_video, video_edit, background_remove, object_remove, object_replace, face_replace, character_consistency.

Enable a capability only when a configured provider/model actually supports it.

## Screens
Dashboard; Image Studio; Video Studio; AI Editor; Character Studio; Library; Providers; Settings.

## Job creation
POST /api/jobs accepts projectId, capability, providerId, modelId, inputAssetIds, parameters, and a unique idempotencyKey. Persist before dispatch and return a job ID, queued status, and cost estimate where available.

GET /api/jobs/:id returns normalized status, progress, safe error details, outputs, and cost. POST /api/jobs/:id/cancel requests cancellation; provider cancellation is not guaranteed.

## States
queued, submitted, processing, validating, completed, failed, cancelled. Terminal states cannot return to active states.

## Reliability
Use durable workers for long-running jobs. Persist provider job IDs. Distinguish retryable failures. Never repeat a billable submission blindly after timeout. Record estimates and actual costs separately.

## Validation
Validate schema, ownership, uploads, actual media metadata, provider outputs, MIME, dimensions, duration and size. Sanitize provider errors. Reject unsupported parameters before submission.

## Storage
Original uploads and generated outputs are separate immutable assets. Outputs reference their source job and optional parent asset. Keep objects private and use short-lived signed URLs after authorization.

## Acceptance tests
- Invalid key rejected; secret never appears in client responses/logs.
- User cannot read another user's jobs/assets.
- Duplicate idempotency key does not create duplicate paid work.
- Provider timeout can be reconciled.
- Worker restart does not lose queued work.
- Unsupported capability blocked before submission.
- Invalid output is not marked completed.
- Refresh preserves job state.
- Editing preserves source assets.
- Downloads require authorization.
- Budget ceiling blocks or asks for confirmation.
- Core flows usable on iPad/iPhone Safari.

## Decisions pending
Confirm Supabase vs Appwrite, R2 vs alternative, Vercel + Cloudflare Workers/Queues vs Cloudflare full-stack, and initial providers/pricing policy before integrations.