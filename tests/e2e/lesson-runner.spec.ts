import { mkdirSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { createDb } from '../../src/server/db/client.js';
import { users } from '../../src/server/db/schema.js';
import { env } from '../../src/server/env.js';

const conceptId = 'supervised-learning';
const screenshotDir = '/home/ubuntu/screenshots/shadcn';
mkdirSync(screenshotDir, { recursive: true });

test.beforeEach(async () => {
  const db = createDb(env.TEST_DATABASE_URL);
  await db.delete(users);
  await db.insert(users).values({
    displayName: 'Lesson runner E2E learner',
    timezone: 'UTC',
    startDate: '2026-01-01',
    prefs: { scheduleMinutes: 60 },
  });
  await db.$client.end();
});

async function createSession(page: Page, focusConcept = true) {
  await page.goto('/');
  const session = await page.evaluate(async (concept) => {
    const response = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        budgetMinutes: 60,
        ...(concept ? { focusConceptId: 'supervised-learning' } : {}),
      }),
    });
    return { status: response.status, session: await response.json() };
  }, focusConcept);
  expect(session.status).toBe(201);
  await page.goto(`/session/${session.session.id}`);
  await expect(page.getByRole('heading', { name: 'Supervised learning' })).toBeVisible();
  await expect(page.getByText(/^Learn · \d+ of \d+ today$/)).toBeVisible();
  await expect.poll(async () => (await currentRun(page))?.pendingProblem?.id).toBeTruthy();
  return session.session.id as string;
}

async function currentRun(page: Page) {
  return page.evaluate(async () => {
    const response = await fetch('/api/lessons/supervised-learning/run');
    return (await response.json()).run;
  });
}

async function answerAndReload(page: Page, correct: boolean) {
  const run = await currentRun(page);
  const problem = run.pendingProblem;
  const hook = await page.evaluate(async (id) => {
    const response = await fetch(`/api/test/lesson-problems/${id}/answer`);
    return response.json();
  }, problem.id);
  const exercise = problem.exercise;
  let answer = hook.answer;
  if (!correct) {
    if (exercise.type === 'mc') {
      const correctIds = Array.isArray(answer) ? answer : [answer];
      answer = exercise.options.find(
        (option: { id: string }) => !correctIds.includes(option.id),
      )?.id;
    } else {
      answer = Number(answer) + 1_000_000;
    }
  }

  if (exercise.type === 'mc') {
    const ids = Array.isArray(answer) ? answer : [answer];
    const inputs = exercise.multi ? page.getByRole('checkbox') : page.getByRole('radio');
    for (const id of ids) {
      const index = exercise.options.findIndex((option: { id: string }) => option.id === id);
      await inputs.nth(index).click();
      await expect(inputs.nth(index)).toHaveAttribute('aria-checked', 'true');
    }
  } else {
    await page.getByLabel('Your answer').fill(String(answer));
  }
  const responsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/lessons/supervised-learning/run/answer') &&
      response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Submit answer' }).click();
  const response = await responsePromise;
  const body = await response.json();
  expect(response.status()).toBe(200);
  await page.reload();
  await expect(page.getByRole('status')).toContainText(correct ? 'Correct' : 'Not quite');
  await expect(page.getByTestId('lesson-problem')).toHaveAttribute('data-problem-id', problem.id);
  await expect(page.getByTestId('lesson-problem-prompt')).toBeVisible();
  expect(await currentRun(page)).toEqual(body.state);
  expect(body.state.lastAnsweredProblem.id).toBe(problem.id);
  return body.state;
}

async function nextProblemAndReload(page: Page) {
  const before = await currentRun(page);
  const buttonName =
    before.points.find(
      (point: { id: string }) => point.id === before.lastAnsweredProblem?.knowledgePointId,
    )?.status === 'passed'
      ? 'Next step'
      : 'Next problem';
  const responsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/lessons/supervised-learning/run') &&
      response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: buttonName }).click();
  const response = await responsePromise;
  const body = await response.json();
  expect(response.status()).toBe(200);
  await page.reload();
  await expect(page.getByText(/^Problem \d+ · up to 5$/)).toBeVisible();
  expect(await currentRun(page)).toEqual(body.run);
  return body.run;
}

test('passes every knowledge point and restores the exact problem and result after reloads', async ({
  page,
}) => {
  const sessionId = await createSession(page);
  await page.screenshot({
    path: `${screenshotDir}/explanation-first-problem.png`,
    fullPage: true,
  });

  let run = await currentRun(page);
  for (let pointIndex = 0; pointIndex < run.points.length; pointIndex += 1) {
    while (run.points[pointIndex].status !== 'passed') {
      if (!run.pendingProblem) run = await nextProblemAndReload(page);
      run = await answerAndReload(page, true);
      if (pointIndex === 0 && run.points[0].streak === 1) {
        await expect(page.getByLabel('1 correct in a row')).toBeVisible();
        await page.screenshot({
          path: `${screenshotDir}/correct-answer-streak.png`,
          fullPage: true,
        });
      }
      if (pointIndex === 0 && run.points[0].status === 'passed') {
        await expect(page.getByText('+10 XP')).toBeVisible();
        await expect(page.getByText('Problem 2 · up to 5')).toBeVisible();
        await expect(page.getByText('Your answer:')).toBeVisible();
        await expect(page.getByText('Correct answer:')).toBeVisible();
        await page.screenshot({
          path: `${screenshotDir}/knowledge-point-passed.png`,
          fullPage: true,
        });
      }
    }
    if (pointIndex < run.points.length - 1) run = await nextProblemAndReload(page);
  }

  expect(run.status).toBe('completed');
  expect(run.xpEarned).toBe(40);
  await expect(page.getByText('Lesson complete · +40 XP')).toBeVisible();
  await page.screenshot({ path: `${screenshotDir}/lesson-complete.png`, fullPage: true });
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('Lesson complete · +40 XP')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Supervised learning' })).toHaveCount(0);
  expect(page.url()).toContain(`/session/${sessionId}`);
});

test('a failed knowledge point shows the retry screen and resumes at round two if scheduled again', async ({
  page,
}) => {
  await createSession(page);
  let run = await currentRun(page);
  const firstProblemId = run.pendingProblem.id;
  for (let answerIndex = 0; answerIndex < 4; answerIndex += 1) {
    run = await answerAndReload(page, false);
    if (answerIndex === 0) {
      await expect(page.getByText('Your answer:')).toBeVisible();
      await expect(page.getByText('Correct answer:')).toBeVisible();
      await page.screenshot({ path: `${screenshotDir}/wrong-answer.png`, fullPage: true });
    }
    if (answerIndex < 3) run = await nextProblemAndReload(page);
  }
  expect(run.status).toBe('needs_retry');
  expect(run.points[0]).toMatchObject({ status: 'failed', round: 1 });
  await expect(page.getByText('Try again later')).toBeVisible();
  await page.screenshot({ path: `${screenshotDir}/try-again-later.png`, fullPage: true });
  await page.getByRole('button', { name: 'Continue' }).click();

  const session = await page.evaluate(async () => {
    const response = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ budgetMinutes: 60 }),
    });
    return response.json();
  });
  const reoffered = session.activities?.find(
    (activity: { conceptId?: string; kind: string }) =>
      activity.conceptId === conceptId && activity.kind === 'learn',
  );
  expect(reoffered).toBeTruthy();
  await page.goto(`/session/${session.id}`);
  await expect(page.getByRole('heading', { name: 'Supervised learning' })).toBeVisible();
  await expect.poll(async () => (await currentRun(page))?.pendingProblem?.round).toBe(2);
  const resumed = await currentRun(page);
  expect(resumed.currentPointId).toBe('sl-inputs-targets');
  expect(resumed.points[0]).toMatchObject({ status: 'active', round: 2, answered: 0 });
  expect(resumed.pendingProblem.id).not.toBe(firstProblemId);
  await expect(page.getByText('Problem 1 · up to 5')).toBeVisible();
  await page.screenshot({ path: `${screenshotDir}/round-two-retry.png`, fullPage: true });
});
