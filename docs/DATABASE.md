# Database Schema

The initial migration is `supabase/migrations/0001_initial_schema.sql`.

## Tables
- `projects`: owner-scoped creative projects.
- `media_assets`: private object metadata and source/output relationships.
- `providers`, `provider_models`: provider catalog and verified model capability metadata.
- `provider_credentials`: encrypted BYOK credentials; plaintext keys must never be stored.
- `ai_jobs`: normalized generation/editing job state and idempotency.
- `job_events`: append-only job lifecycle events.
- `job_costs`: estimate and actual cost ledger.
- `characters`: user-owned character references and consent confirmation metadata.

## Ownership
All user data tables use `owner_id` referencing `auth.users` and have Row Level Security enabled. Client access is limited by RLS. Provider/model catalog rows are readable by authenticated users; catalog writes should be performed only by trusted server-side administration or migrations.

## Storage
The migration creates a private `creative-assets` bucket. Object names must begin with the authenticated owner's UUID, for example:

```text
<owner-uuid>/<project-uuid>/<asset-uuid>.<ext>
```

Storage policies enforce the first path segment. The bucket is private; deliver files through short-lived signed URLs after application authorization.

## Important operational notes
- Review the migration against the target Supabase version before applying.
- Do not expose the service-role key to browser code.
- A database migration does not configure application authentication, provider credentials, or R2.
- Credential encryption uses a server-side 32-byte base64 key. Back up and rotate this key with a documented re-encryption procedure; losing it makes stored provider credentials unrecoverable.
- Never use a service-role client to bypass owner checks without explicit authorization in the server route.
