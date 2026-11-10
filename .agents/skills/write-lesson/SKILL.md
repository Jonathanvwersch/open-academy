---

name: write-lesson
description: How to write or rewrite an Open Academy lesson (content/lessons/*.yaml and its exercises). Use for every new lesson and every lesson rewrite. It defines the evidence-based structure of each knowledge point, the diagram and number rules, and the cold-reader review a lesson must pass before it ships.
---

# Writing a lesson

A lesson teaches one concept as 2–4 **knowledge points** (KPs), one idea each. The file format is in `docs/CONTENT_FORMAT.md`. This skill covers _how to explain_. Every rule below is there to make a first-time reader understand. When a rule and clarity conflict, choose clarity and say why in the PR.

## How a lesson should sound

Write the way a good teacher talks while working through a problem at a whiteboard with one student. The learner should feel that a person is explaining something to them, not reading notes about it. Lessons written as compressed facts separated by colons and full stops are hard to follow, and they read as machine-written, so learners stop trusting them and skip to the questions.

Use full sentences that follow from each other. Words like "so", "but", "because" and "which means" show why each sentence comes after the last one; without them a paragraph reads like a list. Say "we" when you and the learner are doing something together ("we take a step downhill") and "you" when it's the learner's move. Describe things in the order you'd point at them on the board: first what we're looking at, then what it means. Use everyday names for what's on screen, such as "the orange arrow" rather than "the amber arrow", and "the step we take" rather than "the move". Save colons for introducing a list or a formula. When you build on an earlier lesson, say it the way a person would: "In the gradients lesson, we found that…".

Before you keep a paragraph, read it aloud. If a sentence would sound odd said to a friend sitting next to you, rewrite it until it doesn't. Clarity matters more than brevity: an extra sentence that makes the step obvious is worth its words, while a sentence that only restates the last one is not.

These pairs show the difference. Match the "after" voice.

<example>
Before:
**The question.** The gradients lesson ended with a direction: $-\nabla f$ is the steepest way down. Knowing a direction doesn't move you, though. Standing at a point, how do you turn it into an actual move to a lower point?

**Picture it.** Go back to the bowl $f(x,y)=x^2+2y^2$, seen from above as a contour map: each ring joins points of equal height, and outer rings are higher. At $P=(1.5,1)$ the height is $4.25$ and the gradient is $(3,4)$, the blue arrow pointing uphill. The amber arrow is the move: the gradient reversed and shrunk to a tenth, $-0.1\times(3,4)=(-0.3,-0.4)$. It lands at $(1.2,0.6)$, on a lower ring, where the height is $2.16$.

After:
In the gradients lesson, we found that $-\nabla f$ points in the steepest downhill direction. But knowing which way is downhill doesn't move us anywhere. If we're standing at a point, how far should we walk, and where do we end up?

Let's look at the bowl $f(x,y)=x^2+2y^2$ from above. Each ring joins points at the same height, and the outer rings are higher. We're standing at $P=(1.5,1)$, where the height is $4.25$. The blue arrow is the gradient, $(3,4)$, and it points uphill. To go downhill we turn it around, and so that we don't overshoot we take only a tenth of it, which gives $(-0.3,-0.4)$. That's the orange arrow. It takes us to $(1.2,0.6)$, on a lower ring, where the height is $2.16$.
</example>

<example>
Before:
**The idea.** Take a small step in the direction opposite the gradient, then repeat from where you land. For a model, the inputs of the loss are its weights and bias. Each input moves against its own slope: an input with a positive slope goes down, one with a negative slope goes up. This method is **gradient descent**.

After:
So the recipe is to work out the gradient where you're standing, take a small step the opposite way, and then do the same again from wherever you land. This is called **gradient descent**. You can also see it one input at a time. If an input's slope is positive, increasing that input would make the height go up, so we decrease it. If the slope is negative, we increase it.
</example>

<example>
Before:
This example takes one gradient-descent step on the bowl $f(x,y)=x^2+2y^2$ from $P=(1.5,1)$ with learning rate $\eta=0.1$.

1. **Find the gradient at $P$.**

After:
Let's take that step carefully, on the same bowl, starting from $P=(1.5,1)$ with a learning rate of $\eta=0.1$.

1. **Find the gradient at $P$.** The slopes of $x^2+2y^2$ are $2x$ and $4y$, so at $P$ they are $3$ and $4$.
</example>

<example>
Before:
**Common confusion.** “The weight with the biggest slope is the one that's most wrong.” No. Every slope shares the same error $e$; they differ only by their inputs.

After:
It's tempting to think the weight with the biggest slope must be the one that's most wrong. It isn't. Every slope here contains the same error, $e$, so the only thing that makes one bigger than another is its input. A weight attached to a large input gets a large slope, even though the mistake belongs to the whole prediction.
</example>

## 0. Plan before writing

1. Read the concept in `content/concepts/*.yaml` and the lessons of its prerequisites. List what the learner already knows (terms, symbols, results) and what they don't. Never use a term or symbol before the lesson that teaches it (`content/notation.yaml` enforces this).
2. Write down, in one line each:
   - the question the lesson answers;
   - the 2–4 ideas (one per KP);
   - the confusions a beginner will have, phrased as their own question ("Isn't the directional derivative just the gradient?").
3. Pick the **simplest case you can picture** for each idea, e.g. 2 inputs rather than 4, a hill rather than a loss surface, and numbers that come out clean ((3, 4) → 5, not 40√554).

## 1. How a lesson is laid out

A lesson isn't a form to fill in. Topics need different shapes, so treat the outline below as the usual order and leave out or rearrange parts when a topic is clearer that way. Two things never change: the learner knows what they're learning and why before they meet a formula, and every step ends with questions.

**The opening** (`where_this_fits`, shown as "What you're learning", 30–130 words). The app already shows the prerequisite lessons above it as "Before this" links, so don't list them again. Say in plain words what problem this lesson solves for the learner (for ML lessons, what it does for training a model), why what they know so far isn't enough, and then the lesson's steps as a short numbered list, one line per step. The `objective` is one plain sentence, "**Goal:** …".

**Each step** (a knowledge point) teaches one idea, usually in this order.

1. **What it is, in simple terms.** Start from something the learner already knows, and name the earlier lesson it came from ("In the gradients lesson, we found that…"). Then say what the new idea is in a sentence or two, before any notation. A short question that the idea answers is a good way in, because asking first prepares the learner for the answer (Schwartz & Bransford 1998).
2. **How it works.** Walk through the simplest case you can picture, with a diagram beside the words when the idea is spatial (see §3), because words beside a simple picture beat words alone (Mayer 2008; Butcher 2006). Then give the general definition with the term in **bold**, and the notation last, explaining each symbol in words as it appears. The definition must be general rather than phrased through the example ("a vector of partial derivatives, one per input", not "one per house weight"), because only the general form carries over to new problems (Fyfe et al. 2014; Kaminski et al. 2008).
3. **Examples** (`worked`, shown in a "Worked example" card). Work one example through with clean numbers, as described below. When the idea changes with a setting such as direction, size or sign, add a small table comparing cases from the same example, because seeing cases side by side builds understanding faster (Rittle-Johnson et al. 2015). If it isn't already obvious, finish with a sentence or two on where the idea is used in ML or robotics, built only from ideas already taught.

When beginners are likely to get the wrong idea, deal with it inside the explanation: describe the belief in words they might use, say plainly that it's wrong or only half right, and explain why, because naming a misconception and refuting it changes understanding more than ordinary explanation does (Tippett 2010). Do this only for a mistake that's genuinely likely, at most once per step.

Don't put labels such as "The question.", "Picture it." or "Common confusion." in front of paragraphs. They turn an explanation into a form, and the learner should read one continuous explanation.

**Worked examples.** Open with a sentence saying what we're about to work out and where we start. Number the steps, and start each with a short bold label saying what it does ("1. **Find each slope.**"). Follow the label with a sentence saying why we're doing it, then show the calculation as display maths, one step per line. Studying worked examples beats solving cold for beginners, and labelled steps help (Sweller & Cooper 1985; Atkinson et al. 2000).

**Questions at the end of each step** (`problems`, in order; the runner starts easy and steps up). Put the `basics` MC question first. Then add one self-explanation question about the worked example ("Why does step 2 use the dot product?"), written as an `mc` whose options are plausible reasons, each wrong one with its own `feedback` (Chi et al. 1989; Bisra et al. 2018; Aleven & Koedinger 2002). Knowledge-point problems can't be `explain` type; only the lesson `final` is. After that, go from partly worked to full and from easy to hard, with difficulty 1, 2 and 3 all present (Renkl & Atkinson 2003). The last problems use a new setting, such as a different function or a robot.

**Step titles.** Each knowledge point's `title` is shown under the lesson name while you work through it. Write it in plain words a beginner understands _before_ reading the step, saying what the step does ("Take one step downhill", "Multiply a matrix by a vector"). At most ~6 words. No slogans, no wordplay, and no term that only the step itself explains ("Step against the gradient" fails).

**The end of the lesson.**
- **summary:** sum the lesson up the way a teacher would at the end of a class. Use a short paragraph, or one sentence per step, that explains the whole idea again in plain words without adding anything new. Finish with the `**Next:**` line.
- **final:** one `explain` question that makes the learner connect the steps in their own words, because recalling beats rereading (Roediger & Karpicke 2006; Dunlosky et al. 2013). Give it 2–3 rubric criteria and an exemplar.

## 2. Writing rules

- **Each lesson stands on its own.** Introduce every example, object and set of numbers inside the lesson that uses it before using it. Never write "this house", "the model" or "the same data" for something set up only in another lesson. To build on an earlier lesson, name it and recap what it was in one sentence ("In the linear-regression lesson you predicted a house's price as $w\cdot x + b$; …").
- **Explain the setting before using it.** Before any calculation, say what the function or object stands for ("the loss as the height of the ground over each pair of weights") and what each kind of picture shows ("a contour map is the landscape seen from above; each ring joins points at the same height"). Never open a KP with a bare formula.
- **Cut everything that doesn't teach.** No boilerplate headings ("Why this is useful"), no filler, no repeated sentences, no summary of what you just said. _(Coherence principle: Mayer & Moreno 2003.)_
- `explain` is usually 150–380 words per KP. If it's longer, the KP holds two ideas: split it.
- Keep paragraphs short enough to read in one breath, usually two to four sentences, written in plain British English in the voice described in "How a lesson should sound".
- **Examples:** use the simplest example that shows the idea, and reuse it across KPs when that helps. The ML or house example belongs in the closing sentence about where the idea is used and in problems, not in every definition.
- **Numbers:** choose them so every result is a whole number or a simple fraction, unless the point is the messy number.
- **Maths:** one display line per step, never several equations inside one sentence. In `aligned` blocks, one step per line.
- **Teach directly.** Explain, then practise. Don't make the learner discover the idea unaided _(Kirschner et al. 2006; Alfieri et al. 2011)_.

## 3. Diagrams

Every KP whose idea is spatial (directions, slopes, surfaces, arrows, splits, processes) has a diagram where its simplest case is walked through. Write it as a fenced `svg` block (rules in `docs/CONTENT_FORMAT.md`):
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
2. **Self-check** each KP against "How a lesson should sound" and §1–§3: it says what the idea is before notation, the definition is general, the numbers are clean, the diagram is present and correct, there are no part labels or boilerplate, and it is ≤380 words.
3. **Cold-reader review.** Give a separate agent, which hasn't seen your plan, only the rendered lesson text (YAML `explain`, `worked`, `summary` and the first two problems of each KP), the titles of the prerequisite lessons, and this prompt verbatim:

   > You are a motivated learner who knows only the prerequisite lessons listed. Read this lesson once, in order, as if seeing it for the first time. List every place where you (a) met a word, symbol or step you couldn't follow, (b) couldn't picture what was meant, (c) didn't see why a step was taken, (d) didn't know what you were learning or why it mattered, (e) met an example or object the lesson never introduced, (f) found a step title a beginner couldn't parse before reading that step, (g) read a sentence a teacher wouldn't say out loud to a student (clipped, stiff, or strung together with colons), or (h) got bored or lost the thread. Quote the exact sentence for each. Then say, in two sentences, what you think the lesson's main idea is. Do not suggest rewrites and do not praise.

   Fix every item it raises, or note in the PR why it isn't a problem. If its two-sentence main idea doesn't match the objective, the lesson isn't clear yet: revise and review again.
4. Open the lesson in the running app (`pnpm dev`, Course → the lesson) and check each KP rendered: diagrams visible and readable, maths rendered, no part overflowing.

## Model lesson

`content/lessons/gradients.yaml` is the reference implementation of this skill's structure. Where its wording differs from "How a lesson should sound", follow the voice section.
