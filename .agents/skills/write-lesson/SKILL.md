---

name: write-lesson
description: How to write or rewrite an Open Academy lesson (content/lessons/*.yaml and its exercises). Use for every new lesson and every lesson rewrite. It defines the evidence-based structure of each knowledge point, the diagram and number rules, and the cold-reader review a lesson must pass before it ships.
---

# Writing a lesson

A lesson teaches one concept as 2–4 **knowledge points** (KPs), one idea each. The file format is in `docs/CONTENT_FORMAT.md`. This skill covers _how to explain_. Every rule below is there to make a first-time reader understand. When a rule and clarity conflict, choose clarity and say why in the PR.

## 0. Plan before writing

1. Read the concept in `content/concepts/*.yaml` and the lessons of its prerequisites. List what the learner already knows (terms, symbols, results) and what they don't. Never use a term or symbol before the lesson that teaches it (`content/notation.yaml` enforces this).
2. Write down, in one line each:
   - the question the lesson answers;
   - the 2–4 ideas (one per KP);
   - the confusions a beginner will have, phrased as their own question ("Isn't the directional derivative just the gradient?").
3. Pick the **simplest case you can picture** for each idea, e.g. 2 inputs rather than 4, a hill rather than a loss surface, and numbers that come out clean ((3, 4) → 5, not 40√554).

## 1. The structure of every knowledge point

Use these parts, in this order. The bold labels are literal; each starts its own paragraph.

**Step titles.** Each knowledge point's `title` is shown under the lesson name while you work through it. Write it in plain words a beginner understands _before_ reading the step, saying what the step does ("Take one step downhill", "Multiply a matrix by a vector"). At most ~6 words. No slogans, no wordplay, and no term that only the step itself explains ("Step against the gradient" fails).

In `explain`:
1. **The question.** 1–2 sentences posing the problem this idea solves, before any answer. _(Asking first prepares the learner to take in the explanation: Schwartz & Bransford 1998.)_
2. **Picture it.** The simplest concrete case, with a diagram right beside the words (see §3). Walk through what the picture shows in plain words. _(Words plus a picture beat words alone, and simple diagrams beat detailed ones: Mayer 2008; Butcher 2006.)_
3. **The idea.** First the idea in one plain sentence. Then the general definition, with the term in **bold**. Notation comes last, with each symbol explained in words where it first appears. The definition must be general, not phrased through the example: "a vector of partial derivatives, one per input", not "one per house weight". _(Concrete first, then fade to the general form, which is what transfers: Fyfe et al. 2014; Kaminski et al. 2008.)_
4. **Common confusion.** State the beginner's likely wrong belief as they would say it, say plainly that it's wrong (or only half right), and explain why. One per KP, for the confusion that matters most. _(Refutation text: Tippett 2010.)_

In `worked`:
5. **Worked example.** Clean numbers. Number each step, and start each step with its purpose in a few words ("1. Find each slope."). Show every calculation as display maths, one step per line. _(Worked examples beat cold problem solving for novices, and labelled subgoals help: Sweller & Cooper 1985; Atkinson et al. 2000.)_
6. **Compare cases.** Where the idea varies with a setting (direction, size, sign), give a small table of contrasting cases from the same example: e.g. direction → slope, with +x gives 3, steepest gives 5, sideways gives 0, downhill gives −5. _(Comparing cases side by side: Rittle-Johnson et al. 2015; Schwartz & Bransford 1998.)_
7. **Where it shows up.** At most 2 sentences tying the idea to ML or robotics, built only from ideas already taught. This always comes last, never first. _(Applying it in a new setting supports transfer.)_

In `problems` (order matters; the runner starts easy and steps up):
8. The `basics` MC question first. Then one **self-explanation** question about the worked example ("Why does step 2 use the dot product?"), written as an `mc` whose options are plausible reasons, each wrong one with its own `feedback` (choosing among explanations works too: Aleven & Koedinger 2002). Knowledge-point problems can't be `explain` type; only the lesson `final` is. Then problems from partly worked to full, easy to hard (difficulty 1, 2, 3 all present). The last ones are in a new setting (a different function, or a robot). _(Self-explanation: Chi et al. 1989; Bisra et al. 2018. Fading: Renkl & Atkinson 2003.)_

Lesson level:
- **objective:** one sentence, "**Goal:** …", in plain words.
- **where_this_fits** (shown as "What you're learning", 60–130 words): set the scene before anything else. Say (1) the problem in the learner's world, in plain words (for ML lessons, what it does for training a model); (2) why the tools they already have aren't enough; (3) the lesson's 2–4 steps as a numbered list, one per KP. Not a recap of prerequisites, and no term the learner hasn't met.
- **summary:** one line per KP, each a sentence the learner should now be able to say out loud. No new information.
- **final:** one `explain` question that makes the learner connect the KPs in their own words (recall, not rereading: Roediger & Karpicke 2006; Dunlosky et al. 2013). Give it 2–3 rubric criteria and an exemplar.

## 2. Writing rules

- **Each lesson stands on its own.** Introduce every example, object and set of numbers inside the lesson that uses it before using it. Never write "this house", "the model" or "the same data" for something set up only in another lesson. To build on an earlier lesson, name it and recap what it was in one sentence ("In the linear-regression lesson you predicted a house's price as $w\cdot x + b$; …").
- **Explain the setting before using it.** Before any calculation, say what the function or object stands for ("the loss as the height of the ground over each pair of weights") and what each kind of picture shows ("a contour map is the landscape seen from above; each ring joins points at the same height"). Never open a KP with a bare formula.
- **Cut everything that doesn't teach.** No boilerplate headings ("Why this is useful"), no filler, no repeated sentences, no summary of what you just said. _(Coherence principle: Mayer & Moreno 2003.)_
- `explain` is 150–300 words per KP. If it's longer, the KP holds two ideas: split it.
- Paragraphs of 1–3 sentences. Second person, plain British English.
- **Examples:** use the simplest example that shows the idea, and reuse it across KPs when that helps. The ML/house example belongs in "Where it shows up" and in problems, not in every definition.
- **Numbers:** choose them so every result is a whole number or a simple fraction, unless the point is the messy number.
- **Maths:** one display line per step, never several equations inside one sentence. In `aligned` blocks, one step per line.
- **Teach directly.** Explain, then practise. Don't make the learner discover the idea unaided _(Kirschner et al. 2006; Alfieri et al. 2011)_.

## 3. Diagrams

Every KP whose idea is spatial (directions, slopes, surfaces, arrows, splits, processes) has a diagram in **Picture it**. Write it as a fenced `svg` block (rules in `docs/CONTENT_FORMAT.md`):
- `viewBox` at most 640 wide; an `aria-label` that states what the diagram shows;
- show only what the text talks about, labelled in the diagram itself; no decoration;
- text at least 13px, `font-family="ui-sans-serif, system-ui, sans-serif"`;
- hex colours from the palette only: text `#171717`, muted `#737373`, lines `#d4d4d4`, green `#10b981`, amber `#f59e0b`, blue `#3b82f6`, red `#ef4444`. Use one colour per meaning, consistently across the lesson (e.g. gradient always blue, chosen direction always amber);
- compute coordinates, don't eyeball them: arrows must have the stated direction and relative lengths, and contour lines must be the stated function's level sets.

## 4. Problems

- Each KP: the `basics` MC, then ≥5 fixed problems or a template, covering difficulty 1, 2 and 3.
- Mix: recognition, computation (a parameterised template when there is arithmetic), misconception MC (each wrong option is a real mistake, with its own `feedback`), and application in a new setting.
- Every problem has a 1–3 sentence `solution` that says _why_. MC options are of similar length, with no "all of the above".
- Problems test this KP and earlier ones, never later ones.

## 5. Review before it ships

1. Run `pnpm content:check` and the content tests (`pnpm exec vitest run tests/content*.test.ts` or the full `pnpm test`).
2. **Self-check** each KP against §1–§3: all seven parts in order, general definition, clean numbers, diagram present and correct, no boilerplate, ≤300 words.
3. **Cold-reader review.** Give a separate agent, which hasn't seen your plan, only the rendered lesson text (YAML `explain`, `worked`, `summary` and the first two problems of each KP), the titles of the prerequisite lessons, and this prompt verbatim:

   > You are a motivated learner who knows only the prerequisite lessons listed. Read this lesson once, in order, as if seeing it for the first time. List every place where you (a) met a word, symbol or step you couldn't follow, (b) couldn't picture what was meant, (c) didn't see why a step was taken, (d) didn't know what you were learning or why it mattered, (e) met an example or object the lesson never introduced, (f) found a step title a beginner couldn't parse before reading that step, or (g) got bored or lost the thread. Quote the exact sentence for each. Then say, in two sentences, what you think the lesson's main idea is. Do not suggest rewrites and do not praise.

   Fix every item it raises, or note in the PR why it isn't a problem. If its two-sentence main idea doesn't match the objective, the lesson isn't clear yet: revise and review again.
4. Open the lesson in the running app (`pnpm dev`, Course → the lesson) and check each KP rendered: diagrams visible and readable, maths rendered, no part overflowing.

## Model lesson

`content/lessons/gradients.yaml` is the reference implementation of this skill.
