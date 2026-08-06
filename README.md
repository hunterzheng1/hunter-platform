# hunter-platform

Web Console slice split from Hunter-Harness: Next.js UI (`apps/web`) and Fastify API (`apps/server`), plus shared `@hunter-harness/contracts` and `@hunter-harness/core`.

Package names and console behavior match Hunter-Harness. CLI / skill-cli / workflow-data-harness npm packaging stays in the Hunter-Harness repo.

## Requirements

- Node.js >= 24, npm >= 11
- Postgres 17 (for `apps/server` runtime)

## Setup

```bash
npm install
cp .env.example .env
# create secrets/postgres_password.txt (and optional bootstrap token) before compose
```

### Typecheck / build

```bash
npm run typecheck
npm run build
```

### Local run (without Docker)

1. Start Postgres and set `DATABASE_URL` / `ARTIFACT_ROOT`.
2. Build and start API:

```bash
npm run build -w packages/contracts -w packages/core -w apps/server
npm run start -w apps/server
```

3. Start web (API rewrite optional via `HUNTER_HARNESS_INTERNAL_API_URL`):

```bash
npm run dev -w apps/web
```

### Docker Compose

```bash
docker compose up --build
```

Web defaults to port `3000` (`WEB_PORT`). npm publish overlay is not included here; configure `HUNTER_HARNESS_NPM_SCOPE` + token the same way as Hunter-Harness when needed.
