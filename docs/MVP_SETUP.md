# MVP setup (manual steps; nothing here is provisioned automatically)

1. **Appwrite**: create a project, enable Email/Password auth, add your app's hostname as a *Web platform*
   (needed for browser sessions). Create a server API key with databases/collections/attributes/indexes
   write scopes. Then run `npm run appwrite:setup` (idempotent; re-run after schema changes such as
   the new `keys.last4`, `jobs.errorMessage`, `jobs.outputAssetIds` attributes).
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

## OpenRouter (unverified)
The OpenRouter adapter (`google/gemini-2.5-flash-image`, `openai/gpt-5-image-mini`) was written without live
access to openrouter.ai. Before relying on it, test with a real key: confirm the model ids exist, that image
output arrives in `choices[0].message.images[].image_url.url`, and that `/auth/key` validates keys. Prices in
the adapter are placeholders.

## Adding a provider
Providers are plugged in through the registry; core execution code never changes.
1. Copy `src/lib/providers/adapters/_template.ts` to `adapters/<provider>.ts` and implement it
   (`config`, `getCapabilities`, `validateRequest`, `testKey`, `estimateCost`, `executeJob`). The rules for
   billing safety and error handling are in the template header.
2. Register it in `src/lib/providers/index.ts`.
3. Add a test next to it with a mocked `fetch` (see `adapters/openai.test.ts`).
The `/dashboard/keys` and `/dashboard/studio` pages read providers, models and parameters from `GET /api/providers`.
