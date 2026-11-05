# Content format

All curriculum content lives in `content/` as YAML and is validated by `pnpm content:check`. Markdown fields (`md`, `prompt`, `solution`, `feedback`, hint strings) support GFM, KaTeX math (`$…$`, `$$…$$`) and fenced code blocks.

## content/curriculum.yaml
```yaml
schedule: { mon: 60, tue: 60, wed: 60, thu: 60, fri: 60, sat: 300, sun: 60 }   # default minutes
domains:
  - { id: math, title: Mathematics for ML, description: "..." }
weeks:
  - { week: 1, title: ML fundamentals, concepts: [vectors, ...], project: linreg-numpy }
goals:                     # the 13 90-day outcomes
  - { id: g-training, text: "Explain how modern ML models are trained", concepts: [gradient-descent, ...] }
```

## content/concepts/<domain>.yaml
```yaml
domain: math
concepts:
  - id: gradient-descent          # kebab-case, globally unique
    title: Gradient descent
    description: ...
    difficulty: 2                 # 1-5
    est_minutes: 35               # first-learning estimate
    week: 1                       # default curriculum week
    goal_weight: 3                # 0-3 centrality to 90-day outcomes
    dimensions: [conceptual, math, implementation, transfer]   # which apply
    prereqs: [{ id: gradients }, { id: matrices, strength: soft }]   # strength default hard
    related: [other-id]           # optional
    objectives: [{ text: "...", dimension: math }]
    projects: [linreg-numpy]      # optional
    sources: [{ title: "...", url: "..." }]   # optional
    status: authored | stub       # stub = graph node with diagnostic probes only; no lesson or practice
```

Stub concepts may have exercises only when `role: diagnostic`, and must not have a lesson file. Diagnostic probes on stubs update mastery normally, but stubs are not scheduled for lessons or practice until authored.

## content/lessons/<concept-id>.yaml  (required iff status: authored)
```yaml
concept: gradient-descent
version: 1
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
After the blocks, the runner serves independent `core` exercises for the concept not already used in the lesson.

New lessons may use knowledge points instead of authored blocks:
```yaml
concept: supervised-learning
version: 3
objective: "What the learner will be able to do."
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
Knowledge-point IDs are globally unique. Each point needs 3 or more practice problems, at least one fixed problem, and either 5 fixed problems or a parameterised template. The loader derives legacy-compatible objective, intuition, worked, check, and summary blocks; each check uses the point's first fixed problem.

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

Knowledge-point lessons require a `final` exercise ID. It must identify a core `explain`
exercise for the same concept and must not appear in any knowledge point's `problems`. The
loader adds this exercise as the final check block, after the knowledge points and before the
summary. See the [lesson style guide](LESSON_STYLE.md) for authoring guidance.

Fenced `svg` blocks in lesson and exercise Markdown render as accessible diagrams. Each SVG
must be well-formed XML with an `<svg>` root, a `viewBox`, and a non-empty `aria-label`.
Scripts, `foreignObject`, event-handler attributes, and external `href` references are
forbidden; colors must be literal hexadecimal values.

## content/diagnostic.yaml
```yaml
domains:
  - domain: math
    ladder: [dx-math-1, dx-math-2, dx-math-3, dx-math-4]   # exercise ids, easiest -> hardest
    start: 1                                               # starting index
```
Ladder exercises are ordinary exercises (role: diagnostic) in their concept's exercise file. The concept and dimension of the evidence come from the exercise.

## content/projects/<project-id>.yaml
```yaml
id: linreg-numpy
title: ...
week: 1
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
Lab code lives in `labs/<project-id>/` (starter/, tests/, README.md); `labs/verify.py <project-id>` writes `labs/<project-id>/work/results.json`:
`{ "project": id, "version": 1, "tests": [{ "id", "passed", "message" }], "metrics": { id: number }, "generated_at": iso }`.
