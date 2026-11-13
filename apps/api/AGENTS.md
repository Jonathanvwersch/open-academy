# Academy API

- Hono + PostgreSQL/Drizzle. `src/app.ts` and `src/http/routes.ts` compose features and dependencies.
- Route modules decode HTTP and map responses. New services accept plain domain inputs, not Hono contexts. `features/projects/routes.ts` and `service.ts` show the boundary.
- `src/learning` owns shared mastery, scheduling and grading rules. `src/content` loads/validates curriculum. Keep provider calls and persistence out of pure grading/mastery functions.
- Schema: `src/db/schema.ts`; migrations: `drizzle/`. Do not rename migrations or regenerate history during refactors.
- Validate runtime environment in `src/config.ts`. Document required secret names only; never log credentials.
- Resolve bundled prompts beside their module. Use `repositoryPath` for root-owned content, fixtures and built web assets; preserve explicit absolute paths. Commands must work from the root and via app filters.
- Integration tests live in `tests/<feature>`; unit tests can sit beside pure functions. Root fixtures are shared with E2E. Use fake/E2E tutor providers; real provider calls require explicit authorization.
- From the root: `pnpm content:check`, `pnpm test`, `pnpm test:e2e`, `pnpm check`, `pnpm build`. Focus a suite with `pnpm exec vitest run apps/api/tests/<feature>/<file>.test.ts`.
- API-only database runners live in `scripts/` here. Preserve production startup migration behavior.
