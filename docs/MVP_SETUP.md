# MVP setup (manual steps; nothing here is provisioned automatically)

0. **Without a terminal (e.g. iPad)**: add repository secrets `APPWRITE_ENDPOINT`, `APPWRITE_PROJECT_ID`, `APPWRITE_API_KEY`,
   `APPWRITE_DATABASE_ID` (GitHub → Settings → Secrets and variables → Actions), then run **Actions → Appwrite setup → Run workflow**.
1. **Appwrite**: create a project, enable Email/Password auth, add your app's hostname as a *Web platform*
   (needed for browser sessions). Create a server API key with exactly these scopes (read and write each): `databases`, `tables`, `columns`, `indexes`, `rows`.
   Then run `npm run appwrite:setup` (idempotent; re-run after schema changes such as
   the new `keys.last4`, `jobs.errorMessage`, `jobs.outputAssetIds` columns).
2. **Cloudflare R2**: create a **private** bucket and an S3 API token scoped to it. Add a CORS rule
   allowing `PUT` from your app origin with header `Content-Type` (browsers upload directly with
   presigned URLs). Do not enable public access.
3. **Env**: copy `.env.example` to `.env.local` and fill it in. Generate the BYOK keyring:
   `node -e "console.log('k1:'+require('crypto').randomBytes(32).toString('base64'))"`.
4. Sign up at `/login`, save an OpenAI key at `/dashboard/keys`, press **Test key**, then use `/dashboard/studio`.

## Known limitations
- Job execution runs via Next `after()` after the response. It is **not durable**: if the process dies mid-job
  the job stays `queued`/`submitted`. It is never re-submitted automatically (OpenAI has no idempotency key,
  so retrying could double-bill). Video needs a real durable queue (Phase 3).
- Rate limiting is in-memory per server instance.
- OpenAI prices in `src/lib/providers/openai.ts` are approximate and unverified; `actualCost` is not recorded.
- No free/local provider is implemented yet, so every generation is paid and requires cost confirmation.

## Sharing an Appwrite project with another app
Appwrite's user pool and API-key scopes are per *project*, not per database. If this app shares a project with another app:
- Set `ALLOWED_USER_EMAILS` (and/or `ALLOWED_USER_IDS`) in Vercel. Only listed accounts can use this app's API; everyone else
  gets 401 "Authentication required" even with a valid Appwrite sign-in. With neither set, **everyone is denied**.
- Create the account in this app first, then set the allowlist and redeploy. (Appwrite emails are unique, so nobody else can take
  your address once you have registered.) For a stricter rule use your Appwrite user id from Console → Auth → Users.
- Use a dedicated API key for this app and do not change project-wide Auth settings the other app relies on.
- This app only touches the database named by `APPWRITE_DATABASE_ID` (use a name that cannot clash, e.g. `studio`), but an API key
  with document scopes can technically reach every database in the project, so treat it as sensitive.

## Appwrite API key scopes (least privilege)
This app uses the TablesDB API. The key needs only: `databases.read/write`, `tables.read/write`, `columns.read/write`,
`indexes.read/write`, `rows.read/write`. Do **not** grant `users.*`, `documentsdb.*`, `vectorsdb.*`, `embeddings.*` or `sessions.*`:
in a shared project, `users.write` would let a leaked key delete or alter other apps' accounts. User sign-in is verified with the
user's own JWT, so the server key never needs user scopes.

## Checking the deployment
Open `https://<your-domain>/api/health`. `"ok": true` means every required variable is present and well-formed.
Otherwise `missing` lists the variable *names* to fix and `warnings` lists likely mistakes (for example mismatched
Appwrite endpoints, or a bucket name inside `STORAGE_ENDPOINT`). It makes no network calls and never prints values,
so it does not prove that the keys themselves are correct: use **Test key** and a first upload for that.

## OpenRouter (unverified)
The OpenRouter adapter (`black-forest-labs/flux-schnell`, `stabilityai/stable-diffusion-3`, text-to-image only)
was written without live access to openrouter.ai. It calls `POST /api/v1/images/generations` with
`{ model, prompt, n, size, response_format: "b64_json" }`. Before relying on it, test with a real key:
confirm the model ids exist in OpenRouter's catalog, that this endpoint path and the `size` parameter are
accepted, that the response is `data[0].b64_json`, and that `/auth/key` validates keys. A wrong id/path/parameter
fails safely with a 4xx ("The provider rejected the request", nothing billed). Prices in the adapter are
rough placeholders.

## Adding a provider
Providers are plugged in through the registry; core execution code never changes.
1. Copy `src/lib/providers/adapters/_template.ts` to `adapters/<provider>.ts` and implement it
   (`config`, `getCapabilities`, `validateRequest`, `testKey`, `estimateCost`, `executeJob`). The rules for
   billing safety and error handling are in the template header.
2. Register it in `src/lib/providers/index.ts`.
3. Add a test next to it with a mocked `fetch` (see `adapters/openai.test.ts`).
The `/dashboard/keys` and `/dashboard/studio` pages read providers, models and parameters from `GET /api/providers`.
