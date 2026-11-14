# Contributing

Bug reports, fixes and new course packs are all welcome.

## Setup

You need Node 24, pnpm 12.16.1 and Docker Compose. Install the Python lab dependencies
in a virtual environment before running tests:

```sh
python3 -m venv .venv
source .venv/bin/activate
python3 -m pip install -r labs/linreg-numpy/requirements.txt -r labs/nn-from-scratch/requirements.txt
```

```sh
pnpm bootstrap   # installs dependencies and the pre-commit hook
pnpm dev         # starts Postgres, the API on :3001 and the web app on :5173
```

## Before you open a pull request

```sh
pnpm check       # architecture rules, lint, types, content validation
pnpm test:unit   # unit tests, including the Python lab verifiers; no database
pnpm test        # API and unit tests (starts a test database)
pnpm test:e2e    # browser tests
pnpm build       # production builds
```

`pnpm check` needs no database or API keys. The end-to-end tests use a small fixture pack in `tests/fixtures/content` by default. Tests that need the full demo pack run with `PLAYWRIGHT_CONTENT_DIR=content`.

Install Chromium before your first browser run with `pnpm exec playwright install chromium`
(on Linux, use `pnpm exec playwright install --with-deps chromium`). Tests use `academy_test`
and clear its learner data. Use a dedicated `TEST_DATABASE_URL`; never point it at a database
whose contents you want to keep. `pnpm db:reset` clears the development database.

Keep secrets in injected environment variables; `.env.example` documents the supported names.
Do not include keys, learner exports or private source documents in issues and pull requests.

## Where things go

- Read the `AGENTS.md` in the folder you're changing. Each one is short and lists that area's rules.
- Web features live in `apps/web/src/features/<feature>`, and API features in `apps/api/src/features/<feature>`. Grading, mastery and scheduling rules are in `apps/api/src/learning`.
- Types shared between the web app and the API go in `packages/contracts`.
- Don't change an existing topic, lesson or question ID. Learner progress is keyed on them.
- Database changes need a migration: `pnpm db:generate`.

## Content

Changes to the demo pack in `content/` follow `.agents/skills/write-lesson/SKILL.md`. Every number in a lesson should be checked, and every code snippet should be run.
