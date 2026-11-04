# Academy

- Node 24, pnpm, TypeScript strict, ESM; one package, no workspaces.
- `pnpm dev` starts PostgreSQL, migrates/seeds, then runs API and web.
- `pnpm test` runs the Vitest server test against `academy_test`.
- `pnpm test:e2e` runs the Chromium Playwright smoke test.
- `pnpm typecheck`, `pnpm lint`, `pnpm format`, and `pnpm build` are standard checks.
- Database schema: `src/server/db/schema.ts`; migrations: `drizzle/`.
- `pnpm db:reset` clears development learner state and reseeds the default user.
- API: `src/server/`; shared contracts: `src/shared/`.
- Web routes and styles: `src/web/routes/` and `src/web/styles.css`.
- E2E tests: `tests/e2e/`; local seed: `scripts/seed.ts`.
