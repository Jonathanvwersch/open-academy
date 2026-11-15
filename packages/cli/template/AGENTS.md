# Course pack

This folder is an Open Academy course pack: one subject, its topic graph, lessons, questions and courses.

- `curriculum.yaml` names the pack-level subject, domains, ordered subjects, courses and the default course.
- `concepts/<domain>.yaml` lists topics. Each topic has a stable `id`, a title, `requires` (hard prerequisites) and `status: stub` until its lesson is written.
- `lessons/<topic>.yaml` is the lesson for a topic; `exercises/<topic>.yaml` holds its questions.
- `courses/<id>.yaml` is an ordered path through the topics, split into units.
- `sources/` holds the learner's own material (notes, papers, chapters). `sources/index.yaml` lists it; the files themselves are not committed.

Rules:
- Never change an existing `id`. Learner progress is keyed on it.
- With `curriculum.subjects`, every course must set `subject` to a listed subject ID.
- Plan the graph before writing lessons: `.agents/skills/plan-course/SKILL.md`.
- Write every lesson with `.agents/skills/write-lesson/SKILL.md`.
- Write and check every question with `.agents/skills/write-questions/SKILL.md`.
- When the pack has sources, write from them with `.agents/skills/write-from-sources/SKILL.md` and cite them.
- Run `academy check` after every change and fix every issue it reports before you stop.
- Use the CLI to create files (`academy new topic`, `academy new lesson`, `academy new course`, `academy sources add`) so IDs and file layout stay consistent.

The write-lesson skill was written for the demo pack inside the Open Academy repo. When it says `content/...`, read that as this folder (`content/concepts/` is `concepts/`, `content/notation.yaml` is `notation.yaml`). Its reference lesson is copied beside it: `.agents/skills/write-lesson/reference/lesson.yaml` and `reference/exercises.yaml`. For `docs/CONTENT_FORMAT.md` and `docs/design/lesson-standard.md`, see the copies in `.agents/skills/write-lesson/reference/`. These references also apply to the write-questions skill: its `../write-lesson/SKILL.md` and `docs/CONTENT_FORMAT.md` references mean `.agents/skills/write-lesson/SKILL.md` and `.agents/skills/write-lesson/reference/CONTENT_FORMAT.md` in a pack. Instead of `pnpm content:check` and the content tests, run `academy check`.
