# Reviews and spaced repetition: design

## How Math Academy does it

Sources: mathacademy.com "How our AI works" and FAQ pages; Justin Skycak (Math Academy's chief architect), "Hierarchical Spaced Repetition (HSRS)" and *The Math Academy Way*.

1. **Three kinds of task: lessons, reviews and quizzes.** There's no separate practice block. Practice happens inside lessons and reviews.
2. **Every topic you learn goes on a spaced-repetition schedule.** Each successful review pushes the next one further out. A review done too early earns less credit, and one left overdue too long sends you backwards.
3. **Credit depends on how well you did.** Getting every question right counts for more than scraping a pass. A failed review or lesson counts against you and has to be done again.
4. **A quiz arrives about every 150 XP and covers a mix of recent topics.** It's timed and closed-book. The topic of every question you get wrong is scheduled for review straight away. Once those reviews are done, you can retake the quiz with different questions.
5. **A failed lesson comes back within a few days,** and its prerequisites are reviewed first.
6. **Implicit repetition (FIRe).** Doing an advanced topic counts, at a discount, as a review of the simpler topics it uses. A failure on a simple topic counts against the topics built on it. This lets new lessons replace many explicit reviews. It runs on a hand-built "encompassing" graph (which topics fully or partly *use* which), not the prerequisite graph. Skycak says running it on prerequisites gives wrong credit.
7. **Speed is set per student and per topic.** On topics you find hard, the schedule moves more slowly, and you only get credit from explicit reviews.
8. **Reviews are interleaved:** small doses of many topics, not one topic in a block.

## What ours does now (from the code)

- **A memory card per topic and dimension** (concept / maths / code). It uses FSRS with a 90% retention target and a 60-day maximum gap. The card is created the first time a topic reaches "assisted", which can happen on the first right answer inside a lesson.
- **Only a Review activity moves a card.** Step answers, quiz results and practice never do. So a missed quiz question doesn't bring its topic back sooner, and acing a quiz doesn't push the review out.
- **A review is one question.** One lucky guess counts as a full successful review.
- **"Practice" is filler.** Leftover session time goes to unseen questions from today's lessons and shaky older topics. It doesn't touch the review schedule.
- **No implicit credit.**

## Proposal: phase 1 (this PR)

1. **Remove the Practice block.** Leftover time goes to the next unlocked lesson. If there isn't one, the session ends early ("Done for today"). Math Academy's reasoning: reviewing early is wasted effort, and the time is better spent learning.
2. **Start a topic's cards when you pass its lesson quiz,** not mid-lesson. The quiz is the first repetition. For each dimension, all quiz questions right counts as Good, and any miss counts as Hard, due the next day. Lessons you've already completed keep their current cards.
3. **A failed quiz asks for a review before the retake.** For each step where you missed a question, you answer 3 practice questions on it. Then "Retake quiz" unlocks, with different questions.
4. **A review is a short task of 3 questions on one topic.** Each is one you haven't seen recently. Scoring: 3/3 with no hints is Good; 2/3, or any hint used, is Hard; 0–1 out of 3 fails the review (Again), so it comes back the next day and its gap restarts. Reviews in a session are interleaved across topics.
5. **Labels.** The header says "Review" with the topic name, e.g. "Review · Activation functions". "Activity N of M today" goes.
6. **Reviews tab.** It shows how many reviews are due today and per day for the next 7 days. Below that, every topic with its next review date and how well you know it. Due reviews come up in your next session.

## Phase 2 (later, separate design)

- **Implicit credit and penalties (FIRe-style).** Write an "encompasses" list with weights for the ~85 concepts. Passing a lesson or review then gives discounted credit to the topics it uses, and a failure brings forward the topics built on the failed one. With 85 topics the review load is still small, so it saves less now than it will later.
- **Mixed quizzes** across recent lessons, every N XP.
- **Timed quizzes,** if you want them.

## Decisions (approved)

1. After a failed quiz, the result card asks you to review each step where you missed a question, 3 practice questions per step. "Retake quiz" unlocks once those are done.
2. 3 questions per review.
3. If there's no lesson left to schedule, the session just ends early. Lessons whose quiz isn't passed yet are always scheduled first.
