# Lesson style

Every lesson is a knowledge-point lesson (see `CONTENT_FORMAT.md`). Model lessons: `content/lessons/supervised-learning.yaml` and `content/lessons/train-test-split.yaml`.

## Shape
- **objective:** one sentence starting "**Goal:**", saying what the learner will be able to do.
- **2–4 knowledge points, one idea each.** The title names the idea in plain words ("Why test on unseen houses", not "Generalisation").
- **final:** one `explain` question (role `core`) that ties the lesson together. It has 2–3 rubric criteria and an exemplar answer.
- **summary:** 3 bullets, one per main idea.

## Explain (120–250 words per point)
1. **Start with the problem** this idea solves, inside the running example ("You have 1,000 past sales. How do you know the model works on a house it hasn't seen?").
2. **Then give the idea in plain words.**
3. **Then name it**, putting the term in bold where it's defined.
4. **Notation only if it's needed.** Explain each symbol in words where it first appears. Never use a term or symbol before the lesson that teaches it (`content/notation.yaml` enforces this).

- Paragraphs of 1–3 sentences. Use bullets for parallel items, such as the three splits.
- Use one **running example** with real numbers for the whole lesson. Default to house sales unless the topic needs something else (vectors: positions and arrows; derivatives: a car's distance over time).
- Robotics links: at most one sentence, at the end of a point, using only ideas already taught.
- Write in second person, in plain British English. No filler ("It is important to note that…") and no one-line abstract definitions without an example.

## Worked example
- Start with "This example shows …".
- Use concrete numbers and show every step. A table works well when comparing settings or models.
- End with the takeaway in one sentence.

## Diagrams
Use a diagram when the idea is spatial, a proportion or a process: arrows for vectors, a split bar for data, steps down a curve for gradient descent. Write it as a fenced `svg` block:
- `viewBox` at most 640 wide, with an `aria-label` describing what it shows;
- labels inside the diagram, `font-family="ui-sans-serif, system-ui, sans-serif"`, text at least 13px;
- hex colours only, from this palette: text `#171717`, muted `#737373`, lines `#d4d4d4`, green `#10b981`, amber `#f59e0b`, blue `#3b82f6`, red `#ef4444`.

## Problems (3 required, aim for 5–6 per point)
Each point's problems test **that point** (and earlier ones), not later ones. Mix these types:
- **Recognition:** "Which split should this score come from?"
- **Application to a new scenario:** a different dataset or a robot task, built only from ideas already taught.
- **Misconception:** the wrong options are the mistakes people actually make, and each wrong option has its own `feedback`.
- **Computation:** a parameterised numeric template whenever the point involves arithmetic.

Every problem has a `solution` of 1–3 sentences that says *why*. Multiple-choice options are of similar length, and there's no "all of the above".
