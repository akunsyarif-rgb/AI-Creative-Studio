# Local Development Setup

## Requirements
- Node.js 22 or newer (Node.js 22 is the repository baseline).
- npm.
- Git.

## Install

```bash
npm install
```

## Configure environment

Copy `.env.example` to `.env.local` and fill only the values for services that have been explicitly configured.

Generate a 32-byte random encryption key for local development:

```bash
openssl rand -base64 32
```

Put the generated value in `APP_ENCRYPTION_KEY`. Do not commit `.env.local` or share the key. Production secrets must be configured in the deployment platform's secret manager, not in Git.

Supabase, R2, provider APIs, queues, and webhooks are not connected in the initial repository setup. Do not add real credentials until the corresponding integration is implemented and reviewed.

## Run

```bash
npm run dev
```

Open `http://localhost:3000`.

## Quality checks

```bash
npm run lint
npm run typecheck
npm run build
```

Run these checks after installing dependencies. A successful local build does not establish that external providers, storage, authentication, or background processing are production-ready.

## Branch workflow
- `main`: stable baseline; do not push feature work directly.
- `develop`: integration branch.
- `feat/<short-name>`: individual feature branches.

Use pull requests to merge feature branches into `develop`. Promote to `main` only after review and acceptance checks.
