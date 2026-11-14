import { expect, test } from '@playwright/test';
import { env } from '../../apps/api/src/config.js';
import { createDb } from '../../apps/api/src/db/client.js';
import { sessionActivities, studySessions, users } from '../../apps/api/src/db/schema.js';
import { enrollInDefaultCourse } from './course-start.js';

const conceptId = 'mlp-forward-pass';

test.beforeEach(async () => {
  const db = createDb(env.TEST_DATABASE_URL);
  await db.delete(users);
  const [user] = await db
    .insert(users)
    .values({
      displayName: 'Final question E2E learner',
      timezone: 'UTC',
      startDate: '2026-01-01',
      prefs: { scheduleMinutes: 60 },
    })
    .returning({ id: users.id });
  if (!user) throw new Error('Could not create final question learner');
  await enrollInDefaultCourse(db, user.id);
  await db.$client.end();
});

test('continuing a final question after lesson-run query GC opens the quiz', async ({ page }) => {
  test.skip(
    process.env.PLAYWRIGHT_CONTENT_DIR !== 'content',
    'requires the authored mlp-forward-pass lesson; run with PLAYWRIGHT_CONTENT_DIR=content',
  );
  const db = createDb(env.TEST_DATABASE_URL);
  const [user] = await db.select({ id: users.id }).from(users).limit(1);
  if (!user) throw new Error('Missing final question learner');
  const [session] = await db
    .insert(studySessions)
    .values({
      userId: user.id,
      kind: 'weekday',
      plannedMinutes: 60,
      status: 'active',
      startedAt: new Date('2026-01-01T12:00:00.000Z'),
    })
    .returning();
  if (!session) throw new Error('Could not create final question session');
  const [activity] = await db
    .insert(sessionActivities)
    .values({
      sessionId: session.id,
      idx: 0,
      kind: 'learn',
      conceptId,
      exerciseIds: ['mlp-explain'],
      plannedMinutes: 20,
      status: 'in_progress',
    })
    .returning();
  await db.$client.end();
  if (!activity) throw new Error('Could not create final question activity');

  await page.clock.install();
  await page.goto(`/session/${session.id}`);
  const runStatus = await page.evaluate(
    async ({ conceptId, activityId }) => {
      type Run = {
        status: string;
        pendingProblem?: { id: string };
      };
      let run = (await (await fetch(`/api/lessons/${conceptId}/run`)).json()).run as Run | null;
      if (!run) {
        const response = await fetch(`/api/lessons/${conceptId}/run`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ activityId }),
        });
        const result = await response.json();
        if (!response.ok || !result.run) {
          throw new Error(result.error ?? 'Could not start lesson run');
        }
        run = result.run as Run;
      }
      for (let count = 0; run?.status === 'in_progress' && count < 200; count += 1) {
        if (!run.pendingProblem) {
          run = (
            await (
              await fetch(`/api/lessons/${conceptId}/run`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ activityId }),
              })
            ).json()
          ).run as Run;
          continue;
        }
        const expected = await (
          await fetch(`/api/test/lesson-problems/${run.pendingProblem.id}/answer`)
        ).json();
        const response = await fetch(`/api/lessons/${conceptId}/run/answer`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            problemId: run.pendingProblem.id,
            answer: expected.answer,
            activityId,
          }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error ?? 'Could not answer lesson step');
        run = result.state as Run;
      }
      return run?.status;
    },
    { conceptId, activityId: activity.id },
  );
  expect(runStatus).toBe('quiz');

  await page.reload();
  await expect(page.getByTestId('lesson-steps-complete')).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(
    page.getByRole('heading', { name: 'Explain it in your own words', exact: true }),
  ).toBeVisible();
  await page
    .getByLabel('Your answer')
    .fill(
      'Each row is one example. The layer multiplies its feature vector by the weights and adds the bias.',
    );
  await page.getByRole('button', { name: 'Submit answer' }).click();
  const submitAgain = page.getByRole('button', { name: 'Submit again' });
  await expect(submitAgain).toBeVisible();
  await submitAgain.click();
  const continueButton = page.getByRole('button', { name: 'Continue', exact: true });
  await expect(continueButton).toBeVisible();

  await page.clock.fastForward('06:00');
  await continueButton.click();

  await expect(page.getByTestId('lesson-quiz-intro')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start quiz' })).toBeVisible();
  await expect(
    page.getByText('No eligible exercise is available for this activity yet.'),
  ).toHaveCount(0);
});
