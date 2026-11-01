# AI Creative Studio — Development Rules

## Objective
Build a personal, mobile-first AI creative workspace for image generation, image editing, video generation, video editing, and consent-based face or character transformation.

## Product decisions
- Personal application; no public SaaS or multi-tenant scope in the initial release.
- Bring Your Own Key (BYOK): the owner supplies provider credentials.
- Provider-independent capability architecture.
- Local/free processing is preferred when it meets quality and reliability requirements.
- Paid processing requires cost estimation and must never be invoked silently.
- iPad and iPhone Safari are first-class targets.

## Initial technology direction
- Next.js App Router, React, TypeScript.
- Supabase PostgreSQL for application metadata.
- Cloudflare R2 for media assets.
- Cloudflare Queues/Workers or Workflows for asynchronous processing, introduced when the job pipeline requires them.
- Vercel for frontend and lightweight request orchestration.
- Zod for runtime validation.

These are architectural decisions, not permission to connect or deploy production services. Obtain explicit approval before creating or changing external infrastructure.

## Mandatory engineering rules
1. Inspect the repository, current branch, and existing implementation before editing.
2. Work on a feature branch; do not push directly to `main`.
3. Never modify unrelated repositories or services.
4. Never expose provider keys, storage secrets, or encryption keys to browser code.
5. Never commit secrets, real credentials, private media, or production environment files.
6. Validate all user input and external provider responses.
7. Use idempotency for billable jobs and avoid duplicate submissions.
8. Record provider, model, estimated cost, actual cost, and job status where available.
9. Never silently fall back to a paid model.
10. Never report success until output validation and storage have completed.
11. Preserve source files and previous output versions.
12. Use database migrations for schema changes.
13. Add tests for meaningful behavior and failure paths.
14. Keep vendor-specific logic isolated in provider adapters.
15. Handle long-running media tasks asynchronously; do not hold ordinary HTTP requests open for video generation.
16. Use signed, short-lived upload/download URLs for private media.
17. Require consent or own-likeness rights for real-person face/character transformations. Do not build deceptive impersonation workflows.
18. Do not add placeholder controls that appear functional but have no working implementation.
19. Keep the interface responsive, accessible, and usable on iPad/iPhone Safari.

## Workflow for every task
1. State the task and inspect affected files.
2. Identify risks and the smallest complete implementation.
3. Implement only the approved scope.
4. Run formatting, lint, type checks, tests, and production build as applicable.
5. Review the diff for secrets, unrelated changes, and regressions.
6. Report changed files, checks actually run, results, and remaining risks.

## Completion standard
A feature is complete only when its user flow, server behavior, validation, error handling, persistence, tests, and documentation are functional. A successful build alone does not mean a feature is production-ready.
