# Open Academy

- Node 24, pnpm 12.16.1, strict TypeScript and ESM. Run workspace commands from this root.
- `apps/web` is the React/Vite learner app; `apps/api` is the Hono API. Read the owning app's `AGENTS.md` before editing it.
- `packages/aesop` owns browser-safe API shapes and the pure content and learning engine; `packages/shared` owns small cross-app helpers. Import explicit `@academy/<package>/<module>` exports, never another package's source path.
- Put components, queries, mutations, fixtures and detailed docs with their owning feature. `apps/web/src/features/lessons` is the frontend example. API use cases accept plain inputs; Hono stays in route modules.
- Shared UI/helpers cannot import features. Features cannot import web routes or app composition. Cross-feature imports use public modules listed in `scripts/architecture/policy.mjs`; keep dependencies acyclic.
- Use kebab-case for new folders and files. Preserve tool-required names (`AGENTS.md`, TanStack file routes/generated files), existing migration identifiers and Python snake_case.
- Add shared abstractions only when existing consumers need them. Do not recreate global `components.tsx`/`queries.ts` files or add empty layers.
- `pnpm bootstrap` installs locked dependencies and repository-local Git hooks; it preserves an existing custom hooks path.
- Before handoff, run `pnpm check` and relevant tests; report failures or unavailable prerequisites. `pnpm check` checks architecture, Biome, types, curriculum and the checker itself without Docker or API keys.
- `pnpm test:unit` needs no PostgreSQL. `pnpm test` starts local PostgreSQL and runs all Vitest suites. `pnpm test:e2e` runs Playwright; `pnpm build` builds both apps.
- `pnpm dev` starts PostgreSQL, migrates/seeds, then starts API and web. `pnpm db:reset` clears development learner state: use only when the task requires a reset.
- Root `scripts/` is cross-workspace tooling; API-owned runners live in `apps/api/scripts`. Root `api/index.ts` is only the Vercel adapter.
- Secrets come from injected environment variables, validated at their owner. Never commit secrets, put real values in plaintext `.env` files, or print them. Document names only.
- Read `content/AGENTS.md` before changing curriculum. Preserve grading, mastery progression, URLs and query keys during structural work.
- Suppressions and architecture exceptions need a narrow scope and a concrete reason. Fix violations rather than disabling checks; test checker changes against valid and invalid fixtures.
