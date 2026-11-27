# Ownership and local checks

Open Academy uses pnpm workspaces. Applications live in `apps`, and reusable libraries in
`packages`. The learner frontend is `apps/web`; the Hono backend is `apps/api`. Authored curriculum
and learner Python projects stay in `content` and `labs`.

Frontend routes describe URLs and loaders; features own pages, queries, mutations and local tests.
The app layer composes features. Generic UI and transport helpers stay below features. Backend
routes decode HTTP and invoke services; the learning engine owns common grading, mastery and
scheduling rules. Browser-safe API types live in `packages/aesop/src/api`; pure shared behavior
lives in shared. Package
exports and declared workspace dependencies define the public boundary.

`pnpm check` runs architecture checks, Biome, workspace types, curriculum validation and the
checker and tooling tests, without a database or provider keys. `pnpm test:unit` runs database-free
suites; `pnpm test` also starts PostgreSQL and runs API integration suites. Playwright journeys and
shared cross-app fixtures remain under root `tests/e2e` and `tests/fixtures`.

`pnpm bootstrap` installs dependencies and configures this checkout's Git hooks. The pre-commit
hook runs architecture and lint checks without rewriting the working tree or index. Hooks remain
bypassable; agents must run checks and relevant tests before handoff. GitHub Actions runs the
checks, unit and API suites, production build, and browser journeys on pushes and pull requests.

`scripts/architecture/policy.mjs` lists public feature modules and deployment exceptions. The
checker resolves imports, aliases, re-exports, dynamic imports and type imports, rejecting cycles
and relative paths that bypass package exports. Keep exceptions narrow and explained. Semantic
decisions about feature cohesion still require review.

Root commands remain the entry point for development and deployment. Migrations and database
runners belong to the API. Root `api/index.ts` is only a Vercel adapter; production serves
`apps/web/dist`. Prompts resolve beside their provider; root-owned assets use `repositoryPath`
instead of the caller's working directory.
