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

## Cite
Add the sources to the lesson:
```yaml
sources:
  - source: <source-id>
    section: "Chapter 3.2, pp. 41-45"
```
List every source section the lesson uses. In a pack with `grounded: true`, `academy check` fails for a lesson with no citations.

## After writing
Run `academy check`. Tell the learner which sections each lesson came from, and anything in the sources you thought was wrong or unclear.
