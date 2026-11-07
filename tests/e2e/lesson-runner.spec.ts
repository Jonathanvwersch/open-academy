import { mkdirSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { createDb } from '../../src/server/db/client.js';
import { sessionActivities, studySessions, users } from '../../src/server/db/schema.js';
import { env } from '../../src/server/env.js';

const conceptId = 'supervised-learning';
const screenshotDir = '/home/ubuntu/screenshots/shadcn';
const lessonCardScreenshotDir = '/home/ubuntu/screenshots/lesson-cards';
mkdirSync(screenshotDir, { recursive: true });
mkdirSync(lessonCardScreenshotDir, { recursive: true });

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
  expect(
    session.session.activities.find(
      (activity: { conceptId: string }) => activity.conceptId === conceptId,
    ).exerciseIds,
  ).toEqual(['sl-explain-setup']);
  await page.goto(`/session/${session.session.id}`);
  await expect(page.getByRole('heading', { name: 'Supervised learning' })).toBeVisible();
  await expect(page.getByText(/^Learn · \d+ of \d+ today$/)).toBeVisible();
  await expect.poll(async () => (await currentRun(page))?.pendingProblem?.id).toBeTruthy();
  return session.session.id as string;
}

async function currentRun(page: Page, runConceptId = conceptId) {
  return page.evaluate(async (concept) => {
    const response = await fetch(`/api/lessons/${concept}/run`);
    return (await response.json()).run;
  }, runConceptId);
}

async function answerAndReload(page: Page, correct: boolean, runConceptId = conceptId) {
  const run = await currentRun(page, runConceptId);
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
      response.url().endsWith(`/api/lessons/${runConceptId}/run/answer`) &&
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
  expect(await currentRun(page, runConceptId)).toEqual(body.state);
  expect(body.state.lastAnsweredProblem.id).toBe(problem.id);
  return body.state;
}

async function nextProblemAndReload(
  page: Page,
  runConceptId = conceptId,
  assertWithinStepScroll = false,
) {
  const before = await currentRun(page, runConceptId);
  const buttonName =
    before.points.find(
      (point: { id: string }) => point.id === before.lastAnsweredProblem?.knowledgePointId,
    )?.status === 'passed'
      ? 'Next step'
      : 'Next problem';
  const checkScroll = buttonName === 'Next step' || assertWithinStepScroll;
  if (checkScroll) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  }
  const responsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/lessons/${runConceptId}/run`) &&
      response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: buttonName }).click();
  const response = await responsePromise;
  const body = await response.json();
  expect(response.status()).toBe(200);
  if (buttonName === 'Next step') {
    await expect(
      page.getByRole('heading', { name: body.run.currentPoint.title, exact: true }),
    ).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  } else if (assertWithinStepScroll) {
    await expect(page.getByTestId('lesson-problem')).toHaveAttribute(
      'data-problem-id',
      body.run.pendingProblem.id,
    );
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  }
  await page.reload();
  await expect(page.getByText(/^Problem \d+ · up to 5$/)).toBeVisible();
  expect(await currentRun(page, runConceptId)).toEqual(body.run);
  return body.run;
}

test('passes every knowledge point and restores the exact problem and result after reloads', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const sessionId = await createSession(page);
  const fitsHeading = page.getByRole('heading', { name: 'Where this fits', exact: true });
  await expect(fitsHeading).toBeVisible();
  const workedExample = page.getByRole('heading', { name: 'Worked example', exact: true });
  await expect(workedExample).toBeVisible();
  await expect(workedExample.locator('xpath=../..')).toHaveAttribute('data-slot', 'card');
  await page.screenshot({
    path: `${lessonCardScreenshotDir}/kp-runner-worked-example.png`,
    fullPage: true,
  });
  await page.screenshot({
    path: `${screenshotDir}/explanation-first-problem.png`,
    fullPage: true,
  });

  let run = await currentRun(page);
  for (let pointIndex = 0; pointIndex < run.points.length; pointIndex += 1) {
    while (run.points[pointIndex].status !== 'passed') {
      if (!run.pendingProblem) run = await nextProblemAndReload(page, conceptId, true);
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
    if (pointIndex < run.points.length - 1) {
      run = await nextProblemAndReload(page);
      if (pointIndex === 0) await expect(fitsHeading).toHaveCount(0);
    }
  }

  expect(run.status).toBe('completed');
  expect(run.xpEarned).toBe(40);
  await expect(page.getByText('Lesson complete · +40 XP')).toBeVisible();
  await page.screenshot({ path: `${screenshotDir}/lesson-complete.png`, fullPage: true });
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('Lesson complete · +40 XP')).toHaveCount(0);
  await expect(page.getByLabel('Your answer')).toBeVisible();
  await expect(page.getByTestId('exercise-prompt')).toContainText('Pick any real problem');
  await page.reload();
  await expect(page.getByLabel('Your answer')).toBeVisible();
  await page
    .getByLabel('Your answer')
    .fill(
      'Predict delivery time in minutes from distance and time of day. Inputs: distance and time of day; target: delivery time. Model: a line that combines the two inputs. Loss: squared error. Data: 5,000 past deliveries.',
    );
  await page.getByRole('button', { name: 'Submit answer' }).click();
  const selfCheck = page.getByRole('button', { name: 'Submit self-check' });
  const retry = page.getByRole('button', { name: /Try again/ });
  await expect
    .poll(
      async () =>
        (await selfCheck.isVisible()) ||
        (await retry.isVisible()) ||
        (await page.getByRole('button', { name: 'Continue' }).isVisible()),
    )
    .toBe(true);
  if (await selfCheck.isVisible()) {
    for (const checkbox of await page.getByRole('checkbox').all()) await checkbox.click();
    await selfCheck.click();
  } else if (await retry.isVisible()) {
    await retry.click();
  }
  await expect(page.getByRole('button', { name: 'Continue' })).toBeVisible();
  await page.reload();
  await expect(page.getByText('Model answer', { exact: true })).toBeVisible();
  await expect(page.getByText('Your answer:', { exact: true })).toBeVisible();
  const finalActivity = await page.evaluate(async (session) => {
    const response = await fetch(`/api/sessions/${session}`);
    const data = await response.json();
    return data.activities.find(
      (item: { conceptId: string }) => item.conceptId === 'supervised-learning',
    );
  }, sessionId);
  expect(finalActivity.status).toBe('completed');
  expect(finalActivity.progress.completedExerciseIds).toContain('sl-explain-setup');
  expect(finalActivity.lastAttempt.exerciseId).toBe('sl-explain-setup');
  expect(finalActivity.lastAttempt.status).toBe('graded');
  expect(finalActivity.lastAttempt.yourAnswer).toContain('Predict delivery time');
  expect(page.url()).toContain(`/session/${sessionId}`);
  await page.goto('/lessons/supervised-learning');
  await expect(page.getByRole('heading', { name: 'Where this fits', exact: true })).toBeVisible();
});

test('a legacy v1 learn activity resumes through the KP runner and final question', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const db = createDb(env.TEST_DATABASE_URL);
  const [learner] = await db.select({ id: users.id }).from(users).limit(1);
  if (!learner) throw new Error('Missing E2E learner');
  const [session] = await db
    .insert(studySessions)
    .values({
      userId: learner.id,
      kind: 'weekday',
      plannedMinutes: 60,
      status: 'active',
      startedAt: new Date(),
    })
    .returning();
  if (!session) throw new Error('Could not create legacy session');
  const [activity] = await db
    .insert(sessionActivities)
    .values({
      sessionId: session.id,
      idx: 0,
      kind: 'learn',
      conceptId: 'vectors',
      exerciseIds: ['vectors-component-sum'],
      plannedMinutes: 20,
      status: 'in_progress',
    })
    .returning();
  await db.$client.end();
  if (!activity) throw new Error('Could not create legacy learn activity');

  await page.goto(`/session/${session.id}`);
  await expect(page.getByText(/^Problem 1 · up to 5$/)).toBeVisible();
  await expect
    .poll(async () => (await currentRun(page, 'vectors'))?.pendingProblem?.id)
    .toBeTruthy();
  let run = await currentRun(page, 'vectors');
  expect(run.currentPointId).toBe('vectors-fixture-1');
  expect(run.points[0]).toMatchObject({ status: 'active', round: 1, answered: 0 });

  while (run.status !== 'completed') {
    run = run.pendingProblem
      ? await answerAndReload(page, true, 'vectors')
      : await nextProblemAndReload(page, 'vectors');
  }
  await expect(page.getByText(/^Lesson complete/)).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByTestId('exercise-prompt')).toContainText(
    "Explain what a vector's magnitude represents.",
  );
  const migrated = await page.evaluate(
    async ({ sessionId, activityId }) => {
      const response = await fetch(`/api/sessions/${sessionId}`);
      const data = await response.json();
      return data.activities.find((item: { id: string }) => item.id === activityId);
    },
    { sessionId: session.id, activityId: activity.id },
  );
  expect(migrated.exerciseIds).toEqual(['vectors-fixture-final']);
  expect(migrated.progress.lessonRunnerContinued).toBe(true);
  expect(migrated.status).toBe('in_progress');
  await page.reload();
  await expect(page.getByTestId('exercise-prompt')).toContainText(
    "Explain what a vector's magnitude represents.",
  );
  await page.getByLabel('Your answer').fill("A vector's magnitude is its length.");
  await page.getByRole('button', { name: 'Submit answer' }).click();
  const selfCheck = page.getByRole('button', { name: 'Submit self-check' });
  const retry = page.getByRole('button', { name: /Try again/ });
  const continueButton = page.getByRole('button', { name: 'Continue' });
  await expect
    .poll(
      async () =>
        (await selfCheck.isVisible()) ||
        (await retry.isVisible()) ||
        (await continueButton.isVisible()),
    )
    .toBe(true);
  if (await selfCheck.isVisible()) {
    for (const checkbox of await page.getByRole('checkbox').all()) await checkbox.click();
    await selfCheck.click();
  } else if (await retry.isVisible()) {
    await retry.click();
  }
  await expect(page.getByText('Model answer', { exact: true })).toBeVisible();
  await continueButton.click();
  const completed = await page.evaluate(
    async ({ sessionId, activityId }) => {
      const response = await fetch(`/api/sessions/${sessionId}`);
      const data = await response.json();
      return data.activities.find((item: { id: string }) => item.id === activityId);
    },
    { sessionId: session.id, activityId: activity.id },
  );
  expect(completed.status).toBe('completed');
  expect(completed.lastAttempt.exerciseId).toBe('vectors-fixture-final');
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
  expect(reoffered.exerciseIds).toEqual(['sl-explain-setup']);
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
