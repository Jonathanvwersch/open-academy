import type { QuizPayload } from '@academy/contracts/quizzes';
import type { SessionPayload } from '@academy/contracts/sessions';
import { expect, test } from '@playwright/test';
import { asc, eq } from 'drizzle-orm';
import { answerFor } from '../../apps/api/scripts/learner-simulation-support.js';
import { env } from '../../apps/api/src/config.js';
import { loadContent } from '../../apps/api/src/content/load.js';
import { createDb } from '../../apps/api/src/db/client.js';
import { lessonRuns, quizItems, users, xpEvents } from '../../apps/api/src/db/schema.js';

const db = createDb(env.TEST_DATABASE_URL);
const start = '2026-01-01T12:00:00.000Z';

test.skip(
  process.env.PLAYWRIGHT_CONTENT_DIR !== 'content',
  'This journey needs eight unrelated learned topics from the full curriculum.',
);

test.afterAll(async () => {
  await db.$client.end();
});

test('starts a quiz, preserves progress on refresh, and unlocks a fresh retake only after reviews', async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  const content = await loadContent('content');
  await db.delete(users);
  const [user] = await db
    .insert(users)
    .values({
      displayName: 'Timed quiz learner',
      timezone: 'UTC',
      startDate: '2026-01-01',
      activeCourseId: 'ml-foundations',
    })
    .returning();
  await db.insert(lessonRuns).values(
    content.lessons.map(({ concept }) => ({
      userId: user.id,
      conceptId: concept,
      status: 'completed' as const,
      completedAt: new Date(start),
    })),
  );
  await db.insert(xpEvents).values({
    userId: user.id,
    amount: 150,
    kind: 'knowledge_point',
    sourceKey: 'e2e:timed-quiz',
    earnedAt: new Date(start),
    localDate: '2026-01-01',
  });

  let now = start;
  await page.route('**/api/**', (route) =>
    route.continue({
      headers: { ...route.request().headers(), 'x-now': now, 'x-time-zone': 'UTC' },
    }),
  );
  const session = await page.request.post('/api/sessions', {
    data: { budgetMinutes: 120 },
    headers: { 'x-now': now, 'x-time-zone': 'UTC' },
  });
  expect(session.ok()).toBe(true);
  const { id: sessionId, activities } = (await session.json()) as SessionPayload & { id: string };
  expect(activities[0].kind).toBe('mixed_quiz');
  expect(activities.length).toBeGreaterThan(1);
  await page.goto(`/session/${sessionId}`);
  await page.getByRole('button', { name: 'Open quiz' }).click();
  await expect(page.getByText('Question 1 of 8')).toBeVisible();
  await expect(page.getByTestId('quiz-prompt')).not.toBeEmpty();
  await expect(page.getByRole('timer')).toBeVisible();
  await expect(page.getByRole('button', { name: /hint|tutor/i })).toHaveCount(0);
  await expect(page.locator('a[href*="/lessons/"]')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('timed-quiz-desktop.png') });

  const quizId = new URL(page.url()).pathname.split('/').at(-1) ?? '';
  const headers = () => ({ 'x-now': now, 'x-time-zone': 'UTC' });
  const readQuiz = async () =>
    (await (
      await page.request.get(`/api/quizzes/${quizId}`, {
        headers: headers(),
      })
    ).json()) as QuizPayload;
  const opened = await readQuiz();
  const items = await db
    .select()
    .from(quizItems)
    .where(eq(quizItems.runId, quizId))
    .orderBy(asc(quizItems.position));
  const first = items[0].question;
  const firstAnswer = answerFor(content, first.exercise.id, first.seed);
  const firstResponse = await page.request.post(`/api/quizzes/${quizId}/answer`, {
    headers: headers(),
    data: { position: 0, answer: firstAnswer },
  });
  expect(firstResponse.ok()).toBe(true);
  now = new Date(Date.parse(start) + 12_000).toISOString();
  await page.reload();
  await expect(page.getByText('Question 2 of 8')).toBeVisible();
  await expect(page.getByTestId('quiz-prompt')).not.toBeEmpty();
  expect((await readQuiz()).deadline).toBe(opened.deadline);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath('timed-quiz-refreshed-mobile.png') });

  now = opened.deadline;
  const second = items[1].question;
  const late = await page.request.post(`/api/quizzes/${quizId}/answer`, {
    headers: headers(),
    data: { position: 1, answer: answerFor(content, second.exercise.id, second.seed) },
  });
  expect(late.status()).toBe(409);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Quiz results' })).toBeVisible();
  await expect(page.getByText('1 of 8 correct')).toBeVisible();
  await expect(page.getByText('Then you can retake the quiz once, if you want.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retake quiz' })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('timed-quiz-results-mobile.png') });
  const previousViewport = page.viewportSize();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: testInfo.outputPath('timed-quiz-results-desktop.png') });
  if (previousViewport) await page.setViewportSize(previousViewport);
  const locked = await page.request.post(`/api/quizzes/${quizId}/retake`, { headers: headers() });
  expect(locked.status()).toBe(409);

  await page.getByRole('button', { name: 'Review now' }).click();
  await expect(page).toHaveURL(/\/session\//);
  const reviewSession = new URL(page.url()).pathname.split('/').at(-1);
  const reviewPlan = (await (
    await page.request.get(`/api/sessions/${reviewSession}`, {
      headers: headers(),
    })
  ).json()) as SessionPayload;
  expect(reviewPlan.activities).toHaveLength(7);
  for (const activity of reviewPlan.activities) {
    const attempted = new Set<string>();
    let exercises = activity.exerciseIds;
    while (exercises.length) {
      for (const exerciseId of exercises) {
        const submit = () =>
          page.request.post('/api/attempts', {
            headers: headers(),
            data: {
              exerciseId,
              sessionId: reviewSession,
              activityId: activity.id,
              mode: 'review',
              answer: answerFor(content, exerciseId),
            },
          });
        const response = await submit();
        expect(response.ok(), await response.text()).toBe(true);
        if ((await response.json()).retryAllowed) {
          const retry = await submit();
          expect(retry.ok(), await retry.text()).toBe(true);
          expect((await retry.json()).retryAllowed).toBe(false);
        }
        attempted.add(exerciseId);
      }
      const refreshed = await page.request.get(`/api/sessions/${reviewSession}`, {
        headers: headers(),
      });
      expect(refreshed.ok()).toBe(true);
      const current = ((await refreshed.json()) as SessionPayload).activities.find(
        ({ id }) => id === activity.id,
      );
      exercises = current?.exerciseIds.filter((id) => !attempted.has(id)) ?? [];
      if (exercises.length === 0) expect(current?.status).toBe('completed');
    }
  }
  await page.goto(`/session/${reviewSession}`);
  const finish = page.getByRole('button', { name: 'Finish session' });
  await expect(finish).toBeVisible({ timeout: 15_000 });
  await finish.click();
  await expect(page.getByRole('link', { name: 'Continue session' })).toHaveAttribute(
    'href',
    `/session/${sessionId}`,
  );
  await expect(
    page.getByRole('heading', { name: 'Reviews done. Your retake is unlocked.' }),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: /Skip the retake/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retake quiz now' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('timed-quiz-retake-mobile.png') });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.screenshot({ path: testInfo.outputPath('timed-quiz-retake-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Retake quiz' }).click();
  await expect(page.getByRole('heading', { name: 'Quiz retake' })).toBeVisible();
  const retakeId = new URL(page.url()).pathname.split('/').at(-1) ?? '';
  const retake = await db
    .select()
    .from(quizItems)
    .where(eq(quizItems.runId, retakeId))
    .orderBy(asc(quizItems.position));
  expect(retake.map(({ conceptId }) => conceptId)).toEqual(items.map(({ conceptId }) => conceptId));
  expect(
    retake.every(({ question }) => items.every((item) => item.question.key !== question.key)),
  ).toBe(true);
});
