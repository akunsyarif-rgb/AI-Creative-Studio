# Database Schema

The schema is defined by ordered SQL migrations in `supabase/migrations/`.

## Tables
- `app_owner`: explicit allowlist containing the one permitted application user.
- `projects`: owner-scoped creative projects.
- `media_assets`: private object metadata and source/output relationships.
- `providers`, `provider_models`: provider catalog and verified model capability metadata.
- `provider_credentials`: encrypted BYOK credentials; no browser-role policy is intentionally granted.
- `ai_jobs`: normalized generation/editing job state and idempotency.
- `ai_job_inputs`: normalized input assets with same-owner composite foreign keys.
- `job_events`: append-only job lifecycle events.
- `job_costs`: estimate and actual cost ledger.
- `characters`: user-owned character references and consent confirmation metadata.

## Single-owner bootstrap
The second migration creates an explicit allowlist. After the owner's Supabase Auth account exists, add its UUID once through the Supabase SQL editor:

```sql
insert into public.app_owner (user_id)
values ('REPLACE-WITH-AUTH-USER-UUID')
on conflict (user_id) do nothing;
```

Do not insert multiple users. The UUID must come from the project's Auth user list, not from a browser request. Until this row exists, authenticated users are denied access by the application RLS policies.

## Ownership and write boundaries
All user data tables use `owner_id` referencing `auth.users` and have Row Level Security enabled. Composite foreign keys bind project, asset, job, and event relationships to the same owner, preventing cross-owner references even if a UUID is known.

Browser clients can read their own job status, job events, costs, and job input metadata. They cannot directly mutate job lifecycle or cost records. BYOK credentials are intentionally inaccessible to browser Supabase roles. Trusted server routes/workers must authenticate the user, verify `public.is_app_owner()`, derive owner ID from the verified session, and only then use a server-side service-role client.

Provider/model catalog rows are readable only to the configured app owner; catalog writes should be performed only by trusted server-side administration or migrations.

## Storage
The migration creates a private `creative-assets` bucket. Object names must begin with the authenticated owner's UUID, for example:

```text
<owner-uuid>/<project-uuid>/<asset-uuid>.<ext>
```

Storage policies enforce both the configured owner and the first path segment. The bucket is private; deliver files through short-lived signed URLs after application authorization.

## Operational notes
- Review and apply migrations only to a dedicated Supabase project after explicit approval.
- Migrations are not executed by repository commits.
- Do not expose the service-role key to browser code.
- A database migration does not configure application authentication, provider credentials, or R2.
- Credential encryption uses a server-side 32-byte base64 key. Back up and rotate this key with a documented re-encryption procedure; losing it makes stored provider credentials unrecoverable.
- Never use a service-role client to bypass owner checks without explicit authorization in the server route.
