---

name: write-lesson
description: How to write or rewrite an Open Academy lesson (content/lessons/*.yaml and its exercises). Use for every new lesson and every lesson rewrite. It defines the structure of a lesson and of each step, how lessons should sound, the diagram and number rules, and the cold-reader review a lesson must pass before it ships.
---

# Writing a lesson

A lesson teaches one concept. It opens by recapping what the learner needs and saying what the new idea is, then teaches it in 1–4 **steps** (knowledge points, KPs), as many as the topic needs, each ending with questions, and closes with a summary. The file format is in `docs/CONTENT_FORMAT.md`. This skill covers _how to explain_, and everything you need is in it. When a rule and clarity conflict, choose clarity and say why in the PR.

The structure comes from the way Khan Academy's best teaching articles are built. A learner first sees what they need to remember, then a plain answer to "what is this?", then why it's useful, then how it works, with a picture before the formula, then examples, then where it goes wrong, and finally a summary. Each part answers the question a learner naturally has at that point, so the lesson reads as one explanation rather than a form.

## 1. The shape of a lesson

```
recap            → "Recap" list: each prerequisite lesson, linked, with the one fact you need from it
where_this_fits  → "### What is X?": what it is in plain words, then why it's useful
knowledge_points → 1–4 steps, each: how this part works → examples → questions
                   (a "Limitations" section goes in the step it belongs to, when the topic has real ones)
final, summary   → one written question, then bullets restating the main results
```

### Recap (`recap`)

One item for each prerequisite that has an authored lesson (from the concept's `prereqs`). If there are none, leave `recap` out: the lesson opens on "What is X?" and introduces everything it uses itself. Each item gives the one fact from that lesson that this lesson relies on, in a sentence or two of plain words (at most 40 words). The app shows them as a "Recap" list, with each title linked to its lesson.

The recap is what lets a lesson build on earlier lessons and still stand on its own. The learner sees exactly what they're expected to remember, and can follow the link if they've forgotten it. So write the fact itself ("The derivative is the slope of a function at a point: how fast its output changes as its input changes."), not a description of the earlier lesson ("We studied derivatives."). Include a symbol only if this lesson uses it, and say what it means.

### What it is, and why (`where_this_fits`, 30–130 words)

Start with a `###` heading that asks the question, "### What is the chain rule?", and answer it straight away in a sentence or two of plain words. The first sentence is a definition a beginner can follow, often tied to something they already know:

- "The dot product is a way of multiplying two vectors that gives a single number."
- "Like the dot product, the cross product is an operation between two vectors."

Then say why the idea is useful: what problem it solves, and why what the learner already knows isn't enough. This is the paragraph that makes the learner want the rest of the lesson. Keep it in words. A very small example is fine if it makes the problem obvious, but save the main example, the diagram and the general formula for the steps, because the learner hasn't been shown how to read them yet.

The opening must not start with an example, a scenario or a formula ("Consider $f(x)=x^2$…", "A model starts with poor weights…"). The learner should know what the lesson is about by the end of the first sentence.

The `objective` is one plain sentence, "**Goal:** …", describing what the learner will be able to do. Learners don't see it: it's what you write the lesson to and what the cold-reader's main idea is checked against, so "What is X?" must do the job of telling the learner what they're about to learn.

### The steps (`knowledge_points`)

Each step teaches one part of the idea, and the steps go in the order the learner needs them: usually the basic mechanism first, then the setting that controls it, then how it applies to a model, then how it's used repeatedly or at scale. Split the `explain` into 2–4 short sections, each with a `###` heading that names what's in it ("Walking downhill", "Three step sizes on one curve", "Where the limit is"). A reader skimming the headings should be able to see the argument. Like step titles, these headings use plain words a beginner understands before reading the section ("Three step sizes on one curve", not "Stability").

Within a step, follow this order. Leave out a part that the idea doesn't need.

1. **Where we are.** Open with a sentence or two connecting to what the learner already has, from the opening, the recap or the previous step, and say what this step adds. Ask the question the step answers if that helps ("But how big should each step be?").
2. **How it works, with the simplest case you can picture.** Describe the picture first, in the order you'd point at it on a whiteboard, with a diagram when the idea is spatial (§4). Use clean numbers.
3. **The definition and the formula.** Name the idea in **bold**, in a general sentence ("a vector of partial derivatives, one for each input", not "one for each house weight"), because only the general form carries over to new problems. Then give the formula and say what each symbol means in words. A general formula may use symbols for the general case, such as $x_j$ and $w_j$ for "the $j$th input and its weight", even when the lesson's example has only one input, as long as the text says in words what they stand for. Work the example itself on the simplest case.
4. **Examples that show behaviour.** When the idea depends on a setting, such as a size, a sign, a direction or a starting point, show 2–3 cases from the same example side by side, as a bulleted list or a small table. Each case should show something the others don't (one converges, one overshoots, one diverges).
5. **Limitations,** when the topic has real ones, in their own section headed "Limitations" or by the problem itself ("Getting stuck in a valley"). Say what goes wrong, show it on a simple case, and say what people do about it. Leave this out for topics with no real limits.
6. **Be careful,** only for a trap a beginner will really fall into. Start with "Be careful…", say what the learner might think, that it's wrong, and why.

Then the `worked` example, then the questions.

**Worked example** (`worked`, shown in a "Worked example" card). Open with a sentence saying what we're about to work out and from where. Number the steps, start each with a short bold label saying what it does ("1. **Find each slope.**"), follow the label with a sentence saying why, then show the calculation as display maths. End with a sentence on what the result shows. The worked example usually carries out a calculation that the `explain` set up, using the same numbers. That's intended, not repetition: let the `explain` describe what happens and why, and leave the full arithmetic to the worked example, so the learner never reads the same calculation twice.

**Code** (when the concept's objective includes implementing the idea). Put a short, runnable code block (Python unless the course says otherwise) at the end of the `worked` example of the step that implements it, after the calculation by hand, and use the same numbers so the learner can match the two. Before the block, explain in a sentence any syntax a learner new to the language might not know. Show what it prints in a comment at the end, and run it to check that it prints exactly that.

**Questions at the end of each step** (`problems`, in order; the runner starts easy and steps up). Put the concept multiple-choice question first; keep `role: basics` as its content marker, but label and count it like every other question. Then add one self-explanation question about the worked example ("Why does step 2 use the dot product?"), written as an `mc` whose options are plausible reasons, each wrong one with its own `feedback`; set `lesson_only: true` on that question. Every other problem must stand alone, because it can appear in the quiz or in a spaced review weeks later: include the numbers and context it needs, without referring to the worked example, a step number, the lesson, or a picture. Knowledge-point problems can't be `explain` type; only the lesson `final` is. Each step needs at least five problems across difficulties 1, 2 and 3, because those questions supply both step practice and the lesson quiz. Go from partly worked to full and from easy to hard. The last problems use a new setting, such as a different function or a robot.

**Step titles.** Each step's `title` is shown under the lesson name while the learner works through it. Write it in plain words that a beginner understands _before_ reading the step, saying what the step does ("Take one step downhill", "Multiply a matrix by a vector"). At most about 6 words. No slogans, no wordplay, and no term that only the step itself explains ("Step against the gradient" fails).

### The end (`final`, `summary`)

- **final:** the "Explain it" self-check before the quiz. It is one `explain` question that makes the learner connect the steps in their own words, because recalling beats rereading. The learner sees the model answer and marks their own work, so it is not part of the quiz score. Give it 2–3 rubric criteria and an exemplar.
- **summary:** 3–4 bullets that restate the main results, each a complete sentence a learner could revise from, formula included where there is one. Add nothing new. Finish with the `**Next:**` line saying what the next lesson does with this idea.

## 2. How a lesson should sound

Write the way a good teacher talks while working through a problem at a whiteboard with one student. The learner should feel that a person is explaining something to them, not reading notes about it. Lessons written as compressed facts separated by colons and full stops are hard to follow, and they read as machine-written, so learners stop trusting them and skip to the questions.

Use full sentences that follow from each other. Words like "so", "but", "because" and "which means" show why each sentence comes after the last one; without them a paragraph reads like a list. Say "we" when you and the learner are doing something together ("we take a step downhill") and "you" when it's the learner's move. Describe things in the order you'd point at them on the board: first what we're looking at, then what it means. Use everyday names for what's on screen, such as "the orange arrow" rather than "the amber arrow". Save colons for introducing a list or a formula. When you build on an earlier lesson, say it the way a person would: "In the derivatives lesson, we found that…".

Keep paragraphs short, usually one to three sentences, but keep the connecting words so that each paragraph follows from the last. Asking the reader a question and answering it in the next sentence is a good way to move to the next point.

Don't use contrast lines to sound insightful: "X, not Y", "it's not just X, it's Y", "rather than merely…". They read as machine-written. Say what the thing is or does. Contrast only to correct a mistake a learner actually makes, as in a common-confusion section.

Before you keep a paragraph, read it aloud. If a sentence would sound odd said to a friend sitting next to you, rewrite it until it doesn't. Clarity matters more than brevity: an extra sentence that makes a step obvious is worth its words, while a sentence that only restates the last one is not.

These pairs show the difference. Match the "after" versions.

<example>
An opening. Before:
A model has to combine many measurements into one number. In the vectors lesson, $\mathbf a=(2,1)$ and $\mathbf b=(3,4)$ were arrows. Here $\mathbf a\cdot\mathbf b=2\times3+1\times4=10$. We'll build it in three steps:

After:
### What is the dot product?

The dot product is a way of multiplying two vectors that gives a single number. You multiply the matching entries and add the results up.

It's useful because so much of machine learning is adding up weighted inputs. A model that predicts a house's price multiplies each measurement by its own weight and adds them up, and that total is exactly a dot product. The same number also tells us how closely two vectors point the same way.
</example>

<example>
Explaining a picture. Before:
**Picture it.** The curve $f(x)=x^2$. At $x=3$ the tangent is the move: slope $6$, a nudge of $0.1$ lifts the output by $0.6$.

After:
Let's look at the curve $f(x)=x^2$ near $x=3$. If we nudge $x$ from $3$ to $3.1$, the output goes from $9$ to $9.61$, so it rises by about $0.6$, which is six times the nudge. That six is the slope of the curve at $x=3$. The straight line that just touches the curve there, the tangent, has the same slope.
</example>

<example>
Starting a worked example. Before:
This example computes $\mathbf a\cdot\mathbf b$ for $\mathbf a=(2,1)$, $\mathbf b=(3,4)$.

1. **Products.**

After:
Let's work out the dot product of $\mathbf a=(2,1)$ and $\mathbf b=(3,4)$.

1. **Multiply the matching entries.** The dot product pairs each entry with the one in the same place, so the first entries give $2\times3=6$ and the second give $1\times4=4$.
   </example>

<example>
A caveat. Before:
**Common confusion.** "A big value means a big slope." No. Slope measures change, not size.

After:
Be careful not to read a big value as a big slope. The slope says how fast the output is changing, not how large it is. The curve $f(x)=10-x^2$ reaches its largest value, $10$, at $x=0$, and that's exactly where it's flat, with a slope of $0$.
</example>

## 3. Writing rules

- **Each lesson stands on its own.** Introduce every example, object and set of numbers inside the lesson before using it. Never write "this house", "the model" or "the same data" for something set up only in another lesson. Anything the lesson needs from an earlier one goes in the recap, or is restated where it's used.
- **Explain the setting before using it.** At a change of example, first connect to the question the learner is trying to answer, then introduce what we're doing and why that example helps. A step can appear on its own in the learner app, so its opening must orient the reader without relying on the full lesson being visible. For example, before "each die stands for one small effect", explain that we're exploring why random contributions add up to a bell shape by rolling dice and adding their results. Before any calculation, say what the function or object stands for ("think of the loss as the height of the ground") and what each kind of picture shows ("a contour map is the landscape seen from above; each ring joins points at the same height"). Never open a step with a bare formula.
- **No part labels or boilerplate.** Never write "The question.", "Picture it.", "The idea.", "Common confusion." or a heading like "Why this is useful". Headings name the content. Cut filler, repeated sentences and summaries of what you just said.
- **Never use a term or symbol before the lesson that teaches it** (`content/notation.yaml` enforces this).
- `explain` is 150–380 words per step, and `pnpm content:check` rejects more than 380. If a step needs more, it usually holds two ideas: split it. In a rewrite, where the step IDs are fixed, make room in this order: cut repetition and filler, then move arithmetic into the `worked` example, then shorten the examples. Keep every sentence a learner needs to follow the argument.
- **Numbers:** choose them so every result is a whole number, a simple fraction or a short decimal (one or two places, such as $0.1$ or $2.16$), unless the point is the messy number.
- **Maths:** in the `explain`, put each key formula on its own display line, and never pack several equations into one sentence. In a worked example, each numbered step has at most one display line. In `aligned` blocks, one step per line.
- **Use one running example** across the steps when you can, so the learner isn't learning a new setting each time. When a step needs a different example (a curve instead of a surface, a model instead of a function), connect it to the last one in a sentence ("Along the line $y=0$, the bowl is just $x^2$"). Mention ML or robotics where it shows why the idea matters, not as a required paragraph.
- **Teach directly.** Explain, then practise. Don't make the learner discover the idea unaided.

## 4. Diagrams

Every step whose idea is spatial (directions, slopes, surfaces, arrows, splits, processes) has a diagram where its simplest case is walked through. Write it as a fenced `svg` block (rules in `docs/CONTENT_FORMAT.md`):
- `viewBox` at most 640 wide; an `aria-label` that states what the diagram shows;
- show only what the text talks about, labelled in the diagram itself; no decoration;
- text at least 13px, `font-family="ui-sans-serif, system-ui, sans-serif"`;
- hex colours from the palette only: text `#171717`, muted `#737373`, lines `#d4d4d4`, green `#10b981`, amber `#f59e0b`, blue `#3b82f6`, red `#ef4444`. Use one colour per meaning, consistently across the lesson (e.g. gradient always blue, chosen step always amber, which the text calls orange);
- compute coordinates, don't eyeball them: arrows must have the stated direction and relative lengths, and contour lines must be the stated function's level sets.

## 5. Problems

- Each step: a concept MC first (marked `role: basics` in content but labelled like every other question), then at least five problems across difficulties 1, 2 and 3.
- Mix: recognition, computation (a parameterised template when there is arithmetic), misconception MC (each wrong option is a real mistake, with its own `feedback`), and application in a new setting.
- Every problem has a 1–3 sentence `solution` that says _why_. MC options are of similar length, with no "all of the above".
- Problems test this step and earlier ones, never later ones.
- In a rewrite, keep every existing problem ID and its correct answer, so learners' progress and reviews carry over; improve the wording freely, and reword problems to use the lesson's terms and examples. Never delete or repurpose an existing problem. When the rewrite adds a section that no existing problem tests, such as a new limitation, add a new problem with a new ID at the end of that step's list.

## 6. Plan before writing

1. Read the concept in `content/concepts/*.yaml` and the lessons of its prerequisites. List what the learner already knows (terms, symbols, results) and what they don't.
2. Write down, in one line each:
   - the plain-words answer to "what is it?";
   - why it's useful, and why what the learner already knows isn't enough;
   - the one fact needed from each prerequisite (the recap);
   - the 1–4 steps, in the order the learner needs them;
   - the real limitations, if any, and the traps a beginner will fall into, each written as the wrong thought they'd have ("Isn't a zigzag a sign it's failing?"). In the lesson, each trap becomes a "Be careful…" sentence (§1).
3. Pick the **simplest case you can picture** for each step, e.g. 2 inputs rather than 4, and numbers that come out clean ((3, 4) → 5, not 40√554).

## 7. Review before it ships

1. Run `pnpm content:check` and the content tests (`pnpm exec vitest run apps/api/tests/content/*.test.ts` or the full `pnpm test`).
2. **Self-check** against §1–§4. The recap gives facts. The opening says what the idea is in its first sentence, then why it's useful. Each step follows the order above, with content headings, a general definition, clean numbers and a correct diagram. Limitations appear where they exist. There are no part labels, and each `explain` is ≤380 words.
3. **Cold-reader review.** The reader is a new subagent or child Devin session that has seen neither your plan nor any earlier round. Never use the app's own API keys (such as `OPENAI_API_KEY`, the learner's tutor key) to run a reviewer. If you have no way to start a separate agent, stop and tell whoever gave you the task rather than reviewing the lesson yourself. Give the reader:
   - only the rendered lesson text: recap, `where_this_fits`, each step's `explain` and `worked`, `summary`, and the first two problems of each step. "First two problems" means the first two IDs in the knowledge point's `problems` list, with their prompts and options. Replace each diagram with its `aria-label`;
   - the 1280px screenshots of the lesson (see item 4 below), so it can see the diagrams (take them before the first round). If the reader can't view images, items saying it couldn't picture a diagram are about the setup, not the lesson: check those against the screenshot yourself;
   - the titles of the prerequisite lessons;
   - and this prompt verbatim:

   > You are a motivated learner who knows only the prerequisite lessons listed. Read this lesson once, in order, as if seeing it for the first time. List every place where you (a) met a word, symbol or step you couldn't follow, (b) couldn't picture what was meant, (c) didn't see why a step was taken, (d) didn't know what you were learning or why it mattered, (e) met an example or object the lesson never introduced, (f) found a step title a beginner couldn't parse before reading that step, (g) read a sentence a teacher wouldn't say out loud to a student (clipped, stiff, or strung together with colons), or (h) got bored or lost the thread. Quote the exact sentence for each. Then say, in two sentences, what you think the lesson's main idea is. Do not suggest rewrites and do not praise.

   Fix every item it raises, or note why it isn't a problem. If its two-sentence main idea doesn't match the objective, the lesson isn't clear yet: revise and review again. After substantial fixes, run a new round with a new reader. Stop when a round raises nothing new under (a)–(e) and its main idea matches the objective, or after three rounds. Three rounds is a hard cap: after round 3, fix the clear errors it found, don't start a fourth round, and mark those fixes as not re-reviewed. In the PR, or in your final report if you aren't opening one, list each item you didn't fix and why, plus any fixes made after the last round.
4. Open the lesson in the running app (`pnpm dev`, Course → the lesson) and check each step rendered: recap links work, diagrams are visible and readable, and maths is rendered. Check that nothing overflows at 1280px and 390px wide: the page has no horizontal scrollbar, and no table, diagram or display equation sticks out past the lesson column (a wide equation may scroll inside its own box).

Every lesson in `content/lessons/` has been rewritten with this skill. `content/lessons/gradient-descent.yaml` is the reference lesson. Where any lesson differs from this skill, follow the skill.
