---
name: plan-course
description: Plan a course in an Open Academy pack - the topics, their prerequisites and the units - before any lesson is written. Use when asked to create a course or a subject, or to add a batch of topics.
---

# Plan a course

A course is a path through a graph of topics. Get the graph right first; lessons are cheap to rewrite, a wrong graph is not.

## 1. Find out what the learner wants
- What they want to be able to do at the end, in one sentence.
- What they already know. Topics they know become prerequisites outside the course, or are left out.
- Any sources they have (`sources/index.yaml`). If there are sources, the course follows their scope and order unless that breaks a prerequisite.

## 2. List the topics
- One topic is one idea that can be taught in a 10-20 minute lesson and checked with a few questions. Split anything bigger.
- Name topics by the idea ("Dot product"), not by an activity ("Practising dot products").
- Aim for 10-30 topics per course. A subject can have several courses.

## 3. Draw the prerequisites
- `requires` lists only hard prerequisites: topics the lesson cannot be understood without. "Helpful background" is not a prerequisite.
- No cycles. If two topics seem to need each other, one of them is really two topics.
- Every topic except the first few should require something. A topic with no prerequisites deep in a course is usually a missing edge.
- Soft links (`strength: soft` in a topic's `prereqs`) are background that helps but doesn't block. Use them for "useful to have seen", never to hide a hard dependency.
- If a topic is easily confused with another (two methods that solve the same problem in similar ways, such as RLHF and DPO), list it under `confused_with` so the two are never learned on the same day.

### Check every link before you create anything
For each topic, write one line listing every idea, term and symbol its lesson will use. For each one, name where the learner learns it: this topic, or a topic in its `requires` chain (direct or indirect). Anything without an answer is a missing link: add the topic that teaches it to `requires`, or teach it in this topic.

Then go the other way. For each `requires` entry, name what the lesson actually uses from it. If nothing, remove it: every hard link keeps the topic locked until that topic is done.

New symbols and terms go in `notation.yaml`, with `introduced_by` set to the topic that teaches them, so `academy check` catches any lesson that uses one too early. A new pack starts with common maths notation (Σ, ℝⁿ, ∂, limits and so on) whose `introduced_by` is empty. Fill it in when a topic teaches one.

## 4. Group into units
- 3-8 topics per unit, in an order where every prerequisite comes first.
- Each unit has a title that says what the learner can do after it.
- When a pack has multiple subject areas, add ordered `subjects` to `curriculum.yaml` and set each course's `subject` to one of those IDs.

## 5. Create it with the CLI
```
academy new course <course-id> --title "<title>"
academy new topic <topic-id> --title "<title>" --domain <domain> --requires a,b --course <course-id> --unit <n>
```
Then run `academy check` and fix every issue. Read its warnings too. They flag a link that looks missing (a topic deep in a course with no prerequisites), a course where every topic waits on the one before it, and a course whose first unit needs a later course in the same subject. Fix each one, or be able to say why it's right.

## 6. Show the plan
Before writing lessons, show the learner the units and topics in a short list and ask if anything is missing or already known.
