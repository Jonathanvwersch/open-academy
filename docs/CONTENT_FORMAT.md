# Content format

All curriculum content lives in `content/` as YAML and is validated by `pnpm content:check`. Markdown fields (`md`, `prompt`, `solution`, `feedback`, hint strings) support GFM, KaTeX math (`$…$`, `$$…$$`) and fenced code blocks.

## content/curriculum.yaml
```yaml
schedule: { mon: 60, tue: 60, wed: 60, thu: 60, fri: 60, sat: 300, sun: 60 }   # default minutes
domains:
  - { id: math, title: Mathematics for ML, description: "..." }
courses: [ml-basics]
default_course: ml-basics
subject:
  title: Machine learning
  tutor_context: "The learner is a software engineer building their understanding of this subject."
grounded: false
goals:
  - { id: g-training, text: "Explain how modern ML models are trained", concepts: [gradient-descent, ...] }
```

`subject` and `grounded` are optional. When `grounded: true`, every authored lesson must cite at least one source listed in `sources/index.yaml`.

## content/courses/<course-id>.yaml
```yaml
id: ml-basics
title: Machine learning basics
description: "A first path through the subject."
units:
  - title: Foundations
    intro: "..."
    concepts: [vectors, gradient-descent]
    project: linreg-numpy
    papers: [attention-is-all-you-need]
    saturday: "Build a small model."
    sunday: "Review the week's ideas."
```

Each unit has a non-empty `title` and at least one concept. `intro`, `project`, `papers`, `saturday`, and `sunday` are optional.

## content/concepts/<domain>.yaml
```yaml
domain: math
concepts:
  - id: gradient-descent          # kebab-case, globally unique
    title: Gradient descent
    description: ...
    difficulty: 2                 # 1-5
    est_minutes: 35               # first-learning estimate
    goal_weight: 3                # 0-3 scheduling weight
    dimensions: [conceptual, math, implementation, transfer]   # which apply
    prereqs: [{ id: gradients }, { id: matrices, strength: soft }]   # strength default hard
    related: [other-id]           # optional
    objectives: [{ text: "...", dimension: math }]
    projects: [linreg-numpy]      # optional
    sources: [{ title: "...", url: "https://..." }]   # optional links
    status: authored | stub       # stub = graph node with placement probes only; no lesson or practice
```

`academy check` warns about prerequisite-free topics deep in a course, fully sequential courses with six or more topics,
and first-unit prerequisites that only appear in later courses in the same subject.
New CLI packs include common notation terms with empty `introduced_by`; add each teaching topic there before using that notation.

Stub concepts may have exercises only when `role: diagnostic`, and must not have a lesson file. These exercises can be used as placement probes. Stub concepts are not scheduled for lessons or practice until authored.

## content/lessons/<concept-id>.yaml  (required iff status: authored)
```yaml
concept: gradient-descent
version: 1
sources: [{ source: gradient-descent-notes, section: "Chapter 2" }]  # optional citations
blocks:                           # rendered in order
  - { kind: objective, md: "..." }
  - { kind: intuition, md: "..." }
  - { kind: example, md: "..." }
  - { kind: check, exercise: gd-check-lr }        # inline practice item
  - { kind: math, md: "..." }
  - { kind: worked, md: "..." }
  - { kind: faded, md: "...", exercise: gd-faded-step }   # partially worked; learner completes the exercise
  - { kind: summary, md: "..." }
fast_path: [objective, summary]   # kinds shown to learners with prior evidence (others collapsible)
```
Each citation's `source` must match an ID in `sources/index.yaml`; `section` is optional. Source files are not checked for existence.
After the blocks, the runner serves independent `core` exercises for the concept not already used in the lesson.

New lessons may use knowledge points instead of authored blocks:
```yaml
concept: supervised-learning
version: 3
objective: "What the learner will be able to do."
where_this_fits: |
  Explain how this lesson connects to what the learner already knows.
recap:
  - concept: vectors
    text: "A vector is a list of numbers that can represent a direction or a quantity."
knowledge_points:
  - id: sl-inputs-targets
    title: Inputs, targets and the model
    explain: "A short explanation."
    worked: "A worked example with the steps shown."
    problems: [slp-predict, slp-input-target, slp-parameters]
  - id: sl-measuring-error
    title: Measuring error
    explain: "..."
    worked: "..."
    problems: [slp-squared-error, slp-error-sum, slp-why-square]
summary: "..."
```
`recap` is optional. If present, include exactly one entry for every prerequisite that has an authored lesson. Each `concept` must be a prerequisite with an authored lesson, and its `text` must state one fact in at most 40 words. The lesson shows each prerequisite as a link with its recap; without this field, it shows the usual “Before this” links instead. When a recap is present, `where_this_fits` is rendered as plain lesson prose below the Recap card.

Knowledge-point lessons have 1–4 steps, as many as the topic needs. The first problem in each step is the concept multiple-choice question, marked `role: basics` in content but labelled like every other question.

Knowledge-point IDs are globally unique. Each point needs at least 5 practice problems across difficulties 1–3, with at least one fixed problem. A parameterised template may provide fresh values when fixed items are exhausted. These questions supply both step practice and the lesson quiz. The loader derives legacy-compatible objective, intuition, worked, check, and summary blocks; each check uses the point's first fixed problem.

## content/exercises/<concept-id>.yaml
```yaml
concept: gradient-descent
exercises:
  - id: gd-step-numeric           # globally unique
    dimension: math               # conceptual | math | implementation | transfer
    type: numeric                 # see below
    role: core                    # core | transfer | review | diagnostic | check | practice
    difficulty: 2
    est_minutes: 3
    prompt: "..."
    hints: ["L1 general", "L2 principle", "L3 intermediate step", "L4 partial solution"]  # 0-4 authored; L5 = solution
    solution: "full worked explanation shown after submission"
    # type-specific fields:
```
Type-specific fields:
- `mc`: `options: [{ id, text, correct: bool, feedback?, category? }]`, `multi?: bool` (default single).
- `numeric`: `answer: number`, `tolerance: { abs?: number, rel?: number }` (default abs 1e-6), `common_wrong?: [{ answer, tolerance?, category, feedback }]`.
- Numeric practice exercises may be parameterised. A template has parameter ranges, optional constraints, and an `answer_expr` instead of `answer`:
  ```yaml
  params:
    w: { min: 1, max: 5, step: 1 } # step defaults to 1
    x: { min: 50, max: 150, step: 10 }
  constraints: ["w * x != 100"]    # mathjs boolean expressions over the parameters
  answer_expr: "w * x + 20"
  common_wrong:
    - { answer_expr: "w * x", category: math_error, feedback: "..." }
  ```
  Exactly one of `answer` and `answer_expr` is required; `answer_expr` requires `params`. Text fields may use `{{= expression }}` to show a sampled calculation. Templates must have role `practice` and be referenced by one knowledge point.
- `expression`: `answer: "2*w*x - 2*x*y"` (mathjs syntax), `variables: { w: [-3, 3], x: [-3, 3] }` (sample ranges), `common_wrong?: [{ answer, category, feedback }]`. Learner may type `^`, `*`, implicit multiplication is allowed by mathjs.
- `text`: `accept: ["..."]` (compared case/whitespace-normalized), `regex?: "..."`.
- `code_read`: `code: "..."` (python), plus either numeric fields (`answer`, `tolerance`) or text fields (`accept`).
- `code_complete`: `code: "... ____ ..."` (one blank), `accept: ["..."]` (whitespace-insensitive, `'`≡`"`).
- `debug`: `code: "..."`, `buggy_line: 3` (1-based), `fix_options: [{ id, text, correct, feedback? }]`. Full credit = line and fix correct; line only = 0.5.
- `explain`: `rubric: [{ id, criterion, weight, required?: bool }]`, `exemplar: "..."`.

`category` / mistake categories: missing_prerequisite | misunderstood_definition | math_error | incorrect_reasoning | implementation_error | misapplied_technique | recall_failure | incomplete_explanation.

Knowledge-point lessons require a `final` exercise ID. It is the "Explain it" self-check before
the quiz: the learner sees the model answer and marks their own work, so it is not part of the
quiz score. It must identify a core `explain` exercise for the same concept and must not appear
in any knowledge point's `problems`. The loader adds this exercise as the final check block,
after the knowledge points and before the summary. See the
[write-lesson skill](../.agents/skills/write-lesson/SKILL.md) for authoring guidance.

Fenced `svg` blocks in lesson and exercise Markdown render as accessible diagrams. Each SVG
must be well-formed XML with an `<svg>` root, a `viewBox`, and a non-empty `aria-label`.
Scripts, `foreignObject`, event-handler attributes, and external `href` references are
forbidden; colors must be literal hexadecimal values.

## content/sources/index.yaml
```yaml
sources:
  - id: gradient-descent-notes
    title: Gradient descent notes
    file: gradient-descent.pdf
    kind: pdf
    added: 2026-11-14
```
The `sources` list may be empty. Each entry has an ID, title, and local filename; `kind` is optional and may be `pdf`, `notes`, `book`, `paper`, `slides`, or `other`. `added` is an optional `YYYY-MM-DD` date. The local file itself is not validated.

Lessons may cite these source IDs with an optional section. `grounded: true` in the curriculum requires each authored lesson to have at least one citation.

## content/projects/<project-id>.yaml
```yaml
id: linreg-numpy
title: ...
status: authored | stub
est_hours: 4
objective: "..."
background: "..."            # markdown
prereqs: [linear-regression, gradient-descent]
tasks: [{ id, title, md }]
acceptance: ["..."]
tests:                       # maps verifier test ids -> evidence
  - { id: test_predict, concepts: [linear-regression], dimension: implementation }
metrics: [{ id: val_mse, label: "Validation MSE", threshold: 0.3, direction: below }]
reflection: [ex-id, ...]     # exercise ids asked after submission
follow_up: ["..."]
```
Metrics use strict `above` or `below` comparisons by default. Set `inclusive: true` on a
metric when equality should pass, for example an accuracy requirement of at least 90%.

Lab code lives in `labs/<project-id>/` (starter/, tests/, README.md); `labs/verify.py <project-id>` writes `labs/<project-id>/work/results.json`:
`{ "project": id, "version": 1, "tests": [{ "id", "passed", "message" }], "metrics": { id: number }, "generated_at": iso }`.

## content/papers/<paper-id>.yaml
```yaml
id: attention-is-all-you-need
title: "Attention Is All You Need"
authors: "Vaswani et al."
year: 2017
est_minutes: 90
source: { arxiv: "1706.03762v7" } # or { url: "https://arxiv.org/pdf/1706.03762.pdf" }
concepts: [attention, transformer-block]
why_this_week: "..."
how_to_read: "..."
questions:
  - { id: claim, kind: claim, prompt: "..." }
  - { id: method, kind: method, prompt: "..." }
  - { id: evidence, kind: evidence, prompt: "..." }
  - { id: limitations, kind: limitations, prompt: "..." }
summary:
  prompt: "..."
  rubric:
    - { id: contribution, criterion: "...", weight: 1, required: true }
    - { id: evidence, criterion: "...", weight: 1, required: false }
    - { id: limitation, criterion: "...", weight: 1, required: false }
  exemplar: "..."
```
Paper IDs and concepts must exist, and each paper must be assigned to at least one course unit. A paper can appear in several units. Each paper has exactly one question of each kind. URLs must be HTTPS PDFs hosted on `arxiv.org`, `homes.cs.washington.edu`, `proceedings.neurips.cc` or `people.math.harvard.edu`; arXiv identifiers include a version suffix. The PDF fetcher checks the host of every redirect and requires a PDF content type and PDF bytes. Summary rubrics contain 3–5 uniquely identified criteria.
