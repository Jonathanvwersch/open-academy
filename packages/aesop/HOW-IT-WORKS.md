# How Aesop works

This guide explains the rules of the Aesop engine. It uses the Simplified Technical English style (ASD-STE100): short sentences, active voice, one idea per sentence.

Each rule has a source tag:

- **[MA]**: the rule comes from _The Math Academy Way_ or mathacademy.com.
- **[Ours]**: Math Academy does not publish this rule or number. We chose it.

When you change an engine rule, update this guide in the same pull request.

## 1. Terms

- **Topic**: one unit of knowledge, for example "Partial derivatives". Each topic has one lesson.
- **Step**: one part of a lesson. A lesson has 1 to 4 steps. **[Ours]**
- **Prerequisite**: a topic that a learner must know before another topic. A prerequisite is _hard_ or _soft_. Only hard prerequisites block.
- **Key prerequisite**: a prerequisite that one step uses directly.
- **Encompassing weight**: a number from 0 to 1. It tells how much of a prerequisite a topic's questions practise.
- **Review card**: the memory state of one topic for one learner. It holds the next due date.
- **Session**: the work that the planner gives a learner for one day.

## 2. Course files (`course/`)

A course is a folder of YAML files. The engine loads the folder and checks it.

- `concepts/*.yaml` lists the topics. Each topic lists its prerequisites and its encompassing weights.
- `lessons/*.yaml` holds one lesson for each topic. Each step lists its key prerequisites.
- `exercises/*.yaml` holds the questions.
- `courses/*.yaml` puts topics into units, in the order that the learner sees them.

The check stops a course that has a missing topic, a prerequisite cycle, or a question for a topic that does not exist.

Topic IDs are global. A topic in one course can use a topic from a different course as a prerequisite.

## 3. Unlocking (`graph/`)

A topic unlocks only when its full chain of hard prerequisites is complete. **[MA]** The engine checks every level of the chain, not only the direct prerequisites.

A prerequisite is complete when one of these is true:

- The learner completed its lesson.
- The learner has no lesson run for it, and placement or practice gave it at least "assisted" mastery.

When a learner starts a course, the engine also adds the prerequisites from other courses. These are the course's _foundations_. The learner learns them first, in prerequisite order.

## 4. Lessons (`lessons/`)

The learner does the steps in order. Each step has a worked example, then questions.

- A step passes after 2 correct answers in a row. **[MA]** (the number 2 is ours)
- Questions get harder after a correct answer and easier after a wrong answer.
- A step earns 10 XP if it passes in 2 questions, 9 in 3, 8 in 4 and 7 in 5 or more. **[Ours]**
- After 3 wrong answers on one step, the lesson stops. **[MA]** (the number 3 is ours) The learner can try the lesson again the next day.
- If the lesson stops again at the same step or an earlier step, the engine opens a review for each key prerequisite of that step. **[MA]** The engine brings the weakest prerequisite card due now. The lesson stays locked until those reviews are done.
- After the last step, the learner answers an "Explain it" written question.
- Then the learner takes the lesson quiz. A 1-step lesson gives 6 questions. A 2-step lesson gives 3 for each step. A 3- or 4-step lesson gives 2 for each step. **[Ours]**
- The pass mark is 80%. **[Ours]** If the learner fails, they practise each step that had a wrong answer, then take a new quiz.
- When the learner passes the quiz for the first time, the topic is complete and gets its first review card.

## 5. Mastery (`memory/mastery.ts`)

Each topic has a mastery state for each of its dimensions (conceptual, math, implementation, transfer). The states, from low to high, are:

`not_assessed` → `introduced` → `assisted` → `independent` → `retained`

- An answer is _independent_ when the learner used no hints, got it right first time, and the engine graded it (not an AI grader).
- 2 independent correct answers on different questions give `independent`.
- If the second independent answer comes 3 or more days after the first, the state becomes `retained`.
- An independent wrong answer moves the state down one level.
- Hints reduce the credit for an answer. AI-graded and self-graded answers give at most half credit. **[Ours]**

## 6. Spaced reviews (`memory/fsrs.ts`)

The engine uses the FSRS algorithm (the `ts-fsrs` library) for spaced repetition. **[Ours]** Math Academy uses its own model. Its constants are not public, so we use FSRS.

- The target recall is 90%. The longest gap between reviews is 60 days. **[Ours]**
- Each review answer gets a rating:
  - **Again**: wrong.
  - **Hard**: correct, but with a hint, on the second try, with partial marks, or slower than the question's target time.
  - **Good**: correct, first try, no hint, in time.
- FSRS uses the rating to set the next due date.

## 7. FIRe credit through the graph (`memory/implicit-repetition.ts`, `graph/encompassing.ts`)

A review of an advanced topic also practises its prerequisites. **[MA]** The engine gives that practice to the prerequisite cards. Math Academy calls this Fractional Implicit Repetition (FIRe).

- A Good or Hard review moves credit _down_ to the prerequisites. Their due dates move later.
- An Again review moves a penalty _up_ to the topics that build on this topic. Their due dates move earlier.
- The amount is the encompassing weight. With weight 0.4, the card moves 40% of the way to the date that a full review would give.
- A hard prerequisite with no weight in the course file gets 0.5. **[Ours]**
- For a prerequisite two or more levels down, the engine multiplies the weights along the path and uses the largest result. **[MA]** (the method is ours)
- The engine never moves a card in the wrong direction, and never changes a card that has not had its first review.

Weights come from the questions. For each question, count the prerequisite's steps that the learner must use. Divide by the number of steps in the prerequisite's lesson. Take the mean for all questions. A second, independent pass checks each weight. `academy weights verify` checks the arithmetic.

## 8. The daily planner (`planner/scheduler.ts`)

The planner makes one session for each day. The session has a time budget. The default is 60 minutes on weekdays, 300 on Saturday and 60 on Sunday. The learner can change these.

The planner adds work in this order:

1. **Chosen lesson.** If the learner chose a lesson, it goes in first. Its time counts against the budget.
2. **Unfinished lessons.** A lesson in progress, or a stopped lesson that has waited 2 or more days for its retry. **[Ours]**
3. **New lessons.** At most 2 new topics in one session. **[Ours]** The planner follows the course order. It spreads lessons across units and subjects. It does not put two easily confused topics on the same day. **[MA]**
4. **Ready retries.** Stopped lessons that can now be tried again.
5. **Reviews.** Due review cards, overdue cards first. Reviews can use at most 30% of the budget. **[Ours]** Overdue reviews can go past this limit.
6. **Other work.** Projects and papers, if time is left.

Rules that apply to the whole plan:

- **Lessons replace reviews.** A planned lesson can practise a due topic enough to move its due date past today. Then the planner does not add a separate review for that topic. **[MA]**
- **Early reviews.** The planner can add a review that is not yet due, but only if it covers 2 or more due topics that nothing else covers. **[MA]** (the number 2 is ours)
- **Mixed reviews.** The planner puts reviews into groups of up to 3 topics, taken in turn from each course. **[MA]** (the number 3 is ours)
- **Size.** A session has at most 6 activities. **[Ours]**
- **Replan.** When the learner finishes or skips work, the planner plans the rest of the day again. It does not repeat work that the learner finished.

## 9. Placement (`placement/`)

A new learner can take a placement test for a course. It has at most 16 questions. **[Ours]**

- The engine asks about the topic in the middle of the topics that are not yet decided.
- A correct answer marks the topic as known, and also all its hard prerequisites. **[MA]**
- A wrong answer marks the topic as unknown, and also all the topics that build on it. **[MA]**
- At the end, each known topic gets `independent` mastery, marked _provisional_, and a review card.
- One independent wrong answer later on a provisional topic removes that credit.

Phase 4 will add the full Math Academy rule. Borderline credit will be withdrawn when the learner struggles on topics that build on it.

## 10. XP and streaks (`progress/`)

- Lesson steps give XP as in section 4. Other activities give XP equal to their planned minutes, times the score.
- The daily XP goal is the day's time budget.
- A day counts for the streak when the learner earns any XP that day, in their own time zone.

## 11. What the engine does not do

The engine does not use a database, HTTP or an AI model. The host app does these jobs:

- It saves learner data.
- It runs the AI grader for written answers.
- It runs the AI tutor (Fable).
- It runs the web pages.

## 12. How we check the engine

The simulator runs 7 simulated learners for 120 days each, through the real app. The learners follow fixed rules and use a fixed random seed. A fake grader marks written answers. No AI is used.

After every activity, the simulator checks 19 rules (P1–P19). Examples: no topic opens before its prerequisite chain is complete, every due review is planned or covered, and no session goes over its budget. Two runs of the same code must give the same result.
