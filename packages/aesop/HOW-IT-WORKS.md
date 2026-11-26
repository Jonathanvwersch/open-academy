# How Aesop works

This guide explains the rules of the Aesop engine.

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
- If the lesson stops again at the same step or an earlier step, the engine opens a review for each key prerequisite of that step. **[MA]** The lesson stays locked until those reviews are done.
- After the last step, the learner answers an "Explain it" written question.
- Then the learner takes the lesson quiz. A 1-step lesson gives 6 questions. A 2-step lesson gives 3 for each step. A 3- or 4-step lesson gives 2 for each step. **[Ours]**
- The pass mark is 80%. **[Ours]** If the learner fails, they practise each step that had a wrong answer, then take a new quiz.
- When the learner passes the quiz for the first time, the topic is complete and gets its first review card.
- If a saved question was removed from the course, keep the learner's past grades. Replace a pending step question through normal selection. In an open quiz, replace an unanswered question with an unused question from the topic if one exists. Otherwise drop that item. A saved quiz answer still counts. If no questions remain, discard the open quiz without recording a grade. The learner can start a new quiz using the current questions. **[Ours]**
- For a saved review activity, keep the questions that still exist. If none remain, use the normal question selection for its due review. If there are no eligible questions, let the learner continue without rescheduling the card. **[Ours]**

## 5. Mastery (`memory/mastery.ts`)

Each topic has a mastery state for each of its dimensions (conceptual, math, implementation, transfer). The states, from low to high, are:

`not_assessed` → `introduced` → `assisted` → `independent` → `retained`

- The first answer of any kind moves `not_assessed` to at least `introduced`. A strong first answer can go further, by the rules below.
- An answer is _independent_ when the learner used no hints, got it right first time, and the engine graded it (not an AI grader).
- 2 independent correct answers on different questions give `independent`.
- If the second independent answer comes 3 or more days after the first, the state becomes `retained`.
- An independent wrong answer moves `retained` down to `independent`, and `independent` down to `assisted`. `introduced` and `assisted` do not go down. A provisional `independent` state goes back to `introduced`.
- Hints reduce the credit for an answer. AI-graded and self-graded answers give at most half credit. **[Ours]**

## 6. Spaced reviews (`memory/fsrs.ts`)

The engine uses the FSRS algorithm (the `ts-fsrs` library) for spaced repetition. **[Ours]** Math Academy uses its own model. Its constants are not public, so we use FSRS.

- The target recall is 90%. The longest gap between reviews is 60 days. **[Ours]**
- Each review answer gets a rating:
  - **Again**: wrong.
  - **Hard**: correct, but with a hint, on the second try, with partial marks, or slower than the question's target time.
  - **Good**: correct, first try, no hint, in time.
- A review activity gives one rating for each topic. The rating is Good if every answer is correct, with no hint and in time. It is Hard if at least 2 of 3 answers are correct. Otherwise it is Again.
- FSRS uses the rating to set the next due date.
- Every dimension of an authored topic needs at least five review questions. Count questions with role `review`, `core`, `practice`, `transfer` or `basics`. Skip lesson-only questions and templates. **[Ours]**
- When a review card gets Again twice in a row, the engine brings the weakest eligible hard prerequisite card due now. If cards tie, choose the alphabetically first topic ID, then the alphabetically first dimension. **[Ours]**

### Learning speed (`memory/speed.ts`)

- Each learner has one speed per topic across all dimensions. **[Ours]**
- Count an answer when the learner submits it on the first attempt with no hints and a deterministic grader. **[Ours]**
- Count a tutor reply on the current lesson problem as a hint for speed evidence. Keep lesson credit and progress unchanged. **[Ours]**
- Count lesson problems, lesson quiz items, review answers, timed mixed quiz items, and other answers that meet the same rules. **[Ours]**
- Multiply the success count and trial count by 0.8 for each qualifying answer. Add 1 to the trial count. Add 1 to the success count for a fully correct answer. Count the answer once. **[Ours]**
- Use speed 1 until the learner has three qualifying answers. **[Ours]**
- Add 1.6 to the success count and 2 to the trial count. Divide the first result by the second to get the accuracy estimate. **[Ours]**
- At an accuracy of 0.8 or higher, add 5 times the difference from 0.8 to speed 1. Below 0.8, subtract 0.5 / 0.3 times the shortfall from speed 1. Limit speed to 0.5 through 2. Round it to two decimal places. **[Ours]**
- Keep the 2.0 cap as a safeguard. In practice, speed levels off at about 1.71 when a learner gets every qualifying answer right. **[Ours]**
- Keep speed evidence on its own topic. Use a population difficulty factor of 1. **[Ours]**
- Speed scales the progress of successful reviews. **[MA]**
- After a Good or Hard rating, multiply the raw FSRS interval by the topic's current speed. Include the first schedule after a lesson pass. Apply the next-local-day floor and the 60-day cap. Keep the FSRS stability and difficulty values. **[Ours]**
- Keep the normal recovery schedule for Again. **[Ours]**

## 7. FIRe credit through the graph (`memory/implicit-repetition.ts`, `graph/encompassing.ts`)

A review of an advanced topic also practises its prerequisites. **[MA]** The engine gives that practice to the prerequisite cards. Math Academy calls this Fractional Implicit Repetition (FIRe).

- A Good or Hard review moves credit _down_ to the prerequisites. Their due dates move later. **[MA]**
- When a prerequisite has speed below 1, switch off all positive FIRe credit to it. **[MA]**
- An Again review moves a penalty _up_ to the topics that build on this topic. Their due dates move earlier. **[MA]**
- Apply Again penalties at every speed. **[Ours]**
- The amount is the encompassing weight. **[MA]** With weight 0.4, the card moves 40% of the way to the date that a full review would give. **[Ours]**
- For positive credit, calculate the full review with the target topic's speed before applying the encompassing weight. Use the same speed rules in the planner. **[Ours]**
- A hard prerequisite with no weight in the course file gets 0.5. **[Ours]**
- Credit reaches indirect prerequisites. **[MA]** For each path, multiply the weights along the path. Use the largest result. **[Ours]**
- Keep the card's due date if it would move in the wrong direction. Skip cards that have yet to get their first review. **[Ours]**

Weights come from the questions. **[MA]** For each question, count the prerequisite's steps that the learner must use. Divide by the number of steps in the prerequisite's lesson. Take the mean for all questions. A second, independent pass checks each weight. `academy weights verify` checks the arithmetic. **[Ours]**

## 8. The daily planner (`planner/scheduler.ts`)

The planner makes one session for each day. The session has a time budget. The default is 60 minutes on weekdays, 300 on Saturday and 60 on Sunday. The learner can change these.

The planner adds work in this order:

1. **Timed mixed quiz.** Reserve time for the chosen lesson before checking if the pending quiz fits. Put the quiz first if it fits. Count its minutes against the budget. Count it as one of the 6 activities. **[Ours]**
2. **Chosen lesson.** Add the chosen lesson next, if there is one. Its time counts against the budget.
3. **Unfinished lessons.** Resume lessons in progress first. Review the key prerequisites that block a stopped lesson. **[MA]** Then add eligible lesson retries that have waited 2 or more days. **[Ours]**
4. **New lessons.** At most 2 new topics in one session. **[Ours]** The planner follows the course order. It spreads lessons across units and subjects. It does not put two easily confused topics on the same day. **[MA]**
5. **Ready retries.** Stopped lessons that can now be tried again.
6. **Reviews.** Due review cards, overdue cards first. Reviews can use at most 30% of the budget. **[Ours]** Overdue reviews can go past this limit.
7. **Other work.** Projects and papers, if time is left.

Rules that apply to the whole plan:

- **Lessons replace reviews.** A planned lesson can practise a due topic enough to move its due date past today. Then the planner does not add a separate review for that topic. **[MA]**
- **Early reviews.** The planner can add a review that is not yet due, but only if it covers 2 or more due topics that nothing else covers. **[MA]** (the number 2 is ours)
- **Mixed reviews.** The planner puts reviews into groups of up to 3 topics, taken in turn from each course. **[MA]** (the number 3 is ours)
- **Size.** A session has at most 6 activities. **[Ours]**
- **Replan.** When the learner finishes or skips work, the planner plans the rest of the day again. It does not repeat work that the learner finished.

## 9. Timed mixed quizzes (`quizzes/`)

### When the quiz appears

- Offer a quiz about every 150 eligible XP. **[MA]**
- Count XP from knowledge points, review answers, and completed lesson or review activities. Count mixed review activities as reviews. Exclude all other XP. **[Ours]**
- Subtract 150 XP from the eligible balance when the learner finishes an original timed quiz. Carry the excess into the next cycle. **[Ours]**
- Aim to offer the quiz when the eligible balance reaches 150 to 180 XP. The simulator checks this 30 XP window when enough topics qualify and the quiz fits. Eligibility continues past the window. **[Ours]**
- Keep at most one quiz pending. Leave lessons available when the quiz cannot run. **[Ours]**

### Which questions appear

- Mix topics from earlier study and recent study. **[MA]**
- Use only authored topics from completed lessons or effective confirmed placement credit. Exclude legacy placement grants. **[Ours]**
- Start each topic with weight 4 in the current course and weight 1 elsewhere. Divide its weight by 1 plus its previous quiz item count. Count items from originals and retakes. **[Ours]**
- Use a fixed seed to rank the topics by weight. Skip any pair where one topic encompasses the other. **[Ours]**
- Ask 8 questions from 8 topics. Use auto-graded multiple-choice, numeric or expression questions. Skip lesson-only questions. **[Ours]**
- Select two distinct questions per topic. Ask one now and keep the other in reserve for a retake. Skip prompts that appeared in earlier quizzes. Keep an original quiz's reserve prompts out of new quizzes if the learner missed any question. **[Ours]**
- Wait if fewer than 8 topics meet these rules. **[Ours]**
- Start at difficulty 2. Use the latest original quiz score to set the next difficulty. Raise it one level if the score exceeds 80%. Lower it one level if the score is below 80%. Keep it unchanged at 80%. Keep the level between 1 and 5. Prefer questions near that level. **[Ours]**

### Time, score and reviews

- Add the target times for the 8 questions. Use 90 seconds for each missing target time. Multiply the total by the learner's extra-time setting. The multiplier defaults to 1. Round planned minutes up. **[Ours]**
- Save the deadline when the learner starts. Keep it when the learner refreshes. Reject answers on the server at or after the deadline. Count late and unanswered questions as wrong. **[Ours]**
- Accept answers in question order. Measure each answer's time from the start or from the preceding answer. Allow the learner to finish when all answers arrive or time expires. **[Ours]**
- Keep hints, the tutor and lesson links out of the timed quiz. **[Ours]**
- Rate each wrong answer Again. Rate a correct answer Hard when its time exceeds the question's target. Rate other correct answers Good. Apply normal FIRe credit for Good. **[Ours]**
- Make a follow-up review due immediately for each missed topic. **[MA]**
- Make a follow-up review due immediately for each slow correct answer at every speed. Apply speed only when the quiz uses the FSRS due date. Skip suspended cards when the quiz rates, gives FIRe credit, or schedules reviews. **[Ours]**
- Divide the number of correct answers by 8 to get the score. Multiply planned minutes by the score and round to the nearest whole XP. Award the XP once. **[Ours]**

### Retake

- Offer an optional retake. **[MA]**
- Allow one retake if the learner missed at least one question and finished all follow-up reviews. Use the reserve questions on the same topics. A retake gives no XP and leaves the quiz cadence unchanged. **[Ours]**
- Keep the end-of-lesson quiz separate. **[Ours]**

## 10. Placement (`placement/`)

A new learner can take a placement test for a course. It has at most 16 questions. **[Ours]**

### The test

- The engine asks about the topic in the middle of the topics that are not yet decided. **[Ours]**
- A correct answer marks the topic as known, and also all its hard prerequisites. **[MA]**
- A wrong answer marks the topic as unknown, and also all the topics that build on it. **[MA]**

### Placement credit

Each known topic gets placement credit, stored as a grant. A grant has an origin and a state.

- A grant is _direct_ when the learner answered a question on that topic. **[Ours]**
- A grant is _inferred_ when only an answer on a later topic gave the credit. **[Ours]**
- A grant is _confirmed_ when the direct answers were correct, on time and without conflict. **[Ours]**
- A grant is _conditional_ when a correct answer was too slow. **[MA]**
- A grant is also _conditional_ when a hard prerequisite of the topic got a wrong answer. **[MA]**
- An inferred grant is always _conditional_. **[Ours]**
- A question without a target time is never too slow. **[Ours]**
- Each known topic gets `independent` mastery and a review card. **[Ours]**
- Conditional credit gives _provisional_ mastery. **[Ours]**
- One later independent correct answer on a conditional topic confirms its grant. **[Ours]**
- An independent answer uses no hints, is the first attempt, and is graded without AI. **[Ours]**
- An answer without a stored attempt still counts as evidence for its topic. **[Ours]**
- A topic with any confirmed grant stays confirmed. A later grant does not change this. **[Ours]**

### Withdrawal

A _withdrawn_ grant gives no credit.

- One independent wrong answer on a conditional topic withdraws its grant at once. **[MA]**
- A wrong review answer on a later topic does not withdraw credit by itself. **[Ours]**
- That answer queues a targeted review for each conditional key prerequisite of its step. **[Ours]**
- A failed targeted review withdraws the grant of that prerequisite. **[Ours]**
- Withdrawal also withdraws the conditional topics that build on that topic through hard prerequisites. **[MA]**
- Withdrawal never removes confirmed credit. **[Ours]**
- Withdrawal never removes a topic that has a lesson run. **[Ours]**
- One withdrawal changes everything below together. If one part fails, nothing changes. **[Ours]**

### After withdrawal

- A withdrawn topic does not count as complete. **[MA]**
- A withdrawn topic does not unlock the topics that build on it. **[MA]**
- The engine rebuilds its mastery from the answers that remain, without the placement answers. **[Ours]**
- Its review cards are suspended. The planner skips them until the learner completes the lesson. **[Ours]**
- New credit from a later placement test also ends the suspension. **[Ours]**
- The planner puts the topic back in the plan, in prerequisite order. **[MA]**
- Planned work that needs the topic is skipped. **[Ours]**
- A completed course that contains the topic opens again. **[Ours]**
- The course page tells the learner why the topic came back. **[Ours]**
- Course and placement pages show the current credit. **[Ours]**

### What withdrawal keeps

- Answers stay unchanged. **[Ours]**
- Review history stays unchanged. **[Ours]**
- XP stays unchanged. **[Ours]**
- The placement test record stays unchanged. **[Ours]**

## 11. XP and streaks (`progress/`)

- Lesson steps give XP as in section 4. Timed mixed quizzes use the rules in section 9. Other activities give XP equal to their planned minutes, times the score.
- The daily XP goal is the day's time budget.
- A day counts for the streak when the learner earns any XP that day, in their own time zone.

## 12. What the engine does not do

The engine does not use a database, HTTP or an AI model. The host app does these jobs:

- It saves learner data.
- It runs the AI grader for written answers.
- It runs the AI tutor (Fable).
- It runs the web pages.

The engine reads and writes mastery and review state through `LearnerStore`. `CoreStore` adds attempts, hint evidence, XP events, settings and course enrollments.

`SessionStore` adds sessions, activities and the facts the planner needs. The store limits the reads to recent attempts, recent completions and recent review logs. It reads the last answer for each recall question. The engine builds the planner state and selects the active session for the learner's local day.

`LessonStore` adds lesson runs, problems, quiz attempts, quiz items and flags for required reviews. The engine runs lessons and repairs saved questions that no longer exist. The host gives the engine the grade, the clock, random numbers and new IDs.

`PlacementReviewStore` adds diagnostic runs, placement grants, review logs and review card edits. The engine records graded exercise answers, completes reviews and withdraws placement credit.

`FlowStore` adds timed quiz runs, items and links to completed follow-up reviews. The engine offers and runs timed quizzes in `quizzes/`. Starting, answering and finishing a quiz, and starting its retake or follow-up reviews, use the same learner lock as session start.

A transaction gives the engine a store for that transaction. All its reads and writes use that store. If a transaction throws, its changes roll back. A nested transaction can roll back while the outer transaction continues.

The API store uses PostgreSQL. It locks the learner row when a flow asks for a learner lock. It locks the session row for progress and explicit replans. It locks the lesson run when a command changes a run or repairs a saved question. A problem answer also locks the problem row. The `memoryStore()` function keeps state in memory and runs transactions one at a time. A memory transaction store closes when its callback ends. A learner can earn XP only once for a given source key.

Starting placement locks the learner row. Answering a placement question locks the diagnostic run. Withdrawing placement credit rebuilds mastery and suspends review cards in one transaction.

## 13. How we check the engine

The simulator runs 7 simulated learners for 120 days each, through the real app. The learners follow fixed rules and use a fixed random seed. A fake grader marks written answers. No AI is used.

After every activity, the simulator checks 19 rules (P1–P19). Examples: no topic opens before its prerequisite chain is complete, every due review is planned or covered, and no session goes over its budget. Two runs of the same code must give the same result.
