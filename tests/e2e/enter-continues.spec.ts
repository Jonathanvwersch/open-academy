import { expect, test } from '@playwright/test';
import { createDb } from '../../src/server/db/client.js';
import {
  reviewCards,
  sessionActivities,
  studySessions,
  users,
} from '../../src/server/db/schema.js';
import { env } from '../../src/server/env.js';
import { newReviewCard } from '../../src/server/learning/fsrs.js';

const sessionStart = new Date('2026-01-01T12:00:00.000Z');

test.beforeEach(async () => {
  const db = createDb(env.TEST_DATABASE_URL);
  await db.delete(users);
  const [user] = await db
    .insert(users)
    .values({
      displayName: 'Enter continuation E2E learner',
      timezone: 'UTC',
      startDate: '2026-01-01',
      prefs: { scheduleMinutes: 60 },
    })
    .returning({ id: users.id });
  if (!user) throw new Error('Could not create E2E learner');
  await db.insert(reviewCards).values({
    userId: user.id,
    conceptId: 'vectors',
    dimension: 'math',
    fsrs: newReviewCard(sessionStart),
    dueAt: new Date(sessionStart.getTime() - 60_000),
  });
  await db.$client.end();
});

async function createReviewSession(
  exerciseIds = ['vectors-magnitude'],
  nextExerciseId = 'vectors-component-sum',
  firstActivityKind: 'review' | 'practice' = 'review',
  conceptId = 'vectors',
) {
  const db = createDb(env.TEST_DATABASE_URL);
  const [user] = await db.select({ id: users.id }).from(users).limit(1);
  if (!user) throw new Error('Missing E2E learner');
  const [session] = await db
    .insert(studySessions)
    .values({
      userId: user.id,
      kind: 'weekday',
      plannedMinutes: 20,
      status: 'active',
      startedAt: sessionStart,
    })
    .returning({ id: studySessions.id });
  if (!session) throw new Error('Could not create review session');
  await db.insert(sessionActivities).values([
    {
      sessionId: session.id,
      idx: 0,
      kind: firstActivityKind,
      conceptId,
      exerciseIds,
      plannedMinutes: 10,
      status: 'in_progress',
    },
    {
      sessionId: session.id,
      idx: 1,
      kind: 'practice',
      conceptId,
      exerciseIds: [nextExerciseId],
      plannedMinutes: 10,
      status: 'planned',
    },
  ]);
  await db.$client.end();
  return session.id;
}

test('Enter on a locked numeric answer continues without resubmitting', async ({ page }) => {
  const sessionId = await createReviewSession();
  let answerPosts = 0;
  page.on('request', (request) => {
    if (request.url().endsWith('/api/attempts') && request.method() === 'POST') {
      answerPosts += 1;
    }
  });

  await page.goto(`/session/${sessionId}`);
  await expect(page.getByText(/Activity \d+ of \d+ today/)).toHaveCount(0);
  const answer = page.getByLabel('Your answer');
  await answer.fill('5');
  const firstAnswer = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/attempts') && response.request().method() === 'POST',
  );
  await answer.press('Enter');
  expect((await firstAnswer).status()).toBe(200);
  await expect(page.getByText('Correct', { exact: true })).toBeVisible();
  await expect(answer).toBeFocused();
  await expect(answer).toHaveAttribute('readonly', '');
  await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeVisible();
  await answer.press('Enter');

  await expect(page.getByText(/Activity \d+ of \d+ today/)).toHaveCount(0);
  await expect(page.getByTestId('exercise-prompt')).toContainText('sum of the coordinates');
  await expect(page.getByText('Not quite', { exact: true })).toHaveCount(0);
  expect(answerPosts).toBe(1);
});

test('Enter on a locked explanation textarea continues without resubmitting', async ({ page }) => {
  const sessionId = await createReviewSession(
    ['sl-explain-setup'],
    'sl-inputs-targets-basics',
    'practice',
    'supervised-learning',
  );
  let answerPosts = 0;
  page.on('request', (request) => {
    if (request.url().endsWith('/api/attempts') && request.method() === 'POST') {
      answerPosts += 1;
    }
  });

  await page.goto(`/session/${sessionId}`);
  const answer = page.getByLabel('Your answer');
  await answer.fill('Inputs go in and a target comes out.');
  const firstAnswer = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/attempts') && response.request().method() === 'POST',
  );
  await answer.press('Enter');
  expect((await firstAnswer).status()).toBe(200);
  await expect(page.getByText('Almost', { exact: true })).toBeVisible();
  await answer.fill('Inputs go in and a target comes out; loss measures error.');
  const secondAnswer = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/attempts') && response.request().method() === 'POST',
  );
  await answer.press('Enter');
  expect((await secondAnswer).status()).toBe(200);
  await expect(page.getByText('Partly correct', { exact: true })).toBeVisible();
  await expect(answer).toBeFocused();
  await expect(answer).toHaveAttribute('readonly', '');
  await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeVisible();

  await answer.press('Enter');

  await expect(page.getByRole('radio')).toHaveCount(4);
  expect(answerPosts).toBe(2);
});

test('Tab and Enter on Hint reveals it instead of continuing', async ({ page }) => {
  const sessionId = await createReviewSession(
    ['vectors-magnitude'],
    'vectors-component-sum',
    'practice',
  );
  await page.goto(`/session/${sessionId}`);
  await page.getByLabel('Your answer').fill('5');
  await page.getByRole('button', { name: 'Submit answer' }).click();
  await expect(page.getByRole('status')).toBeVisible();

  const continueButton = page.getByRole('button', { name: 'Continue', exact: true });
  await continueButton.focus();
  await page.keyboard.press('Tab');
  const hintButton = page.getByRole('button', { name: 'Hint', exact: true });
  await expect(hintButton).toBeFocused();
  await page.keyboard.press('Enter');

  await expect(page.getByText('Hint 1', { exact: true })).toBeVisible();
  await expect(page.getByTestId('exercise-prompt')).toContainText('Find the magnitude');
  await expect(continueButton).toBeVisible();
});

test('Enter outside a textarea continues after multiple-choice feedback', async ({ page }) => {
  const sessionId = await createReviewSession(['vectors-fixture-1-basics']);
  let answerPosts = 0;
  page.on('request', (request) => {
    if (request.url().endsWith('/api/attempts') && request.method() === 'POST') {
      answerPosts += 1;
    }
  });

  await page.goto(`/session/${sessionId}`);
  await page.getByRole('radio').first().click();
  await page.getByRole('button', { name: 'Submit answer' }).click();
  await expect(page.getByRole('status')).toBeVisible();
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  await page.keyboard.press('Enter');

  await expect(page.getByTestId('exercise-prompt')).toContainText('sum of the coordinates');
  expect(answerPosts).toBe(1);
});

test('empty text and multiple-choice answers show inline validation without posting', async ({
  page,
}) => {
  let answerPosts = 0;
  page.on('request', (request) => {
    if (request.url().endsWith('/api/attempts') && request.method() === 'POST') {
      answerPosts += 1;
    }
  });

  await page.goto(`/session/${await createReviewSession()}`);
  await page.getByRole('button', { name: 'Submit answer' }).click();
  await expect(page.getByRole('alert')).toHaveText('Write an answer first.');

  await page.goto(`/session/${await createReviewSession(['vectors-fixture-1-basics'])}`);
  await page.getByRole('button', { name: 'Submit answer' }).click();
  await expect(page.getByRole('alert')).toHaveText('Choose an answer first.');
  expect(answerPosts).toBe(0);
});

test('a refused answer refreshes the session without showing wrong feedback', async ({ page }) => {
  const sessionId = await createReviewSession();
  let answerPosts = 0;
  let sessionReads = 0;
  page.on('request', (request) => {
    if (request.url().endsWith(`/api/sessions/${sessionId}`) && request.method() === 'GET') {
      sessionReads += 1;
    }
  });
  await page.route('**/api/attempts', async (route) => {
    if (route.request().method() === 'POST') {
      answerPosts += 1;
      await route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'This activity allows one attempt.' }),
      });
      return;
    }
    await route.continue();
  });

  await page.goto(`/session/${sessionId}`);
  await expect(page.getByText(/Activity \d+ of \d+ today/)).toHaveCount(0);
  const initialSessionReads = sessionReads;
  const answer = page.getByLabel('Your answer');
  await answer.fill('5');
  const refusedAnswer = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/attempts') && response.request().method() === 'POST',
  );
  await answer.press('Enter');
  expect((await refusedAnswer).status()).toBe(409);

  await expect.poll(() => sessionReads).toBeGreaterThan(initialSessionReads);
  await expect(page.getByText('Not quite', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Submit answer' })).toBeVisible();
  expect(answerPosts).toBe(1);
});

test('invalid answers remain retryable and other response errors stay out of feedback', async ({
  page,
}) => {
  const sessionId = await createReviewSession();
  let answerPosts = 0;
  await page.route('**/api/attempts', async (route) => {
    if (route.request().method() === 'POST') {
      answerPosts += 1;
      await route.fulfill({
        status: answerPosts === 1 ? 422 : 503,
        contentType: 'application/json',
        body: JSON.stringify(
          answerPosts === 1
            ? { status: 'invalid', feedback: 'Invalid answer' }
            : { error: 'Temporary grading failure' },
        ),
      });
      return;
    }
    await route.continue();
  });

  await page.goto(`/session/${sessionId}`);
  const answer = page.getByLabel('Your answer');
  await answer.fill('not a number');
  const invalidResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/attempts') && response.request().method() === 'POST',
  );
  await answer.press('Enter');
  expect((await invalidResponse).status()).toBe(422);
  await expect(page.getByText('Invalid answer', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Submit answer' })).toBeVisible();
  await expect(page.getByText('Not quite', { exact: true })).toHaveCount(0);

  await answer.fill('5');
  const failedResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/attempts') && response.request().method() === 'POST',
  );
  await answer.press('Enter');
  expect((await failedResponse).status()).toBe(503);
  await expect(
    page.getByRole('alert').filter({ hasText: 'Temporary grading failure' }),
  ).toBeVisible();
  await expect(page.getByText('Invalid answer', { exact: true })).toBeVisible();
  await expect(page.getByText('Not quite', { exact: true })).toHaveCount(0);
  expect(answerPosts).toBe(2);
});
