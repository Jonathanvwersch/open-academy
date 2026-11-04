# Academy — Technical Plan

Status: living document. Sections marked **[research]** rest on established learning-science evidence; **[hypothesis]** marks engineering or educational design choices that are reasonable guesses, not proven optima. Every number in this document (weights, thresholds, minute budgets) is an initial heuristic meant to be tuned from real usage data.

---

## 1. Executive summary

Academy is a single-user, adaptive learning platform for ML, AI and robotics. It is built around a curated prerequisite graph of ~85 concepts and a deterministic, explainable scheduler. Each day it produces a time-boxed session (60 min on weekdays, 5 h of lab on Saturday, 60 min of cumulative review on Sunday) made of reviews, new concepts, practice and remediation. Every recommendation records the reason it was chosen.

Learning state is built only from graded evidence. Exercises are graded deterministically wherever possible (multiple choice, numeric with tolerance, expression equivalence by random-point evaluation, normalized text match, debugging line identification). Open explanations are graded by an LLM against an explicit rubric, and that grade alone can never establish independent mastery. Mastery is tracked per concept *and* per competency dimension (conceptual / mathematical / implementation / transfer), as ordinal states rather than fake probabilities. Assisted answers (hints, second tries) earn less credit than independent ones. FSRS (ts-fsrs) schedules review of each dimension the learner has demonstrated.

An LLM tutor (Anthropic, configurable model) explains, gives escalating hints and diagnoses misconceptions. It uses versioned prompts, zod-validated structured outputs, a usage log and daily budgets. It never writes learner state: business rules, grading, mastery and scheduling are plain code.

Labs run in the learner's own IDE against starter code in the repo. A local `verify` script runs the tests and writes `results.json`, which the learner uploads. The server never executes learner code.

Stack: TypeScript, React 19, TanStack Router + Query, Tailwind v4, Hono on Node 24, PostgreSQL 16 via Drizzle, Python 3.12 (uv) for labs and content validation. One deployable app with no microservices.

## 2. Product scope

**MVP (this build):**
- Concept graph covering all 10 domains (~85 concepts, metadata, prerequisites, week mapping, goal weights).
- Fully authored lessons and exercises for the Week 1–2 core (linear algebra → gradient descent → neural networks → backprop), about 15 concepts.
- Diagnostic probe items across 8 domains.
- Adaptive diagnostic, Today screen, session runner, lessons, practice and assessment modes, grading, hints, mastery, FSRS reviews, scheduler with reasons, remediation.
- Tutor (feedback, hints beyond authored ones, explanation grading, practice chat).
- Lab: the Week 1 project (NumPy linear regression with loss/parameter visualization), with starter code, tests, verifier and upload.
- Knowledge Map (filtered by domain), Progress (competencies, assessments, retention, learning debt, time), Saturday and Sunday session templates, weekly plan.
- Content validation CLI plus tests; a Python check of reference solutions.

**Deferred (explicit):**
- In-browser Python execution (Pyodide) for code exercises.
- Isolated server-side code sandbox.
- Robotics simulation exercises.
- Paper-reading exercise type.
- Lessons for Weeks 3–12 (the graph and stubs exist, the full content does not).
- Day-30/60/90 checkpoint forms (the schema supports them; only Day 1 is built).
- Auth beyond a single optional password.
- Deployment.
- LLM-generated questions.

## 3. User journeys

1. **First open:** a welcome screen offers the diagnostic (~25 adaptive items, about 30 min, resumable, any domain can be marked "never studied"). The results page shows strengths, gaps, inferred prerequisites, coverage per domain with confidence, top priorities, a first-week plan and a "Start first session" button.
2. **Weekday:** Today shows the planned 60 min split into blocks (reviews / new concept / practice / consolidation), each with a one-line reason. Start → the session runner steps through activities, autosaving after each step. Closing the tab and coming back resumes at the same step.
3. **Learning a concept:** objective → intuition → example → check question → maths → worked example → faded example → independent problems. Learners already familiar with the concept get a fast path: objective, a skippable summary, then straight to problems.
4. **Stuck:** hints L1→L5 (authored first, tutor after). Each hint reduces credit. "Explain my mistake" calls the tutor after submission.
5. **Saturday:** Today becomes the Lab: project brief, tasks, local workflow instructions, then upload `results.json`, reflection questions and evidence updates.
6. **Sunday:** cumulative independent check (interleaved, no hints), targeted remediation, a "teach-back" explanation of the week's key concept, then the progress review and next week's plan.
7. **Override:** from the Map, "Study this now" starts a practice session on any concept. Viewing an advanced concept never credits its prerequisites.

## 4. Educational design

| Mechanism | How Academy uses it | Evidence |
|---|---|---|
| Retrieval practice | Reviews are recall/production items (numeric, expression, explanation), not re-reading | **[research]** Roediger & Karpicke 2006; Dunlosky et al. 2013; Adesope et al. 2017 meta-analysis |
| Spacing | FSRS schedules per concept-dimension card | **[research]** Cepeda et al. 2006 meta-analysis; FSRS algorithm (Ye et al., open-spaced-repetition) |
| Worked examples → fading | Lesson block order: worked → faded → independent; skipped when prior evidence shows familiarity (expertise reversal) | **[research]** Sweller & Cooper 1985; Renkl & Atkinson 2003; Kalyuga et al. 2003 |
| Active problem solving | Most session minutes go to problems and labs | **[research]** Freeman et al. 2014 (PNAS) |
| Interleaving | Only for concepts already at *assisted* or above: Sunday checks and review queues mix concepts | **[research]** Rohrer & Taylor 2007; Brunmair & Richter 2019 (the effect depends on the material) |
| Self-explanation | `explain` items and a teach-back step at the end of the session | **[research]** Chi et al. 1994; Bisra et al. 2018 |
| Corrective feedback | Per-option and per-misconception feedback after submission; withheld during assessment until submit | **[research]** Hattie & Timperley 2007; Shute 2008 |
| Transfer checks | `transfer`-role items in novel contexts; required for the top state | **[research]** Barnett & Ceci 2002 (transfer is hard and has to be tested directly) |
| Mastery learning on a prerequisite graph | Advance once prerequisites are demonstrated; remediate prerequisites when the learner keeps failing | **[research]** Bloom 1984; Kulik et al. 1990. Graph-based frontier selection, as in Math Academy, is **[hypothesis]** |
| Session splits, weights, thresholds, 90-day path | — | **[hypothesis]** |

## 5. Knowledge graph design

- The graph is version-controlled YAML in `content/`, validated at load time and in CI. Content is *not* copied into the DB. The DB stores learner state keyed by content IDs plus the content version (a hash of the item's source) of every graded item, so attempts stay attributable after edits. Tradeoff: no admin UI or editing in the DB, but the content stays simple to diff and review. That is the right choice for one author/learner.
- `content/curriculum.yaml` holds domains, the 12 weeks (concept IDs, project ID, Saturday/Sunday notes) and the 13 goal outcomes. Each goal outcome lists the concept IDs it depends on.
- `content/concepts/<domain>.yaml` holds the concept list: `id`, `title`, `domain`, `description`, `difficulty` (1–5), `est_minutes`, `prereqs: [{id, strength: hard|soft}]`, `related`, `objectives: [{text, dimension}]`, `dimensions` (which of conceptual/math/implementation/transfer apply), `week`, `goal_weight` (0–3: how central to the 90-day outcomes), `sources`, `projects`, `status: authored|stub`.
- `content/lessons/<concept-id>.yaml` holds the lesson: `version`, ordered `blocks` (`objective | intuition | example | check | math | worked | faded | summary`), Markdown with KaTeX, and `check` blocks that reference exercise IDs.
- `content/exercises/<concept-id>.yaml` holds the exercises (schema in §10).
- `content/diagnostic.yaml` holds the per-domain probe ladders.
- Only `hard` prerequisites gate readiness; `soft` ones are shown on the map. Concepts are kept small enough to assess with a few items (e.g. "chain rule", "computational graphs" and "backpropagation" are separate concepts).

## 6. Diagnostic design  **[hypothesis: deterministic heuristic, no IRT]**

- Each of the 8 domains has a probe ladder of 3–5 items with increasing difficulty, each tied to one concept. Item types are mixed (numeric, expression, MC, code reading, debugging, a short explanation).
- Per domain: start at the middle rung. If the answer is correct, step up; if wrong, step down to the item's prerequisite rung. Stop after 3 answers, or when stepping off either end. The learner may tap "I've never studied this", which marks the domain unassessed (not failed) and ends it. Target: 20–35 items in total. Domains are interleaved; state is persisted after every answer, so the run can be paused and resumed.
- Everything is graded independently (no hints, no feedback until the end).
- Evidence written:
  - Correct → independent evidence on that concept-dimension, flagged `source=diagnostic`.
  - Wrong → a failed attempt, and the concept is flagged as a gap.
  - The *hard* prerequisites of a correctly answered concept are marked **inferred**. Inferred prerequisites satisfy readiness gates but still show as unverified, and are confirmed later by interleaved quick checks.
- Honesty: one diagnostic success yields `independent (provisional)`, never deep understanding. The results page shows confidence as "1 item" or "3 items", not as a percentage.
- The output shows strengths, gaps, inferred-but-unverified concepts, coverage per domain (assessed / inferred / gap / unassessed), the top 5 priorities with reasons, a 7-day projection from the scheduler, and the next lesson.

## 7. Adaptive scheduler algorithm  **[hypothesis; deterministic, tested, replaceable]**

Pure function: `planSession(state, content, now, budgetMinutes, kind) → { activities[], reasons[] }`. `state` contains mastery, cards, recent attempts, project progress, time estimates and start date. `kind` is one of `weekday | saturday | sunday | custom`.

**Candidate generation**
- *Reviews:* FSRS cards due by the end of today.
- *New concepts:* concepts whose state is `not_assessed`/`introduced` and whose hard prerequisites are all ready (state ≥ assisted, or inferred).
- *Continue:* concepts at `introduced`/`assisted` (practice toward independent).
- *Remediation:* concepts flagged by the failure rule. The activity targets the weakest hard prerequisite: a quick diagnostic item, then a remedial explanation and exercise, then a reassessment, then back to the original concept.
- *Quick check:* inferred concepts and provisional diagnostic successes.
- *Transfer:* concepts at `independent` on their primary dimensions with no transfer evidence.

**Priority (every term is stored as the reason)**
- `goal` = goal_weight (0–3).
- `week_fit` = +3 if the concept belongs to the current curriculum week, +1 if to the next, −2 per week if far in the future.
- `project` = +3 if it is a prerequisite of the current week's project.
- `unlock` = log2(1 + number of goal-weighted concepts it unblocks).
- `gap` = +2 for remediation, +1 for continue.
- `review` terms = forgetting risk (1 − FSRS retrievability) × 3 + recent failure (+2) + overdue days (capped, +0.2/day, max +2) + prerequisite of the planned new concept (+2).
- `cost` = the estimate is scaled by the learner's historical actual/estimate ratio (clamped to 0.5–2).
- Score = sum of terms, divided by `sqrt(minutes)` for selection within a block.

**Packing (weekday 60 min)**
- Review block ≤ 25% of the budget (at least 1 review if any are due).
- Remediation (if flagged) ≤ 30%.
- Then continue/new: at most 2 new concepts per session, to avoid context switching. Prefer finishing an in-progress concept.
- 5-minute consolidation (teach-back explanation item) at the end.
- Blocks are filled greedily by score. Leftover minutes roll into practice on the session's main concept.
- The same exercise is never assigned twice in one session or within 7 days, unless the pool is exhausted.

**Saturday:** a 10-minute review warm-up, then the lab (current project, or the next unfinished one), then 10 minutes of reflection items.

**Sunday:** 20 minutes of a cumulative independent check (interleaved items from concepts reached that week and earlier; no hints), 20 minutes of remediation, 10 minutes of teach-back, then the progress review and next week's plan.

**Time management:** each activity has a planned number of minutes. When elapsed time passes the plan by more than 30%, the runner re-plans the remaining activities into the remaining budget and drops the lowest-scoring ones, but never cuts off an activity that is in progress. The session can always be extended or ended; unfinished activities are saved and resumed.

**Curriculum position:** current week = floor(days since start / 7) + 1. The default path follows the weeks, but diagnostic results move concepts earlier or later; mastered content is skipped.

## 8. Mastery estimation and review scheduling

**Evidence** — every graded attempt produces a row: `concept`, `dimension`, `correct` (0/0.5/1, where 0.5 is partial rubric credit), `mode` (practice/assessment/diagnostic/review), `hints_used`, `attempt_no`, `item_role` (core/transfer/review), `difficulty`, `duration`, `graded_by` (deterministic/llm/self).

**Credit** — a lookup table, not a probability:
- independent correct = 1.0
- correct after hint L1 = 0.7, L2 = 0.5, L3 = 0.3, L4–L5 = 0.1
- second-try correct = 0.5 (multiplied with the hint credit)
- answers graded by the LLM alone are capped at assisted credit

**State per (concept, dimension)**, ordinal:
1. `not_assessed`
2. `introduced`: lesson viewed or an attempt made, without a correct independent answer. Viewing a lesson alone yields at most this.
3. `assisted`: any correct answer with credit ≥ 0.3.
4. `independent`: ≥ 2 independent correct answers on *different* items, the most recent independent attempt correct, and at least one deterministically graded. A single diagnostic success gives `independent (provisional)`.
5. `retained`: independent, plus an independent correct answer ≥ 3 days after the first independent success (delayed recall).

**Concept summary**
- **Transfer & retention** (top state): every applicable primary dimension `retained`, plus an independent correct transfer item.
- **Working understanding:** conceptual ≥ independent, plus maths or implementation ≥ assisted.
- **Deep understanding:** every applicable dimension ≥ independent, at least one `retained`, and transfer independent where transfer items exist. This can never be reached from one attempt, since independent needs two different items.

**Demotion & failure rule**
- An independent failure at `independent`/`retained` drops the state one level and adds learning debt.
- Remediation flag: 2 consecutive independent failures on a concept, or ≥ 3 failures in the last 5 attempts.

**Traceability:** every state change writes a `mastery_events` row (from, to, the attempt ID that caused it, the rule name). The concept drawer shows this history. The scoring code lives in one module (`src/server/learning/mastery.ts`) behind a `MasteryModel` interface, so it is easy to replace.

**Reviews (FSRS)**
- A card is created per (concept, dimension) when the state first reaches `assisted`.
- Rating from the attempt: wrong → Again; correct with hints or a second try → Hard; independent correct → Good. Easy is never auto-assigned.
- Each review draws a *different* item from the dimension's pool (least recently seen; transfer items preferred once the state is ≥ independent). Implementation cards use code-completion or reimplementation items; FSRS still only times the review.
- Desired retention is 0.9 (the ts-fsrs default) and the maximum interval 60 days (shorter than the default because the horizon is 90 days). Fuzz is on.
- FSRS is designed for discrete recall items. Using it to time complex-skill reviews is a **[hypothesis]**. Periodic practical reassessment (Sunday checks; Day 30/60/90 checkpoints) is the safeguard.

**Review priority** is the score in §7, which implements the requested order: at-risk prerequisites, then recent failures, then project needs, then overdue, then the rest.

**Learning debt** is a derived list, not a score. Each entry names a concept, a dimension, a reason and a remediation action. Rules:
- (a) conceptual ≥ independent, but implementation applicable and below assisted;
- (b) a demotion from independent or retained;
- (c) at assisted after ≥ 4 attempts;
- (d) average hints ≥ 2 over the last 3 correct answers;
- (e) the remediation flag is open;
- (f) a lab test is failing for a linked concept.

## 9. Tutor architecture

- Module `src/server/tutor/`: `provider.ts`, `prompts/*.ts`, `schemas.ts`, `budget.ts`, `service.ts`.
  - `provider.ts` is the `LlmProvider` interface with an Anthropic implementation, plus a `FakeProvider` for tests and for running without a key.
  - `prompts/*.ts` export `{ id, version, system, build(input) }`.
  - `schemas.ts` holds the zod schemas.
- Structured outputs: the Anthropic Messages API with a single tool whose `input_schema` is generated from the zod schema, and a forced `tool_choice`. The result is validated with zod. On a validation failure, retry once, then fall back (authored content, or "tutor unavailable"). The model comes from `TUTOR_MODEL` (env, default a current Sonnet-class model); a cheaper model is used for hints.
- Functions:
  - `explainMistake(item, answer, gradingResult)` → `{ misconception_category, diagnosis, next_step_question, suggested_prereq_id? }`
  - `hint(item, level, priorHints, answerSoFar)` → `{ level, text, reveals_solution: boolean }`. Only used after the authored hints run out, and the level is server-enforced.
  - `gradeExplanation(item, rubric, answer)` → `{ criteria: [{id, met: yes|partial|no, evidence_quote}], missing_concepts, uncertainty, feedback }`. The score is computed in code from the rubric weights. Length is explicitly not a criterion. An LLM grade alone never makes a dimension independent.
  - `chat(conceptContext, history, message)` → `{ reply, asks_question: boolean }`. Socratic, practice mode only.
- Inputs are untrusted: learner text is placed in delimited blocks, and prompts instruct the model to ignore instructions inside them. Answer keys are only sent where needed (explainMistake, gradeExplanation), never to `chat` during an open item.
- The tutor returns data. Only server code decides what to persist; no model output touches mastery directly.
- Logging: every call writes an `llm_calls` row (prompt id + version, provider, model, input/output tokens, estimated cost from a pricing table, latency, status, validation error).
- Budgets: `LLM_DAILY_BUDGET_USD` (default 1.00), `LLM_MAX_REQUESTS_PER_MIN` (default 10) and a per-call max_tokens. When the budget is exhausted, the app degrades gracefully to authored-only mode, with a banner.

## 10. Exercise and grading design

Common fields: `id`, `concept`, `dimension`, `type`, `role` (core | transfer | review | diagnostic), `difficulty` 1–5, `est_minutes`, `prompt` (Markdown), `hints` (ordered L1..Ln), `solution` (Markdown explanation, shown after submit), `misconceptions` (optional), `version`.

| type | answer key | grading |
|---|---|---|
| `mc` | `options[{id,text,correct,feedback,misconception?}]` (single or multi) | exact set match; per-option feedback |
| `numeric` | `answer`, `tolerance` {abs?, rel?} | parse number (allow fractions/sci notation) within tolerance |
| `expression` | `answer` (mathjs syntax), `variables` with sample ranges | evaluate learner and key at 20 random points with mathjs; equal within 1e-6 rel; parse errors → ask to fix, not graded |
| `text` | `accept[]` (normalized), optional regex | case/whitespace-normalized match |
| `code_read` | `answer` as numeric or text | as above; prompt shows code |
| `code_complete` | `accept[]` normalized code snippets (whitespace/quote normalization) | MVP: normalized match against accepted variants; execution-based grading deferred |
| `debug` | `buggy_line` (int) + `fix` (mc options) | both parts must be correct for full credit; line alone = partial |
| `explain` | `rubric[{id, criterion, weight, required}]`, `exemplar` | LLM rubric grading; without key → learner self-checks rubric (graded_by=self, capped at assisted) |

Mistake categories (stored per failed attempt; from MC option metadata, explicit misconception tags, or tutor diagnosis): `missing_prerequisite | misunderstood_definition | math_error | incorrect_reasoning | implementation_error | misapplied_technique | recall_failure | incomplete_explanation`.

Practice vs assessment: in assessment items (diagnostic, Sunday check, quick checks, review attempts flagged independent) hints/tutor/solutions are hidden until submission; UI shows a clear "Assessment — no help" badge. Answer keys never leave the server before submission (the API serializes a client-safe view).

## 11. Coding / project workflow

- `labs/` is a uv-managed Python project (numpy, matplotlib, pytest). One folder per project: `labs/<project-id>/README.md` (mirrored in-app), `starter/` (learner edits a copy in `work/`, gitignored), `tests/` (public), `verify.py`.
- Flow: `uv run labs/setup.py <project>` copies starter → `work/`; learner implements in their IDE; `uv run labs/verify.py <project>` runs pytest + metric checks (e.g. final MSE below threshold on held-out synthetic data, gradient check against finite differences) and writes `labs/<project>/work/results.json` `{project, version, tests:[{id,passed,message}], metrics:{…}, generated_at}`.
- Upload results.json in the Lab page → server validates schema, records submission, maps tests → concepts (implementation evidence, `graded_by=deterministic`, mode=practice unless "no hints used" declared), then asks reflection/prediction questions (graded items, e.g. "what happens to the loss curve if η is 10× larger?").
- Why not browser Pyodide / server sandbox in MVP: local IDE is what real ML work looks like, needs no sandbox security, and supports numpy/torch natively. Tradeoff: results.json is self-reported (acceptable for a single honest user; documented). Never executing learner code on the server satisfies the isolation requirement.
- Week-1 project fully built: `linreg-numpy` (implement predict, mse, gradients, gradient descent, train/val split; plot loss + parameter trajectory; reflection questions). Further projects stubbed with briefs.

## 12. Database schema (Postgres, Drizzle)

Content lives in files; tables hold learner state only.

- `users` (id, display_name, timezone, start_date, prefs jsonb {schedule minutes per weekday, goal text}, created_at)
- `study_sessions` (id, user_id, kind, planned_minutes, started_at, ended_at, status planned|active|completed|abandoned, plan jsonb {activities with reasons, scheduler version}, active_seconds)
- `session_activities` (id, session_id, idx, kind review|learn|practice|remediate|quick_check|transfer|lab|reflect|teachback|diagnostic, concept_id, exercise_ids jsonb, planned_minutes, status, progress jsonb {block index, items done}, reason jsonb, started_at, completed_at)
- `attempts` (id, user_id, session_id?, activity_id?, exercise_id, exercise_version, concept_id, dimension, mode practice|assessment|diagnostic|review, answer jsonb, correct real, credit real, hints_used int, attempt_no int, graded_by, feedback jsonb, mistake_category?, duration_ms, created_at)
- `hint_events` (id, attempt_group_id/user+exercise+activity, level, source authored|llm, text, created_at)
- `mastery` (user_id, concept_id, dimension, state, provisional bool, inferred bool, evidence jsonb {independent_item_ids, counts}, last_assessed_at, last_independent_at, first_independent_at) PK (user, concept, dimension)
- `mastery_events` (id, user_id, concept_id, dimension, from_state, to_state, rule, attempt_id?, created_at)
- `review_cards` (id, user_id, concept_id, dimension, fsrs jsonb, due_at, last_review_at, reps, lapses) unique (user, concept, dimension)
- `review_logs` (id, card_id, attempt_id, rating, fsrs_log jsonb, created_at)
- `diagnostic_runs` (id, user_id, kind baseline|day30|day60|day90, status, state jsonb {per-domain ladder position}, started_at, completed_at, summary jsonb)
- `remediation_flags` (id, user_id, concept_id, target_prereq_id, status open|resolved, opened_by_attempt_id, created_at, resolved_at)
- `project_progress` (user_id, project_id, status, task_state jsonb, started_at, completed_at)
- `project_submissions` (id, user_id, project_id, results jsonb, passed int, total int, metrics jsonb, created_at)
- `tutor_messages` (id, user_id, activity_id?, exercise_id?, role, content, llm_call_id?, created_at)
- `llm_calls` (id, prompt_id, prompt_version, provider, model, input_tokens, output_tokens, cost_usd, latency_ms, status, error, created_at)

Migrations: drizzle-kit generated SQL in `drizzle/`, applied by `pnpm db:migrate` (also run by `pnpm dev`). Seed: default user only (content needs no seeding).

## 13. API and application architecture

Single Node process (Hono). Modules under `src/server/`: `content/` (load, validate, index, client-safe serializers), `grading/`, `learning/` (mastery, fsrs, scheduler, diagnostic, debt, remediation), `tutor/`, `sessions/`, `projects/`, `progress/`, `routes/`. Learning modules are pure functions over plain data + a thin repository layer → unit-testable without DB.

Routes (JSON, zod-validated, single user resolved by middleware):
- `GET /api/today` — plan preview (computed, not persisted) + due counts, objective, week, Saturday project, goal progress
- `POST /api/sessions` {kind?, budgetMinutes?, focusConceptId?} → persisted plan; `GET /api/sessions/active`; `GET /api/sessions/:id`; `POST /api/sessions/:id/activities/:aid/progress`; `POST /api/sessions/:id/replan`; `POST /api/sessions/:id/end`
- `GET /api/exercises/:id` (client-safe); `POST /api/attempts` {exerciseId, activityId?, answer, mode} → grading result, mastery changes, next; `POST /api/hints` {exerciseId, activityId} → next level (server tracks level)
- `GET /api/lessons/:conceptId`
- `POST /api/diagnostic` (start/resume), `GET /api/diagnostic/:id/next`, `POST /api/diagnostic/:id/answer`, `GET /api/diagnostic/:id/results`
- `GET /api/map` (nodes+edges+state, filter by domain), `GET /api/concepts/:id` (details, mastery, evidence history, debt)
- `GET /api/projects`, `GET /api/projects/:id`, `POST /api/projects/:id/submissions`, `POST /api/projects/:id/tasks`
- `GET /api/progress`, `GET /api/plan/week`
- `POST /api/tutor/explain`, `POST /api/tutor/chat`, `POST /api/tutor/grade` (internal use from attempts)
- `GET/PUT /api/settings`

## 14. Frontend screens and components

Routes: `/` Today, `/session/:id` runner, `/diagnostic`, `/diagnostic/results`, `/map` (+ concept drawer `?concept=`), `/lab`, `/lab/:projectId`, `/progress`, `/settings`.

Components: `Markdown` (react-markdown + remark-math + rehype-katex + highlighted code), `ExerciseCard` (dispatch per type: `McInput`, `NumericInput`, `ExpressionInput` with live KaTeX preview, `TextInput`, `CodeInput` monospace textarea, `DebugInput` line picker), `HintLadder`, `FeedbackPanel`, `ModeBadge` (Practice / Assessment), `LessonBlocks`, `SessionTimeline` (blocks + time remaining), `TutorPanel` (practice only), `ConceptDrawer`, `KnowledgeGraph` (@xyflow/react + dagre layout, domain filter, ≤ ~40 nodes visible), `ReasonChip`.

Keyboard: Enter submit, `h` hint, `n`/→ next, `1–9` choose MC option, `?` shortcuts. Design: Inter, neutral grays + one accent, focus rings, 70ch reading width, responsive to tablet width, WCAG AA contrast, aria labels on inputs.

## 15. Content authoring pipeline

- Author YAML in `content/`; `pnpm content:check` validates (zod schemas): duplicate IDs, unknown concept/exercise/project references, prerequisite cycles (DFS), missing prereqs, missing answer keys, missing objectives, unsupported exercise types, lesson `check` blocks pointing at missing exercises, MC with no correct option, expression keys that don't parse, numeric tolerance missing, authored concepts with < 3 exercises or no review-eligible item, diagnostic ladders referencing stubs.
- `pnpm content:verify-py` runs `content/checks/*.py` — Python recomputation of numeric answers (e.g. gradient values) and execution of code_read snippets to confirm expected outputs.
- Content version = hash of item YAML; stored on every attempt.
- Both run in `pnpm test` and CI.

## 16. Security and cost considerations

- No learner code on the server; lab results are parsed as data (size-limited, zod-validated).
- All LLM output validated; never mutates state directly; learner text delimited as untrusted.
- Answer keys/solutions only returned after submission; hint levels enforced server-side.
- Secrets via env (`ANTHROPIC_API_KEY`), never logged; `.env` gitignored.
- Single user: app binds to localhost by default; optional `ACADEMY_PASSWORD` enables a signed-cookie login for any non-local deployment.
- Rate limits + daily LLM budget; body size limits; input validation on every route.
- Expected cost: hints/feedback with a small model ≈ cents/day; budget default $1/day.

## 17. Implementation phases

0. Plan (this doc) + toolchain.
1. **End-to-end slice**: content loader/validator; Week 1 content; schema; grading; mastery; FSRS; minimal scheduler; diagnostic; Today; session runner; lesson + exercise UI. Persistent.
2. Full scheduler (priorities, packing, reasons, remediation, replan), knowledge map, concept drawer.
3. Tutor: provider, prompts, hints L4–5, explain mistake, rubric grading, chat, budgets, practice/assessment UX.
4. Lab: linreg-numpy project, verifier, upload, reflection, project progress.
5. Progress dashboard, learning debt, weekly plan, Saturday/Sunday sessions, Week 2 content.
6. Quality: e2e, accessibility pass, empty/loading/error states, docs.

## 18. Testing strategy

- Unit (vitest): every grader type (edge cases: fractions, tolerance, equivalent expressions, parse errors), mastery transitions, credit table, FSRS mapping, scheduler packing, debt rules, diagnostic ladder.
- Learning-engine scenario tests (§18.2 of the brief): no-knowledge user gets foundational concepts; knowledgeable user skips mastered prereqs; repeated failure → remediation targeting prereq; independent success > hinted success; overdue reviews scheduled; project prereqs prioritized; time budget respected; interrupted session resumes; every mastery change has an evidence event.
- Content: `content:check` + Python answer verification.
- DB integration: routes against a real Postgres test DB (docker).
- E2E (Playwright): diagnostic → results → session → lesson → exercise with hint → graded → mastery visible on map → clock advanced (server `NOW_OVERRIDE` in test env) → review appears on Today → lab upload. Tutor uses FakeProvider in tests.

## 19. Risks and tradeoffs

- **Content is the bottleneck.** Only ~15 concepts fully authored in MVP; schedule will hit stubs by week 2–3. Mitigation: stubs are visible as "not yet authored"; authoring format is quick; next sessions add content weekly ahead of the learner.
- **Self-reported lab results.** Acceptable for single user.
- **Code exercises graded by string match** are brittle → prefer code_read / debug / numeric formulations; execution-based grading is the first deferred feature.
- **FSRS on skills** is untested territory → reassessment backstop.
- **LLM grading noise** → capped credit, rubric-based, never sole evidence.
- **Heuristic weights** may misprioritize → reasons are visible and overrides exist; weights in one config.
- **Scope vs. study time**: the platform must not eat the 132 hours; MVP favors the learning loop over dashboards.

## 20. MVP acceptance criteria

The 12 end-to-end criteria of the brief (§18.3), all without manual DB edits, plus the educational criteria (§18.4) each backed by a scenario test:
1. Open app → 2. complete diagnostic → 3. personalized plan → 4. start 60-min session → 5. study a real ML concept → 6. auto-graded questions → 7. hints → 8. useful feedback → 9. knowledge state updates (map/progress) → 10. later return shows a scheduled review → 11. Saturday project accessible with verifier + upload → 12. progress toward 90-day goals shown.

Verification report will state exactly which were exercised in a real browser vs only by automated tests.

---

## References (primary/systematic)

- Roediger & Karpicke (2006). Test-enhanced learning. *Psychological Science* 17(3).
- Dunlosky, Rawson, Marsh, Nathan, Willingham (2013). Improving students' learning with effective learning techniques. *PSPI* 14(1).
- Adesope, Trevisan, Sundararajan (2017). Rethinking the use of tests: a meta-analysis of practice testing. *RER* 87(3).
- Cepeda, Pashler, Vul, Wixted, Rohrer (2006). Distributed practice in verbal recall tasks. *Psych. Bulletin* 132(3).
- Ye, Su, Cao (2022). A stochastic shortest path algorithm for optimizing spaced repetition scheduling. *KDD*; FSRS: github.com/open-spaced-repetition.
- Sweller & Cooper (1985). Worked examples as a substitute for problem solving. *Cognition & Instruction* 2(1).
- Renkl & Atkinson (2003). Structuring the transition from example study to problem solving. *Educational Psychologist* 38(1).
- Kalyuga, Ayres, Chandler, Sweller (2003). The expertise reversal effect. *Educational Psychologist* 38(1).
- Freeman et al. (2014). Active learning increases student performance in STEM. *PNAS* 111(23).
- Rohrer & Taylor (2007). The shuffling of mathematics problems improves learning. *Instructional Science* 35.
- Brunmair & Richter (2019). Similarity matters: a meta-analysis of interleaved learning. *Psych. Bulletin* 145(11).
- Chi, de Leeuw, Chiu, LaVancher (1994). Eliciting self-explanations improves understanding. *Cognitive Science* 18(3).
- Bisra, Liu, Nesbit, Salimi, Winne (2018). Inducing self-explanation: a meta-analysis. *Ed. Psych. Review* 30.
- Hattie & Timperley (2007). The power of feedback. *RER* 77(1). Shute (2008). Focus on formative feedback. *RER* 78(1).
- Barnett & Ceci (2002). When and where do we apply what we learn? *Psych. Bulletin* 128(4).
- Bloom (1984). The 2 sigma problem. *Educational Researcher* 13(6). Kulik, Kulik, Bangert-Drowns (1990). Effectiveness of mastery learning programs. *RER* 60(2).
