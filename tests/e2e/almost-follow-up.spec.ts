import { mkdirSync } from 'node:fs';
import { newReviewCard } from '@academy/aesop/memory/fsrs';
import { expect, test } from '@playwright/test';
import { env } from '../../apps/api/src/config.js';
import { createDb } from '../../apps/api/src/db/client.js';
import {
  reviewCards,
  sessionActivities,
  studySessions,
  users,
} from '../../apps/api/src/db/schema.js';

const db = createDb(env.TEST_DATABASE_URL);
const screenshotDir = 'test-results/screenshots/lesson-review';
mkdirSync(screenshotDir, { recursive: true });
let userId = '';

test.beforeEach(async () => {
  await db.delete(users);
  const [user] = await db
    .insert(users)
    .values({
      displayName: 'Almost follow-up E2E learner',
      timezone: 'UTC',
      startDate: '2026-01-01',
      prefs: { scheduleMinutes: 60 },
    })
    .returning();
  if (!user) throw new Error('Could not create E2E learner');
  userId = user.id;
});

test.afterAll(async () => {
  await db.$client.end();
});

async function createExplainActivity() {
  const [session] = await db
    .insert(studySessions)
    .values({
      userId,
      kind: 'weekday',
      plannedMinutes: 30,
      status: 'active',
      startedAt: new Date('2026-01-01T12:00:00.000Z'),
    })
    .returning();
  if (!session) throw new Error('Could not create E2E session');
  await db.insert(sessionActivities).values({
    sessionId: session.id,
    idx: 0,
    kind: 'learn',
    conceptId: 'supervised-learning',
    exerciseIds: ['sl-explain-setup'],
    plannedMinutes: 10,
    status: 'in_progress',
    progress: { lessonRunnerContinued: true },
  });
  return session.id;
}

async function createReviewExplainSession() {
  const startedAt = new Date('2026-01-01T12:00:00.000Z');
  await db.insert(reviewCards).values({
    userId,
    conceptId: 'supervised-learning',
    dimension: 'conceptual',
    fsrs: newReviewCard(startedAt),
    dueAt: new Date(startedAt.getTime() - 60_000),
  });
  const [session] = await db
    .insert(studySessions)
    .values({
      userId,
      kind: 'weekday',
      plannedMinutes: 30,
      status: 'active',
      startedAt,
    })
    .returning();
  if (!session) throw new Error('Could not create E2E review session');
  await db.insert(sessionActivities).values([
    {
      sessionId: session.id,
      idx: 0,
      kind: 'review',
      conceptId: 'supervised-learning',
      exerciseIds: ['sl-explain-setup'],
      plannedMinutes: 10,
      status: 'in_progress',
    },
    {
      sessionId: session.id,
      idx: 1,
      kind: 'practice',
      conceptId: 'supervised-learning',
      exerciseIds: ['sl-inputs-targets-basics'],
      plannedMinutes: 10,
      status: 'planned',
    },
  ]);
  return session.id;
}

test('partial explain feedback keeps the answer editable for one Almost follow-up', async ({
  page,
}) => {
  const sessionId = await createExplainActivity();
  await page.setViewportSize({ width: 1280, height: 900 });
  let checkedFollowUpResponse = false;
  await page.route('**/api/attempts', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    const body = await response.json();
    if (body.followUp === true) {
      expect(body).not.toHaveProperty('exemplar');
      expect(body).not.toHaveProperty('solution');
      checkedFollowUpResponse = true;
      await route.fulfill({
        response,
        json: { ...body, exemplar: 'Hidden test model answer.', solution: 'Hidden test solution.' },
      });
      return;
    }
    await route.fulfill({ response, json: body });
  });
  await page.goto(`/session/${sessionId}`);
  await expect(page.getByRole('heading', { name: 'Supervised learning' })).toBeVisible();

  const answer = page.getByLabel('Your answer');
  const firstAnswer = 'Inputs are distance and time of day; the target is delivery time.';
  await answer.fill(firstAnswer);
  await answer.evaluate((element) => {
    element.setAttribute('data-test-almost-editor', 'mounted');
  });
  await page.getByRole('button', { name: 'Submit answer' }).click();

  await expect(page.getByText('Almost', { exact: true })).toBeVisible();
  await expect(page.getByText('Model answer', { exact: true })).toHaveCount(0);
  await expect(page.getByText('E2E summary feedback.', { exact: true })).toBeVisible();
  await expect(answer).toHaveValue(firstAnswer);
  await expect(answer).not.toHaveAttribute('readonly', '');
  await expect(page.getByRole('button', { name: 'Submit again' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue' })).toHaveCount(0);
  await expect(page.getByRole('status')).toContainText('½');
  const nextStep = page.getByTestId('almost-next-step');
  await expect(nextStep).toBeVisible();
  await expect(nextStep).toContainText('Submit again');
  await expect(nextStep).toContainText('one more try');
  expect(checkedFollowUpResponse).toBe(true);
  expect(await answer.evaluate((element) => element.getAttribute('data-test-almost-editor'))).toBe(
    'mounted',
  );
  await page.screenshot({ path: `${screenshotDir}/almost-1.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(nextStep).toBeVisible();
  await page.screenshot({ path: `${screenshotDir}/almost-1-mobile.png`, fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });

  const secondAnswer = `${firstAnswer} Squared error measures the prediction's miss.`;
  await answer.fill(secondAnswer);
  await page.getByRole('button', { name: 'Submit again' }).click();

  await expect(page.getByText('Partly correct', { exact: true })).toBeVisible();
  await expect(page.getByTestId('almost-next-step')).toHaveCount(0);
  await expect(page.getByText('Model answer', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue' })).toBeVisible();
  await expect(answer).toHaveValue(secondAnswer);
  await expect(answer).toHaveAttribute('readonly', '');
  await page.screenshot({ path: `${screenshotDir}/almost-2.png`, fullPage: true });
});

test('review Almost retry survives a session reload from the Reviews page', async ({ page }) => {
  const sessionId = await createReviewExplainSession();
  await page.goto('/reviews');
  const continueReviews = page.getByRole('link', { name: 'Continue reviews' });
  await expect(continueReviews).toBeVisible();
  await continueReviews.click();
  await expect(page).toHaveURL(new RegExp(`/session/${sessionId}$`));

  const prompt = page.getByTestId('exercise-prompt');
  const firstPrompt = (await prompt.textContent()) ?? '';
  const answer = page.getByLabel('Your answer');
  const firstAnswer = 'Inputs go in and a target comes out.';
  await answer.fill(firstAnswer);
  const firstResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/attempts') && response.request().method() === 'POST',
  );
  await answer.press('Enter');
  const firstBody = await (await firstResponse).json();
  expect(firstBody).toMatchObject({ followUp: true, retryAllowed: true });
  expect(firstBody).not.toHaveProperty('exemplar');
  expect(firstBody).not.toHaveProperty('solution');
  await expect(page.getByText('Almost', { exact: true })).toBeVisible();
  await expect(page.getByText('Model answer', { exact: true })).toHaveCount(0);
  await expect(answer).toHaveValue(firstAnswer);
  await expect(answer).toBeFocused();

  const refetch = page.waitForResponse(
    (response) =>
      response.request().method() === 'GET' &&
      response.url().endsWith(`/api/sessions/${sessionId}`),
  );
  await page.reload();
  expect((await refetch).status()).toBe(200);
  await expect(prompt).toHaveText(firstPrompt);
  await expect(answer).toHaveValue(firstAnswer);
  await expect(answer).toBeFocused();
  await expect(page.getByRole('button', { name: 'Submit again' })).toBeVisible();

  const secondAnswer = `${firstAnswer} Loss measures how wrong the prediction is.`;
  await answer.fill(secondAnswer);
  const secondResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/attempts') && response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Submit again' }).click();
  const secondBody = await (await secondResponse).json();
  expect(secondBody).not.toHaveProperty('followUp');
  expect(secondBody).toHaveProperty('exemplar');
  await expect(page.getByText('Partly correct', { exact: true })).toBeVisible();
  await expect(page.getByTestId('almost-next-step')).toHaveCount(0);
  await expect(page.getByText('Model answer', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue' })).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(prompt).not.toHaveText(firstPrompt);
});
