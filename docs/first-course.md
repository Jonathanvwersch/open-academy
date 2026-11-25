# Writing your first course

This guide makes a small course pack, adds one lesson, and runs it. It takes about half an hour by hand, or a few minutes if an agent does the writing.

## 1. Create a pack

```sh
pnpm academy init ~/courses/organic-chemistry --title "Organic chemistry"
```

This creates a folder with one course, one placeholder topic, an `AGENTS.md` and the agent skills. Check that it's valid and open it in the app:

```sh
pnpm academy check ~/courses/organic-chemistry
pnpm academy dev ~/courses/organic-chemistry
```

Run `pnpm academy` from the Open Academy checkout. Commands that change a pack take `--pack <folder>`; the examples below use `P=~/courses/organic-chemistry`.

## 2. Plan the topics

A topic is one idea you can teach in 10-20 minutes and test with a few questions. Each topic lists the topics it needs first. Before you write any lessons, work out the topics and the order they go in. The lessons are easy to rewrite later, but a wrong graph is much harder to fix.

```sh
P=~/courses/organic-chemistry
pnpm academy new topic functional-groups --pack $P --title "Functional groups" --course organic-chemistry-basics --unit 1
pnpm academy new topic alkanes --pack $P --title "Alkanes" --requires functional-groups --course organic-chemistry-basics --unit 1
```

`academy new course` adds another course and its units. Run `academy check` after each change.

## 3. Add your sources (optional)

If you're following a university course or a textbook, add the material so lessons can be written from it:

```sh
pnpm academy sources add ~/Downloads/lecture-3.pdf --pack $P --title "Lecture 3: Alkanes"
pnpm academy sources list --pack $P
```

Files are copied into `sources/`, which is ignored by git, and listed in `sources/index.yaml`. A lesson lists the sources it was written from:

```yaml
sources:
  - { source: lecture-3, section: "Slides 4-12" }
```

Set `grounded: true` in `curriculum.yaml`, and `academy check` will then fail on any lesson that doesn't cite a source.

## 4. Write a lesson

```sh
pnpm academy new lesson functional-groups --pack $P
```

This writes a lesson file and a question file with `TODO`s in them. `academy check` lists each `TODO` until it's filled in. A lesson is a short recap, a definition, a few steps that each have an explanation, a worked example and questions, and then a quiz. `.agents/skills/write-lesson/SKILL.md` describes the format and the house style in full. [Content format](CONTENT_FORMAT.md) lists every field.

## 5. Or let an agent write it

Open the pack folder in Claude Code, Codex, or any agent that can run shell commands, and describe what you want:

> Plan a 15-topic introduction to organic chemistry for a first-year student, using the lecture notes in sources/. Show me the plan, then write the lessons for unit 1.

The agent reads `AGENTS.md` and follows the skills that come with the pack: `plan-course`, `write-lesson`, `write-questions`, `set-weights` and `write-from-sources`. It creates files with the CLI and runs `academy check` until everything passes. Check the topic plan before it starts writing lessons, and spot-check the maths in what it writes.

After each topic's questions are done, use `.agents/skills/set-weights/SKILL.md` to score how much they practise each prerequisite. A separate agent or session works out its own scores before comparing with the writer. Once the two passes agree on which steps each question uses, record the weights. Before shipping, combine the reviewed uses files for the whole pack and verify them:

```sh
pnpm academy weights verify "$P/uses.yaml" --pack "$P"
```

## 6. Use it

Restart `academy dev` after editing content, start your course from the Courses page, and take the placement check or start from the beginning. To host it, see [Self-hosting](self-hosting.md).
