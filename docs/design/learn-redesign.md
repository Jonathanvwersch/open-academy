# Academy redesign: Math Academy-style structure

Sources: mathacademy.com/how-it-works and /pedagogy; the Math Academy course page he linked; Khan Academy Help Center ("How do Mastery levels work?", "Course and Unit Mastery"); Skycak, "Hierarchical Spaced Repetition (FIRe)". Anything marked *(ours)* is my own choice, not taken from those sources.

## What they do that we don't
| | Math Academy / Khan | Academy today |
|---|---|---|
| Unit of learning | Small **topic**, split into 2–4 **knowledge points**. Each point is a short explanation, a fully worked example, then practice problems | One long lesson page with one check, then a separate practice list |
| Advancing | **2 right in a row** moves you to the next point. Otherwise you get more problems, up to 5. Every problem has a worked explanation | You can click past the check; mastery is judged later |
| Home | A **task list** (Lesson / Review / Quiz) with XP for each, prerequisites ticked, and "Today" done items | A Today plan made of minute blocks |
| Motivation | **XP ≈ 1 focused minute**, a daily XP goal, a weekly bar chart, an estimated completion date | Minutes remaining |
| Retention | Spaced reviews per topic, mixed together. Advanced topics give **implicit credit** to their prerequisites (FIRe) | FSRS cards per skill, with no implicit credit |
| Checking | A **quiz every ~150 XP**: timed, no notes, missed topics become reviews. Khan has unit tests and a course challenge | None |
| Course view | Numbered outline: unit → topics (1.1.1 …) with status, % complete, mastery levels (Khan: Attempted / Familiar / Proficient / Mastered) | A graph map only |

## End state
1. **Content:** each concept becomes a *topic* with `knowledge_points: [{title, explain_md, worked_md, problems}]`. The point's `problems` mix **parameterised templates**, so numbers are randomised and each point gets an unlimited supply *(ours)*, with fixed conceptual and transfer items. The notation check stays and runs per point.
2. **Lesson runner:** works through one knowledge point at a time. Explanation and worked example first, then problems until 2 in a row are right (at most 5). Failing a point ends the lesson as "try again later", and the tutor offers help. Worked solutions appear after every answer.
3. **Learn page (home):** left column has course % complete, estimated finish date, total XP, today's XP against the goal, and this week's chart. Right column lists the next tasks (Lesson, Review, Quiz, Saturday Project) with their XP and ticked prerequisites, then the tasks done today. Your schedule becomes daily XP goals: 60 on weekdays, 300 on Saturday, 60 on Sunday.
4. **XP:** earned per task, scaled by how well you did (MA rule). It's stored in one `xp_events` table (`apps/api/src/db/schema.ts`), and the totals, chart and finish date are all calculated from it.
5. **Reviews:** a review task is 3–4 mixed problems on topics that are due. Finishing a review or lesson gives partial FIRe-style credit to its hard prerequisites, so fewer reviews come due. The scheduler stays deterministic. The credit weights are a hypothesis, and I'll tune them from your data.
6. **Quizzes:** after every ~150 XP, a timed quiz of about 8–10 recent topics, with no hints and no tutor. Any topic you miss becomes a review straight away. Retakes are allowed after review.
7. **Course page:** a numbered outline by week and topic, showing status and Khan-style mastery labels mapped from our states. The graph map stays, coloured by how stable each topic is.
8. **Kept:** the diagnostic (it places you at your frontier), the tutor, the Saturday lab (it becomes a Project task), your existing mastery and review history (migrated, not reset).
9. **Not doing:** leagues and leaderboards (you're the only user).

## Delivery (stacked PRs, old flow live until the new one works end to end)
1. Content model (knowledge points + templates) and validator. Supervised-learning moves over first as the template.
2. Knowledge-point lesson runner and the XP ledger.
3. Learn page and Course page.
4. Review tasks with implicit credit, plus quizzes.
5. Move the other 16 lessons over, with ≥5 problems per point. These can run as parallel sessions; they only overlap in `content/notation.yaml`.
6. Switch over, then delete the old Today/session/minutes flow.

## "No bugs" gate for every PR
- Unit tests for the runner rules (2 in a row, max 5, XP), FIRe credit and quiz scheduling.
- A Playwright run of your real path on seeded data: diagnostic → Learn → lesson → review → quiz → reload at every step.
- The full suite must pass 3 times in a row.
- After each deploy, a smoke check on the live site through the API without touching your progress, then your next lesson checked in the browser.
