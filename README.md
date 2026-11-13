# Academy

Local starter for a single-user adaptive learning app. Requires Node 24, pnpm, and Docker Compose.

```sh
pnpm bootstrap
pnpm dev
```

`pnpm dev` starts PostgreSQL on port 5433, waits for it to become ready, applies migrations, seeds the default user, and starts the API on port 3001 and web app on port 5173. The web server proxies `/api` requests to the API.

Useful commands:

```sh
pnpm db:generate
pnpm db:migrate
pnpm db:seed
pnpm db:reset
pnpm check
pnpm test:unit
pnpm test
pnpm test:e2e
pnpm typecheck
pnpm lint
pnpm format
pnpm build
```

Vitest uses the separate `academy_test` database. `pnpm test:e2e` starts the local dev stack through Playwright's web server configuration.
Concurrent browser runs can isolate learner and login state with separate `TEST_DATABASE_URL`,
`PLAYWRIGHT_API_PORT`, `PLAYWRIGHT_WEB_PORT`, and `PLAYWRIGHT_STORAGE_STATE_PATH` values.
`pnpm db:reset` truncates learner state in the development database and reseeds the default learner.

`pnpm check` runs structure/import checks, Biome, TypeScript, curriculum validation and the
architecture checker's tests without PostgreSQL or provider credentials. `pnpm bootstrap` also
installs repository-local pre-commit checks; it leaves an existing custom hooks configuration intact.
Python lab tests require the dependencies in `labs/linreg-numpy/requirements.txt` and
`labs/nn-from-scratch/requirements.txt` in the `python3` environment used for testing.

Playwright uses the small fixture curriculum by default. Tests requiring authored lessons are
explicitly skipped in that mode; run a matching test with `PLAYWRIGHT_CONTENT_DIR=content`, for
example `PLAYWRIGHT_CONTENT_DIR=content pnpm test:e2e tests/e2e/final-question-repeat.spec.ts`.

The workspace separates `apps/web` (React/Vite) and `apps/api` (Hono). Shared API definitions live
in `packages/contracts`, pure common helpers in `packages/shared`, and product behavior in
feature folders. See [architecture](docs/architecture.md) and the scoped `AGENTS.md` files.

Inject runtime secrets through your secret manager before running commands. `.env.example`
documents environment variable names; do not put real secrets into tracked files or plaintext
`.env` files. API configuration validates injected values without printing them.

## Deployment

Set `ACADEMY_PASSWORD` as a deployment secret before starting the public app. Production startup
requires a password of at least 12 characters. The Ample service declares this secret in
`ample.toml`; configure its value through Ample's secret management, not in the repository.
Locally, leaving it unset disables login and prints a warning from `pnpm dev`.

The Vercel build validates the curriculum and serializes its indexed data beside the API bundle.
Cold functions load this artifact instead of parsing and validating every YAML file again.
Keep the Node 24 build and runtime versions aligned; curriculum changes require a new deployment.
