# Contributing

Bug reports, fixes and new course packs are all welcome.

## Setup

You need Node 24, pnpm and Docker.

```sh
pnpm bootstrap   # installs dependencies and the pre-commit hook
pnpm dev         # starts Postgres, the API on :3001 and the web app on :5173
```

## Before you open a pull request

```sh
pnpm check       # architecture rules, lint, types, content validation
pnpm test        # API and unit tests (starts a test database)
pnpm test:e2e    # browser tests
```

`pnpm check` needs no database or API keys. The end-to-end tests use a small fixture pack in `tests/fixtures/content` by default. Tests that need the full demo pack run with `PLAYWRIGHT_CONTENT_DIR=content`.

## Where things go

- Read the `AGENTS.md` in the folder you're changing. Each one is short and lists that area's rules.
- Web features live in `apps/web/src/features/<feature>`, and API features in `apps/api/src/features/<feature>`. Grading, mastery and scheduling rules are in `apps/api/src/learning`.
- Types shared between the web app and the API go in `packages/contracts`.
- Don't change an existing topic, lesson or question ID. Learner progress is keyed on them.
- Database changes need a migration: `pnpm db:generate`.

## Content

Changes to the demo pack in `content/` follow `.agents/skills/write-lesson/SKILL.md`. Every number in a lesson should be checked, and every code snippet should be run.
