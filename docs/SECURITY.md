# Security Baseline

## Secrets
- Keep all real credentials in deployment secret storage or local ignored environment files.
- Commit only placeholder variable names in `.env.example`.
- Never use `NEXT_PUBLIC_` for provider, database service-role, R2, or encryption secrets.
- Encrypt BYOK credentials with authenticated encryption (AES-256-GCM) using a server-held 32-byte master key, or use a dedicated secret manager.
- Never log request headers, authorization values, API keys, or raw secret payloads.
- Provider credential ciphertext is server-only. Do not grant browser Supabase clients direct table access.

## Access control
- Treat the application as a single-owner private application, not as an unauthenticated private website.
- The `app_owner` allowlist must contain exactly one Auth user UUID. RLS policies deny all other signed-in users.
- Require owner authentication before exposing projects, media, provider settings, or job endpoints.
- Apply Supabase Row Level Security to user-owned records.
- Keep the provider credential table inaccessible to authenticated browser roles; trusted server routes use a service-role client only after verifying the owner session and owner allowlist.
- Keep R2 buckets private and issue short-lived signed URLs only after authorization.
- Never trust an owner ID supplied by the browser; derive it from the verified session.

## Media handling
- Enforce configurable file-size limits.
- Validate extension, declared MIME type, and file signature where feasible.
- Generate opaque object keys; do not use user-supplied paths as storage keys.
- Do not execute uploaded files.
- Preserve source media unless the owner explicitly deletes it.
- Provide deletion for source files, generated outputs, and related metadata.

## Jobs and webhooks
- Browser clients may read their own job status but must not directly update provider IDs, status, or cost fields.
- Create/update jobs, job events, and cost records through trusted server code after authorization.
- Use idempotency keys for job submission.
- Verify provider webhook signatures and timestamps where supported.
- Reject duplicate/replayed webhook events.
- Limit retries and avoid retrying non-idempotent billable submissions without checking provider state.
- Validate provider output before marking a job complete.

## Character and synthetic media
- Face/character transformation of real people requires the subject's consent or the user's own likeness rights.
- Do not facilitate non-consensual intimate imagery, deceptive impersonation, or identity fraud.
- Clearly identify generated or materially altered media where appropriate.
- Do not use uploaded likenesses to train models.

## Incident response
- Rotate a credential immediately if exposure is suspected.
- Review deployment logs and provider usage after a suspected leak.
- Revoke affected keys at the provider.
- Document the incident and verify the old key can no longer be used.
