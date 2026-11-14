---

name: write-questions
description: How to write and review Open Academy questions (content/exercises/*.yaml): the question types and the mix each lesson step needs, the giveaway test, wrong options built from real mistakes, templates, and checking every answer. Use whenever you write, rewrite or audit questions, on their own or as part of a lesson.
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

## 2. What a good question does

- **One idea at a time.** A question checks one thing, so a wrong answer says what to review. Split a question that needs two new ideas into two.
- **One right answer.** The stem says exactly what to give: units, rounding, which quantity. "What is $p$, to two decimal places?" rather than "What happens to $p$?"
- **Stands alone.** A question can come back in a review weeks later, so it gives all the numbers and context it needs and never refers to the lesson, a step number, the worked example or a picture. Only `lesson_only` self-explanation questions may refer to the worked example.
- **Typed answers for numbers.** Recalling an answer strengthens memory more than recognising it. If the answer is a number or short expression, make it `numeric` or a template, not MC.
- **Effort lands on the idea.** Keep the arithmetic easy (clean numbers, small integers) so the learner's effort goes into the idea, not into long division.

## 3. Question types and the mix for each step

Each step needs at least five questions across difficulties 1, 2 and 3. Cover the idea from several of these angles, so reviews test the idea and not one familiar stem:

1. **Definition.** What the idea is, or what a symbol or term means. "What does the sigmoid output represent?" Use MC with wrong options that are real confusions (a label, a score, a loss).
2. **Which tool.** Pick the formula, method or model for a situation. "You predict whether a house sells within a month. Which model and loss fit?"
3. **Compute.** A typed number, with the step's idea left for the learner. "Find the sigmoid probability for $z=0$." Prefer a template (`params`, `answer_expr`) so each review shows new numbers.
4. **Interpret.** Say what a result means. "A model gives $p=0.88$ for label 1. What does it predict, and how sure is it?"
5. **Spot the mistake.** A short worked attempt with one common error. "A learner computes $\sigma(2)=1/(1+e^{2})$. What went wrong?"
6. **New setting.** The same idea in a different place, such as a robot, a medical test or a different function. Put these last, at difficulty 3.

Every idea in a step gets at least two questions from different angles. Cover the distinct cases of the idea (for exponents: positive, negative, zero power, zero to a power), one question each where they matter. The lesson skill adds two fixed items: a concept MC first (`role: basics`) and a `lesson_only` self-explanation MC about the worked example.

## 4. Multiple-choice options

- **Wrong options are real mistakes.** Each wrong option is an answer a learner who made a specific error would give: the wrong sign, forgetting to divide, using the score as a probability, the other row or column. Give each one its own `feedback` naming that error.
- **All options look alike.** Similar length, grammar and level of detail. The right one is not the longest, the most careful or the only one with a number.
- **Three or four options.** Three good options beat five with filler.
- **No "all of the above", "none of the above" or "which is NOT".** They test reading the options more than the idea.
- **Exactly one correct option.** Check that no wrong option is also defensible.

## 5. Templates

- Choose ranges so the answer is never constant and is not simply one parameter or one number shown in the stem. The exception is a question whose task is to pick a shown value, such as a table row or the best epoch.
- `common_wrong` answers must never equal the right answer for any parameter values. `content:check` enforces this.
- Write negative values in parentheses so substituted text never reads `+ -3`.
- Check every parameter combination by script against the tolerance and the rounding the stem asks for.

## 6. Writing

Follow the lesson skill's writing rules: plain words, short sentences, notation from `content/notation.yaml`, and only ideas from the concept's prerequisites. No "X, not Y" contrast lines and no em dashes. `solution` says how to get the answer in one or two sentences, using the same numbers.

## 7. Checking before you ship

1. Run the giveaway test (§1) on every question.
2. Compute every numeric answer with a script (Python or Node), including every template combination.
3. For each MC question, confirm exactly one option is correct and each wrong one has its own feedback.
4. Check the step's mix: at least five questions, difficulties 1 to 3, and at least two angles per idea (§3).
5. Run `pnpm content:check`, `pnpm exec vitest run apps/api/tests/content/` and `pnpm check`.

## Reviewing existing questions

To audit a set, read every question and apply §1 to §5. Rewrite only the ones that fail. Keep each exercise's `id`, `dimension`, `role`, `difficulty`, `lesson_only` and place in the lesson, because learner progress depends on them. Rewrite `prompt`, the answer, `options`, `feedback` and `solution` as needed, and change `type` if it makes a better question. If lesson text such as a `faded` block refers to the exercise, keep it consistent. Report each rewrite as `id`: the reason, then the old stem and the new stem.
