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
- After a topic's questions are done, use `.agents/skills/set-weights/SKILL.md` to set its encompassing weights and have a separate agent check them before the course ships.
- When the pack has sources, write from them with `.agents/skills/write-from-sources/SKILL.md` and cite them.
- Run `academy check` after every change and fix every issue it reports before you stop.
- Install the CLI once with `npm i -D @open-academy/engine` in this folder, then run `npx academy check`.
- Use the CLI to create files (`academy new topic`, `academy new lesson`, `academy new course`, `academy sources add`) so IDs and file layout stay consistent.

The reference lesson, its questions, and the format docs are in `.agents/skills/write-lesson/reference/`.
