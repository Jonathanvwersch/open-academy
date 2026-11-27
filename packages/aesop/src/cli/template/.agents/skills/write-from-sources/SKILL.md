---
name: write-from-sources
description: Write or rewrite an Open Academy lesson from the learner's own sources (lecture notes, papers, textbook chapters in sources/). Use together with write-lesson whenever the pack has sources or the learner asks for lessons based on their material.
---

# Write from sources

The learner's material is the authority. The lesson teaches what the source teaches, in the order and notation the source uses, so it lines up with their course.

## Before writing
- Read `sources/index.yaml` and find the sections that cover the topic. Read them in full.
- Note the source's notation and definitions. Use them, even where another convention is more common.
- If the sources don't cover the topic, say so to the learner instead of filling the gap from memory.

## While writing
- Follow `.agents/skills/write-lesson/SKILL.md` for structure and voice.
- Every definition, formula and worked example must come from the sources or follow directly from them. Recompute every number.
- Don't copy long passages. Explain in your own words and keep quotes to a sentence.
- Questions test what the source teaches. Past exam or problem-sheet questions in the sources are good models; rewrite them rather than copying them.
- When a lesson teaches a reusable idea that later lessons can use, such as a rule, formula, named method or code call, add it to `notation.yaml` with this topic in `introduced_by`.

## Cite
Add the sources to the lesson:
```yaml
sources:
  - source: <source-id>
    section: "Chapter 3.2, pp. 41-45"
```
List every source section the lesson uses. In a pack with `grounded: true`, `academy check` fails for a lesson with no citations.

## After writing
Run a Prerequisite check in a new subagent or separate agent session that has seen neither the plan nor any earlier round. Never use the app's own API keys, such as `OPENAI_API_KEY` or the learner's tutor key, to run a reviewer. If you have no way to start a separate agent, stop and tell whoever gave you the task instead of reviewing the lesson yourself. Give the reviewer the output of `academy prereqs <concept-id>`, the full lesson text and every exercise in the lesson's exercise file, including all roles and recall questions. Use this prompt verbatim:

> Below is everything a learner has been taught before this topic, then the lesson and all of its questions. Go through each step, then each question. List every word, symbol, rule, formula, code call or fact the learner needs that is neither in the "taught" list nor explained earlier in this lesson. School maths (arithmetic, basic algebra, functions and graphs, powers, fractions) and basic Python count as known. Anything taught only under "Soft links" counts as not taught. For each item, quote where it is used, say whether it blocks the learner or only slows them, and say where it is taught if you know (another topic, a soft link only, or nowhere). Don't list anything the lesson teaches before using it. Don't suggest rewrites and don't praise.

Fix each item by teaching it in the lesson, adding a hard prerequisite with its recap line, or rewording the question. Add reusable ideas, such as rules, formulas, named methods and code calls, to `notation.yaml` with this topic in `introduced_by` so `academy check` catches later lessons that use them too early.
Run `academy check`. Tell the learner which sections each lesson came from, and anything in the sources you thought was wrong or unclear.
