# Academy

Local starter for a single-user adaptive learning app. Requires Node 24, pnpm, and Docker Compose.

```sh
pnpm install
cp .env.example .env
pnpm dev
```

`pnpm dev` starts PostgreSQL on port 5433, waits for it to become ready, applies migrations, seeds the default user, and starts the API on port 3001 and web app on port 5173. The web server proxies `/api` requests to the API.

Useful commands:

```sh
pnpm db:generate
pnpm db:migrate
pnpm db:seed
pnpm db:reset
pnpm test
pnpm test:e2e
pnpm typecheck
pnpm lint
pnpm format
pnpm build
```

Vitest uses the separate `academy_test` database. `pnpm test:e2e` starts the local dev stack through Playwright's web server configuration.
`pnpm db:reset` truncates learner state in the development database and reseeds the default learner.

## Deployment

Set `ACADEMY_PASSWORD` as a deployment secret before starting the public app. Production startup
requires a password of at least 12 characters. The Ample service declares this secret in
`ample.toml`; configure its value through Ample's secret management, not in the repository.
Locally, leaving it unset disables login and prints a warning from `pnpm dev`.
