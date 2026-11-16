import { expect, type Page, test } from '@playwright/test';
import { env } from '../../apps/api/src/config.js';
import { createDb } from '../../apps/api/src/db/client.js';
import {
  reviewCards,
  sessionActivities,
  studySessions,
  users,
} from '../../apps/api/src/db/schema.js';
import { newReviewCard } from '../../apps/api/src/learning/fsrs.js';

const sessionStart = new Date('2026-01-01T12:00:00.000Z');
const reviewExerciseIds = ['vectors-magnitude', 'vectors-component-sum', 'vectors-dot-product'];
const db = createDb(env.TEST_DATABASE_URL);
let userId = '';
let delaySessionGets = false;

test.beforeEach(async ({ page }) => {
  delaySessionGets = false;
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    if (
      delaySessionGets &&
      request.method() === 'GET' &&
      new URL(request.url()).pathname.startsWith('/api/sessions/')
    ) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    await route.continue({
      headers: { ...request.headers(), 'x-now': sessionStart.toISOString() },
    });
  });
  await db.delete(users);
  const [user] = await db
    .insert(users)
    .values({
      displayName: 'Instant next question E2E learner',
      timezone: 'UTC',
      startDate: '2026-01-01',
      prefs: { scheduleMinutes: 60 },
    })
    .returning({ id: users.id });
  if (!user) throw new Error('Could not create E2E learner');
  userId = user.id;
  await db.insert(reviewCards).values(
    ['math', 'conceptual'].map((dimension) => ({
      userId,
      conceptId: 'vectors',
      dimension,
      fsrs: newReviewCard(sessionStart),
      dueAt: new Date(sessionStart.getTime() - 60_000),
    })),
  );
});

test.afterAll(async () => {
  await db.$client.end();
});

async function createReviewSession() {
  const [session] = await db
    .insert(studySessions)
    .values({
      userId,
      kind: 'weekday',
      plannedMinutes: 30,
      status: 'active',
      startedAt: sessionStart,
    })
    .returning({ id: studySessions.id });
  if (!session) throw new Error('Could not create review session');
  await db.insert(sessionActivities).values([
    {
      sessionId: session.id,
      idx: 0,
      kind: 'review',
      conceptId: 'vectors',
      exerciseIds: reviewExerciseIds,
      plannedMinutes: 20,
      status: 'in_progress',
    },
    {
      sessionId: session.id,
      idx: 1,
      kind: 'practice',
      conceptId: 'vectors',
      exerciseIds: ['vectors-fixture-1-basics'],
      plannedMinutes: 10,
      status: 'planned',
    },
  ]);
  return session.id;
}

async function createSlowCorrectSession() {
  const [session] = await db
    .insert(studySessions)
    .values({
      userId,
      kind: 'weekday',
      plannedMinutes: 30,
      status: 'active',
      startedAt: sessionStart,
    })
    .returning({ id: studySessions.id });
  if (!session) throw new Error('Could not create slow-answer review session');
  await db.insert(sessionActivities).values({
    sessionId: session.id,
    idx: 0,
    kind: 'review',
    conceptId: 'vectors',
    exerciseIds: ['vectors-magnitude'],
    plannedMinutes: 30,
    status: 'in_progress',
  });
  return session.id;
}

async function answerCorrectly(page: Page, answer: string) {
  const answerInput = page.getByLabel('Your answer');
  await expect(answerInput).toBeEditable();
  await answerInput.fill(answer);
  const attemptRequestPromise = page.waitForRequest(
    (request) => request.url().endsWith('/api/attempts') && request.method() === 'POST',
  );
  const responsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/attempts') && response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Submit answer' }).click();
  const attemptRequest = await attemptRequestPromise;
  const requestBody = JSON.parse(attemptRequest.postData() ?? '{}') as { durationMs?: unknown };
  expect(typeof requestBody.durationMs).toBe('number');
  expect(requestBody.durationMs).toBeGreaterThanOrEqual(0);
  expect((await responsePromise).status()).toBe(200);
  await expect(page.getByText('Correct', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeVisible();
}

test('review questions advance immediately while session GETs are delayed', async ({ page }) => {
  const sessionId = await createReviewSession();
  await page.goto(`/session/${sessionId}`);
  const prompt = page.getByTestId('exercise-prompt');
  await expect(prompt).toContainText('Find the magnitude');
  await answerCorrectly(page, '5');

  delaySessionGets = true;
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(prompt).toContainText('What is the sum of the coordinates', { timeout: 1000 });
  await expect(page.getByRole('status').filter({ hasText: 'Correct' })).toHaveCount(0);

  const sessionResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `/api/sessions/${sessionId}` &&
      response.request().method() === 'GET',
  );
  await answerCorrectly(page, '5');
  await sessionResponse;
  delaySessionGets = false;
  await expect(page.getByTestId('question-progress').locator('li').nth(1)).toHaveAttribute(
    'data-state',
    'correct',
  );
});

test('slow correct review answers show the target-time feedback', async ({ page }, testInfo) => {
  const sessionId = await createSlowCorrectSession();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.clock.install();
  await page.goto(`/session/${sessionId}`);
  await expect(page.getByTestId('exercise-prompt')).toContainText('Find the magnitude');
  await page.clock.fastForward('00:31');
  await answerCorrectly(page, '5');
  await expect(
    page.getByText('Correct. Try to get this one in under 30 seconds next time.', {
      exact: true,
    }),
  ).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('slow-correct-feedback.png') });
});

test('an aged exercise query does not refetch when continuing', async ({ page }) => {
  const sessionId = await createReviewSession();
  let watchingExerciseRequests = false;
  let exerciseRequests = 0;
  page.on('request', (request) => {
    if (watchingExerciseRequests && request.url().includes('/api/exercises/')) {
      exerciseRequests += 1;
    }
  });
  await page.clock.install();
  await page.goto(`/session/${sessionId}`);
  await expect(page.getByTestId('exercise-prompt')).toContainText('Find the magnitude');
  await answerCorrectly(page, '5');

  await page.clock.fastForward('06:00');
  watchingExerciseRequests = true;
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByTestId('exercise-prompt')).toContainText(
    'What is the sum of the coordinates',
  );
  expect(exerciseRequests).toBe(0);
});

test('the last review question continues to the next activity', async ({ page }) => {
  const sessionId = await createReviewSession();
  await page.goto(`/session/${sessionId}`);
  const prompt = page.getByTestId('exercise-prompt');

  await expect(prompt).toContainText('Find the magnitude');
  await answerCorrectly(page, '5');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();

  await expect(prompt).toContainText('What is the sum of the coordinates');
  await answerCorrectly(page, '5');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();

  await expect(prompt).toContainText('What does a dot product of zero indicate');
  await answerCorrectly(page, 'orthogonal');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();

  await expect(prompt).toContainText('Which statement best describes the main idea');
});
