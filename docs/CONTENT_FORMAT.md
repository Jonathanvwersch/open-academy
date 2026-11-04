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
    status: authored | stub       # stub = graph node only, no lesson yet
```

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

## content/exercises/<concept-id>.yaml
```yaml
concept: gradient-descent
exercises:
  - id: gd-step-numeric           # globally unique
    dimension: math               # conceptual | math | implementation | transfer
    type: numeric                 # see below
    role: core                    # core | transfer | review | diagnostic | check
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
- `expression`: `answer: "2*w*x - 2*x*y"` (mathjs syntax), `variables: { w: [-3, 3], x: [-3, 3] }` (sample ranges), `common_wrong?: [{ answer, category, feedback }]`. Learner may type `^`, `*`, implicit multiplication is allowed by mathjs.
- `text`: `accept: ["..."]` (compared case/whitespace-normalized), `regex?: "..."`.
- `code_read`: `code: "..."` (python), plus either numeric fields (`answer`, `tolerance`) or text fields (`accept`).
- `code_complete`: `code: "... ____ ..."` (one blank), `accept: ["..."]` (whitespace-insensitive, `'`≡`"`).
- `debug`: `code: "..."`, `buggy_line: 3` (1-based), `fix_options: [{ id, text, correct, feedback? }]`. Full credit = line and fix correct; line only = 0.5.
- `explain`: `rubric: [{ id, criterion, weight, required?: bool }]`, `exemplar: "..."`.

`category` / mistake categories: missing_prerequisite | misunderstood_definition | math_error | incorrect_reasoning | implementation_error | misapplied_technique | recall_failure | incomplete_explanation.

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
