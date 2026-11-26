---

name: write-questions
description: "How to write and review Open Academy questions (content/exercises/*.yaml): the question types and the mix each lesson step needs, recall questions for reviews, the giveaway test, wrong options built from real mistakes, templates, and checking every answer. Use whenever you write, rewrite or audit questions, on their own or as part of a lesson."
---

# Writing and reviewing questions

Questions do two jobs. In the lesson they check that the learner can use the step's idea. Weeks later they come back as spaced reviews, where answering them is what keeps the idea in memory. A question only helps if answering it makes the learner recall or use the idea. The rules below come from Math Academy and Khan Academy practice, Andy Matuschak's "How to write good prompts", Piotr Wozniak's "20 rules of formulating knowledge", and the research on retrieval practice and multiple-choice writing.

The file format is in `docs/CONTENT_FORMAT.md`. The lesson skill (`../write-lesson/SKILL.md`) says where questions sit in a lesson. This skill says what makes each one good.

## 1. The giveaway test

Before anything else, ask: could someone who hasn't read the lesson answer this from the stem alone? If so, rewrite it. The common forms:

- **Already applied.** The stem has done the step the topic teaches, and only arithmetic is left. "For $z=0$, $e^{-z}=1$. Complete $p=1/(1+1)$" has already applied the sigmoid. Ask "Find the sigmoid probability for score $z=0$" instead.
- **Method named in the stem.** "Use $dy/dx = dy/du \cdot du/dx$ to find $dy/dx$" tells the learner which rule to use. Choosing the rule is part of the skill, so just ask for $dy/dx$.
- **Answer in the stem.** The answer, or a number or word that gives it away, appears in the stem: a template whose middle reading is always the mean, "copies" next to a question about independence, "cancels" in a question whose answer is zero.
- **Pre-selected data.** The stem has already narrowed the data to the group that matters, so only a division is left. Give the whole table and let the learner pick the group.
- **Obvious option.** The right MC option is the only plausible one: the only long, careful or hedged option, the one that repeats the stem's words, or the only one that does a calculation.
- **Trivial template.** For some parameter values the answer is constant, equals a parameter, or equals a number already shown.

Easy questions are fine. A difficulty-1 question can be one short step, as long as that step is the idea being taught.
Basic-skill questions in maths courses (difficulty 1, numeric or multiple choice) get `target_seconds: 30`, because these skills should become fast enough to use without thinking.

## 2. What a good question does

- **One idea at a time.** A question checks one thing, so a wrong answer says what to review. Split a question that needs two new ideas into two.
- **One right answer.** The stem says exactly what to give: units, rounding, which quantity. "What is $p$, to two decimal places?" rather than "What happens to $p$?"
- **Stands alone.** A question can come back in a review weeks later, so it gives all the numbers and context it needs and never refers to the lesson, a step number, the worked example or a picture. Only `lesson_only` self-explanation questions may refer to the worked example.
- **Every symbol is named.** Say what each letter, tuple and matrix in the stem is: "two probability distributions over the same two outcomes, $p=(1,0)$ and $q=(1/2,1/2)$", not "Let $p=(1,0)$ and $q=(1/2,1/2)$"; "a move of $a=(1,2)$ metres east and north", not "$a=(1,2)$". The lesson's notation is not enough, because a review shows the question mixed in with other topics. If someone fluent in the subject, reading only the stem, could take a symbol for something else (a vector or a distribution, a probability or a count, a row or a column), the stem is ambiguous.
- **Typed answers for numbers.** Recalling an answer strengthens memory more than recognising it. If the answer is a number or short expression, make it `numeric` or a template, not MC.
- **Effort lands on the idea.** Keep the arithmetic easy (clean numbers, small integers) so the learner's effort goes into the idea, not into long division.

## 3. Question types and the mix for each step

Each step needs at least five questions across difficulties 1, 2 and 3. Cover the idea from several of these angles, so reviews test the idea and not one familiar stem:

1. **Definition.** What the idea is, or what a symbol or term means. "What does the sigmoid output represent?" Use MC with wrong options that are real confusions (a label, a score, a loss).
2. **Which tool.** Pick the formula, method or model for a situation. "You predict whether a house sells within a month. Which model and loss fit?"
3. **Compute.** A typed number, with the step's idea left for the learner. "Find the sigmoid probability for $z=0$." Prefer a template (`params`, `answer_expr`) so each lesson attempt and quiz shows new numbers.
4. **Interpret.** Say what a result means. "A model gives $p=0.88$ for label 1. What does it predict, and how sure is it?"
5. **Spot the mistake.** A short worked attempt with one common error. "A learner computes $\sigma(2)=1/(1+e^{2})$. What went wrong?"
6. **New setting.** The same idea in a different place, such as a robot, a medical test or a different function. Put these last, at difficulty 3.

Every idea in a step gets at least two questions from different angles. Cover the distinct cases of the idea (for exponents: positive, negative, zero power, zero to a power), one question each where they matter. The lesson skill adds two fixed items: a concept MC first (`role: basics`) and a `lesson_only` self-explanation MC about the worked example.

### Explain questions: rubrics and exemplars

- An explain prompt asks for at most 3 things. Give it 2–4 required criteria, each matching a part of the prompt, and at most 2 optional extras taught in the lesson. Keep the whole rubric to at most 6 criteria.
- Every rubric criterion, required or optional, and every claim in the exemplar must be explicitly taught in the lesson step or in a prerequisite lesson listed in the recap. Taught means said in plain words in an explain, worked example or summary. A diagram alone or an implication does not count.
- When an answer is partly right, the app says "Almost" and lists the criteria the learner missed. The learner has to be able to find each one in what they read.
- Each criterion names one concrete point in the lesson's own words, written as an instruction (for example "Explain that ..."), so the missed-points list tells the learner exactly what to add.
- Required criteria are exactly the parts the prompt asks for, and every part of the prompt has at least one required criterion. Extras are optional and never cost marks, and they still have to be taught.
- When reviewing, check each criterion and each exemplar claim against the lesson text, and either teach it or drop it.

## 4. Multiple-choice options

- **Wrong options are real mistakes.** Each wrong option is an answer a learner who made a specific error would give: the wrong sign, forgetting to divide, using the score as a probability, the other row or column. Give each one its own `feedback` naming that error.
- **All options look alike.** Similar length, grammar and level of detail. The right one is not the longest, the most careful or the only one with a number.
- **Numbers in one font.** Values that sit side by side in an option, a list or one calculation are written the same way. If one of them needs maths (a minus sign, a power, a fraction), write them all in maths: `$3$ and $-2$`, never `3 and $-2$`, which shows the 3 in a different font and size. Labels and counts that aren't values in the calculation stay plain text: cell 3, head 1, columns 5 to 8, 12 heads. `content:check` fails an option that joins a plain number and a maths number with a comma, "and" or "or", or that writes a negative number in plain text. Format the same kind of value the same way in every option of a question too, or the font marks the answer.
- **Three or four options.** Three good options beat five with filler.
- **No "all of the above", "none of the above" or "which is NOT".** They test reading the options more than the idea.
- **Exactly one correct option.** Check that no wrong option is also defensible.

## 5. Templates

- Choose ranges so the answer is never constant and is not simply one parameter or one number shown in the stem. The exception is a question whose task is to pick a shown value, such as a table row or the best epoch.
- `common_wrong` answers must never equal the right answer for any parameter values. `content:check` enforces this.
- Write negative values in parentheses so substituted text never reads `+ -3`.
- Check every parameter combination by script against the tolerance and the rounding the stem asks for.

## 6. Recall questions for reviews

Problems show the learner can use an idea. Reviews should also make them recall what the idea is and how its formula reads, because definitions are what keep look-alike ideas apart (entropy, cross-entropy and KL). Recall questions use `role: recall` and `knowledge_point: <step id>`. They never appear in the lesson. Each review of a topic asks recall questions on two of its steps, rotating through the steps, and a step the learner got wrong comes back first.

Write three recall questions for every lesson step, one in each style. A review rotates through them, so the learner has to recall the idea itself, whatever the wording.

1. **Say it yourself** (`type: explain`, `dimension: conceptual`, `est_minutes: 1`). "In one or two sentences, what is cross-entropy $H(p,q)$? Say where $p$ and $q$ are used." Typing the definition from memory is the strongest form of recall. Give it 2 required criteria that together are the definition, in the lesson's own words, plus at most one optional extra. Every criterion must be stated plainly in that step (see the explain rules in §3).
2. **Contrast** (`type: mc`, `dimension: conceptual`, `est_minutes: 0.5`; `target_seconds: 30` at difficulty 1 in maths courses). The wrong options are the neighbouring ideas the learner is most likely to confuse with this one: the other steps of the lesson and the prerequisites it builds on. "Which quantity is the average surprise when surprise is calculated from the actual probabilities?" with entropy, cross-entropy, KL and one-day loss as options. Each wrong option's feedback says which idea it is and how it differs.
3. **Formula** (`dimension: math`, `est_minutes: 0.5`). If the step's formula fits on one line with scalar variables, ask the learner to type it (`type: expression`, with `variables` ranges inside the formula's domain). Use the smallest case that still shows the formula: a two-outcome distribution, a single example, two dimensions. Tell them the function names to use, such as `log2(...)` and `exp(...)`, and to type `*` for multiplication. If the formula uses sums, vectors or matrices, write a cloze (`type: text`) that blanks out the part learners get wrong, such as which distribution goes inside the logarithm or the order of a subtraction, and list every reasonable way to write the answer in `accept`, plus a `regex` when spacing can vary, as in `H( p, q )`. Don't show the answer's notation as a format example in the prompt. A step with no formula gets a second contrast question that asks about a different neighbouring idea.

Recall questions follow the rest of this skill: they stand alone, pass the giveaway test and have one right answer. Don't copy a step's `basics` question. The basics question checks the idea straight after reading. A recall question asks for it weeks later, from a different angle.

## 7. Review pool size

A topic is reviewed one dimension at a time. Each review picks a question of that dimension with role `review`, `core`, `practice`, `transfer` or `basics` that is not `lesson_only` and not a template. Templates appear in lessons and quizzes, never in spaced reviews. Every dimension a concept lists needs at least five such questions, so a learner does not meet the same question in back-to-back reviews. Lesson step problems count, but the learner has already seen them, so write at least two more that are not in the lesson. `pnpm content:check` fails when a dimension has fewer than five.

## 8. Writing

Follow the lesson skill's writing rules: plain words, short sentences, notation from `content/notation.yaml`, and only ideas from the concept's prerequisites. No "X, not Y" contrast lines and no em dashes. `solution` says how to get the answer in one or two sentences, using the same numbers.

## 9. Prerequisite check

Run the same Prerequisite check as the lesson skill for every batch of new or rewritten questions, including lab, project, diagnostic and recall questions. Give the separate reviewer the output of `pnpm academy prereqs <concept-id>` for the question's concept, the lesson and all new questions. Follow the separate-session and API-key rules and use the prompt in `.agents/skills/write-lesson/SKILL.md`.

Keep concept-pool questions within what the output lists or the lesson teaches. Put lab questions that need a later topic in the project.

## 10. Checking before you ship

1. Run the giveaway test (§1) on every question.
2. Cold-read every stem with nothing else open, as it would appear in a mixed review. Rewrite any stem where a symbol, unit or quantity could mean two things (§2).
3. Compute every numeric answer with a script (Python or Node), including every template combination.
4. For each MC question, confirm exactly one option is correct and each wrong one has its own feedback.
5. Check the step's mix: at least five questions, difficulties 1 to 3, and at least two angles per idea (§3), plus three recall questions (§6).
6. Run `pnpm content:check`, `pnpm exec vitest run apps/api/tests/content/` and `pnpm check`.
7. Once the topic's questions are done, follow `../set-weights/SKILL.md` to work out its encompassing weights and have a separate agent check them before you record them.
8. Check each dimension's review pool has at least five questions (§7).

## 11. Reviewing existing questions

To audit a set, read every question and apply §1 to §6. Rewrite only the ones that fail. Keep each exercise's `id`, `dimension`, `role`, `difficulty`, `lesson_only` and place in the lesson, because learner progress depends on them. Rewrite `prompt`, the answer, `options`, `feedback` and `solution` as needed, and change `type` if it makes a better question. If lesson text such as a `faded` block refers to the exercise, keep it consistent. Report each rewrite as `id`: the reason, then the old stem and the new stem.
