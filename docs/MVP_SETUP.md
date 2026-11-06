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
- Appwrite Free allows **one database per project**. If another app already uses it, set `APPWRITE_DATABASE_ID` to that
  existing database's id: this app then creates only its own tables there, named `studio_jobs`, `studio_keys` and
  `studio_metadata`. Setup never modifies an existing database, and it refuses to touch a pre-existing table that has
  columns this app does not define. Row-level security keeps each user's rows private, but the tables share a database with
  the other app's data.
- This app only touches the database named by `APPWRITE_DATABASE_ID`, but an API key
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

## Custom providers (any OpenAI-compatible API)
On **API keys → Add an OpenAI-compatible provider** you can add a service you choose: a name, its https base URL (for example
`https://api.together.xyz/v1`), the model name(s) as that provider spells them, your own per-image cost estimate, and the key.
The app calls `POST {baseUrl}/images/generations` (and `GET {baseUrl}/models` for **Test key**) and accepts either
`b64_json` or an image `url` in the answer. Text-to-image only. This covers services that expose that OpenAI-compatible endpoint, **not every provider**: services with a
different API style (job queues with polling, native Stability/Google/Replicate/fal APIs, image editing, video) need a dedicated
adapter (see below).
- The base URL is user-supplied, so it is restricted: https only, no credentials/query/odd ports, and the host must resolve
  to public addresses (checked when saving and again before every request). Redirects are refused for API calls; image
  links in answers are fetched only from public https hosts (max 2 re-validated redirects, 25 MB), and your key is never
  sent to those image hosts. Residual risk: DNS could change between the check and the request.
- The per-image cost is optional. If you enter one it drives the confirmation prompt and the `MAX_JOB_COST_USD` ceiling. If you leave it empty the price is "unknown": every request needs explicit consent (shown as "price unknown"), nothing is remembered, and the spend ceiling **cannot** be applied. An unknown price is never treated as free.
- The key and base URL settings are stored per user; the key itself is encrypted like every other key.
- New columns (`label`, `baseUrl`, `models`, `estimatedCostUsd`) were added to `studio_keys`: re-run **Appwrite setup** once.

### SpicyAPI (native task API)
SpicyAPI does **not** offer an OpenAI-style images endpoint; images use an asynchronous task API (`createTask`, then polling).
On **API keys → Add another provider** choose *OpenAI-compatible*, set the address to `https://api.spicyapi.ai/api/v1`
(the app recognises this host and uses the native adapter) and list the model ids exactly as shown in your SpicyAPI model
catalog (the authenticated catalog is the only valid source). The model id's ending decides what it does:
`.../text-to-image` creates an image from a prompt; `.../edit` edits the single reference image you attach in the Studio
(copies up to 3 MB are sent; the app reads the model's own input fields first and refuses, at no cost, when it needs fields
it cannot fill). Give a model its own price by writing it after `=` in the model list, for example
`alibaba/qwen-image-2.1-turbo/text-to-image=0.0144`; models without one use the provider's default cost (or ask for
"price unknown" consent when that is empty).

**Video (SpicyAPI).** A model id ending in `/text-to-video` or `/image-to-video` appears when you choose **Video** in the
Studio (with a start image attached it uses the image-to-video model). The app reads the model's input fields first and
checks the length you chose; it then creates ONE task and saves SpicyAPI's task id. The video itself is collected whenever
you look at the job (the Studio, or the Library, which refreshes running jobs every few seconds), so closing the page loses
nothing and nothing is ever submitted twice. Notes: an accepted task cannot be cancelled; the price per clip is not known in
advance (enter your own per-clip price as `model=price`, or confirm "price unknown"); videos are limited to 150 MB; the result
is only collected while you (or a page of yours) look at it, so a finished clip may show up the next time you open the Library.
Not supported: reference-video, video editing and face/head swap tools.
- Create the key on SpicyAPI as a *Model API* key, restrict it to the image model(s) you use and **set a spend cap**: the app
  cannot know the price in advance, so every request asks for "price unknown" consent and the cap is your hard limit.
- One `createTask` attempt per job (never retried). Waiting is bounded (~4 min); if it runs out, the task id is shown so you can
  check SpicyAPI's task history instead of paying twice. Subject swap, reference/edit endpoints are intentionally not supported.

### Custom HTTP (advanced)
For a service with its own request style, choose **Custom HTTP request** and describe it from the provider's documentation:
the site address, the request path (may contain `{{model}}`), the header that carries the key and its prefix, a JSON request
body using `{{prompt}}`, `{{model}}`, `{{size}}`, `{{width}}`, `{{height}}`, and where the image is in the answer (a dotted path
such as `data.0.b64_json` whose value is base64, a `data:` link or an https link, or "the image file itself"). An optional GET
path powers **Test key**.
- Supported: one JSON POST that answers directly with the image (or a link to it). **Not supported**: file/multipart uploads,
  keys in the query string, and APIs that return a job id and need polling (many hosted-model services work that way).
- Placeholders are substituted into string values only, so prompt text cannot change the request structure. Never put your key
  in the body; it is added in the header you choose. The same network rules apply as for OpenAI-compatible providers.
- The template is stored per user in `studio_keys.httpConfig` (new column: re-run **Appwrite setup** once).

## Adding a provider
Providers are plugged in through the registry; core execution code never changes.
1. Copy `src/lib/providers/adapters/_template.ts` to `adapters/<provider>.ts` and implement it
   (`config`, `getCapabilities`, `validateRequest`, `testKey`, `estimateCost`, `executeJob`). The rules for
   billing safety and error handling are in the template header.
2. Register it in `src/lib/providers/index.ts`.
3. Add a test next to it with a mocked `fetch` (see `adapters/openai.test.ts`).
The `/dashboard/keys` and `/dashboard/studio` pages read providers, models and parameters from `GET /api/providers`.
