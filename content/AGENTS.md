# Authored curriculum

- Write and rewrite lessons with `../.agents/skills/write-lesson/SKILL.md`; `lessons/gradient-descent.yaml` is the model lesson.
- Keep authored content here and executable learner projects in `../labs/<project-id>`.
- Preserve stable concept, lesson, exercise and project IDs; learner progress and prerequisites depend on them.
- From the root run `pnpm content:check` and relevant tests (`pnpm exec vitest run apps/api/tests/content/`). Use `pnpm test` for database-backed learning behavior and `pnpm test:e2e` for journeys.
