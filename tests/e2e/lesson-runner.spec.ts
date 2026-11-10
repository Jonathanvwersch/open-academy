import { mkdirSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { createDb } from '../../src/server/db/client.js';
import {
  diagnosticRuns,
  sessionActivities,
  studySessions,
  users,
} from '../../src/server/db/schema.js';
import { env } from '../../src/server/env.js';

const conceptId = 'supervised-learning';
const screenshotDir = '/home/ubuntu/screenshots/shadcn';
const lessonCardScreenshotDir = '/home/ubuntu/screenshots/lesson-cards';
const stepReviewScreenshotDir = '/home/ubuntu/ui-audit/step-review';
const feedbackCorrectScreenshotDir = '/home/ubuntu/screenshots/feedback-correct';
const mcShuffleScreenshotDir = '/home/ubuntu/screenshots/mc-shuffle';
const buttonLoadingScreenshotDir = '/home/ubuntu/screenshots/button-loading';
const finalContinueScreenshotDir = '/home/ubuntu/screenshots/final-continue';
const checkpointScreenshotDir = '/home/ubuntu/screenshots/kp-checkpoint';
mkdirSync(screenshotDir, { recursive: true });
mkdirSync(lessonCardScreenshotDir, { recursive: true });
mkdirSync(stepReviewScreenshotDir, { recursive: true });
mkdirSync(feedbackCorrectScreenshotDir, { recursive: true });
mkdirSync(mcShuffleScreenshotDir, { recursive: true });
mkdirSync(buttonLoadingScreenshotDir, { recursive: true });
mkdirSync(finalContinueScreenshotDir, { recursive: true });
mkdirSync(checkpointScreenshotDir, { recursive: true });

test.beforeEach(async () => {
  const db = createDb(env.TEST_DATABASE_URL);
  await db.delete(users);
  const [user] = await db
    .insert(users)
    .values({
      displayName: 'Lesson runner E2E learner',
      timezone: 'UTC',
      startDate: '2026-01-01',
      prefs: { scheduleMinutes: 60 },
    })
    .returning({ id: users.id });
  if (!user) throw new Error('Could not create lesson runner learner');
  await db.insert(diagnosticRuns).values({
    userId: user.id,
    status: 'completed',
    state: {},
    startedAt: new Date(),
    completedAt: new Date(),
  });
  await db.$client.end();
});

async function createSession(page: Page, focusConcept = true, waitForRun = true) {
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
  if (waitForRun) {
    await expect.poll(async () => (await currentRun(page))?.pendingProblem?.id).toBeTruthy();
  }
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
    for (const id of ids) {
      const input = page.locator(`[id="${exercise.id}-${id}"]`);
      await input.click();
      await expect(input).toHaveAttribute('aria-checked', 'true');
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
  const pointPassed =
    before.points.find(
      (point: { id: string }) => point.id === before.lastAnsweredProblem?.knowledgePointId,
    )?.status === 'passed';
  const nextPointTitle = before.currentPoint?.title;
  const buttonName = pointPassed
    ? nextPointTitle
      ? `Next: ${nextPointTitle}`
      : 'Next step'
    : 'Next problem';
  const opensCheckpoint = buttonName.startsWith('Next: ');
  const checkScroll = opensCheckpoint || buttonName === 'Next step' || assertWithinStepScroll;
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
  if (opensCheckpoint) {
    await expect(page.getByTestId('kp-checkpoint')).toBeVisible();
    const continueButton = page.getByRole('button', {
      name: `Continue to ${body.run.currentPoint.title}`,
      exact: true,
    });
    await continueButton.click();
    await expect(
      page.getByRole('heading', { name: body.run.currentPoint.title, exact: true }),
    ).toBeVisible();
    await expect(page.getByTestId('lesson-problem')).toBeVisible();
  } else if (buttonName === 'Next step') {
    await expect(
      page.getByRole('heading', { name: body.run.currentPoint.title, exact: true }),
    ).toBeVisible();
    await expect(page.getByTestId('lesson-problem')).toBeVisible();
  } else if (assertWithinStepScroll) {
    await expect(page.getByTestId('lesson-problem')).toHaveAttribute(
      'data-problem-id',
      body.run.pendingProblem.id,
    );
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  }
  await page.reload();
  await expect(page.getByText(/^(?:Basics question|Problem \d+ · up to 5)$/)).toBeVisible();
  expect(await currentRun(page, runConceptId)).toEqual(body.run);
  return body.run;
}

async function actionButtonBox(page: Page, name: string) {
  const button = page.getByRole('button', { name, exact: true });
  await button.scrollIntoViewIfNeeded();
  return button.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      x: rect.x + window.scrollX,
      y: rect.y + window.scrollY,
      height: rect.height,
    };
  });
}

async function passFirstKnowledgePoint(page: Page) {
  const sessionId = await createSession(page);
  const lesson = await page.evaluate(async () => {
    const response = await fetch('/api/lessons/supervised-learning');
    return response.json();
  });
  let run = await currentRun(page);
  let actionBefore: { x: number; y: number; height: number } | undefined;
  while (run.points[0].status !== 'passed') {
    if (!run.pendingProblem) run = await nextProblemAndReload(page, conceptId, true);
    if (run.points[0].streak === 1) {
      actionBefore = await actionButtonBox(page, 'Submit answer');
    }
    run = await answerAndReload(page, true);
  }
  const nextTitle = run.currentPoint?.title;
  if (!nextTitle) throw new Error('Expected a next knowledge point');
  const actionAfter = await actionButtonBox(page, `Next: ${nextTitle}`);
  if (actionBefore) {
    expect(Math.abs(actionAfter.x - actionBefore.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(actionAfter.y - actionBefore.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(actionAfter.height - actionBefore.height)).toBeLessThanOrEqual(1);
  }
  return {
    sessionId,
    run,
    firstTitle: lesson.knowledge_points[0].title as string,
    nextTitle,
  };
}

async function openFirstCheckpoint(page: Page) {
  const run = await currentRun(page);
  const nextTitle = run.currentPoint?.title;
  if (!nextTitle) throw new Error('Expected a next knowledge point');
  const responsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/lessons/${conceptId}/run`) &&
      response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: `Next: ${nextTitle}`, exact: true }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  await expect(page.getByTestId('kp-checkpoint')).toBeVisible();
  return response.json();
}

test('lesson session header shows the active step title', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await createSession(page);
  const run = await currentRun(page);
  expect(run.currentPointId).toBe(run.points[0].id);
  const firstTitle = run.currentPoint?.title as string;
  expect(firstTitle).toBeTruthy();
  await expect(page.locator('section > header h2')).toHaveText(firstTitle);
  await expect(page.getByText(/Activity \d+ of \d+ today/)).toHaveCount(0);
  await expect(page.getByTestId('lesson-step-content').locator(':scope > h2')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'View full lesson' })).toBeVisible();
  if (process.env.TITLES_STEP_SCREENSHOT) {
    await page.screenshot({ path: process.env.TITLES_STEP_SCREENSHOT });
  }
});

test('lesson runner loading state reserves the subtitle slot', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  let releaseRun = () => {};
  const requestGate = new Promise<void>((resolve) => {
    releaseRun = resolve;
  });
  await page.route('**/api/lessons/supervised-learning/run', async (route) => {
    if (route.request().method() === 'POST') await requestGate;
    await route.continue();
  });
  try {
    await createSession(page, true, false);
    await expect(page.getByTestId('lesson-subtitle-skeleton')).toBeVisible();
    if (process.env.TITLES_LOADING_SCREENSHOT) {
      await page.screenshot({ path: process.env.TITLES_LOADING_SCREENSHOT });
    }
  } finally {
    releaseRun();
  }
  await expect(page.getByTestId('lesson-problem')).toBeVisible();
});

test('a passed knowledge point shows its XP checkpoint before the next step', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const { sessionId, run, firstTitle, nextTitle } = await passFirstKnowledgePoint(page);
  expect(run.points[0].xpEarned).toBe(10);
  await expect(page.getByText('Correct · +10 XP')).toBeVisible();
  await expect(page.getByRole('button', { name: `Next: ${nextTitle}`, exact: true })).toBeVisible();

  const advancedRun = await openFirstCheckpoint(page);
  await expect(page.locator('section > header h2')).toHaveText(firstTitle);
  const session = await page.evaluate(async (id) => {
    const response = await fetch(`/api/sessions/${id}`);
    return response.json();
  }, sessionId);
  expect(session.xp.session).toBe(10);
  expect(session.xp.today).toBe(10);
  await expect(page.getByTestId('kp-checkpoint')).toContainText(`✓ ${firstTitle}`);
  await expect(page.getByTestId('kp-checkpoint')).toContainText('+10 XP');
  await expect(
    page.getByText(`Today: ${session.xp.today} / ${session.xp.goal} XP`, { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(`Knowledge point 1 of ${run.points.length} done`, { exact: true }),
  ).toBeVisible();
  const goalBar = page.getByRole('progressbar', { name: "Today's XP goal" });
  await expect
    .poll(async () => Number(await goalBar.getAttribute('aria-valuenow')))
    .toBeGreaterThan(0);
  expect(Number(await goalBar.getAttribute('aria-valuenow'))).toBeCloseTo(
    (session.xp.today / session.xp.goal) * 100,
  );
  await page.waitForTimeout(750);
  if (process.env.TITLES_CHECKPOINT_SCREENSHOT) {
    await page.screenshot({ path: process.env.TITLES_CHECKPOINT_SCREENSHOT });
  }
  await page.screenshot({
    path: `${checkpointScreenshotDir}/checkpoint-desktop.png`,
    fullPage: true,
  });

  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: `${checkpointScreenshotDir}/checkpoint-mobile.png`,
    fullPage: true,
  });

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole('button', { name: `Continue to ${nextTitle}`, exact: true }).click();
  await expect(page.getByRole('heading', { name: nextTitle, exact: true })).toBeVisible();
  await expect(page.getByTestId('lesson-problem')).toBeVisible();
  expect(advancedRun.run.currentPoint.title).toBe(nextTitle);
});

test('stopping at a checkpoint resumes on the next knowledge point', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const { sessionId, nextTitle } = await passFirstKnowledgePoint(page);
  await openFirstCheckpoint(page);
  await page.getByRole('button', { name: 'Stop here', exact: true }).click();
  await expect(page).toHaveURL('/');
  const resume = page.getByRole('link', { name: 'Resume session', exact: true });
  await expect(resume).toBeVisible();
  await resume.click();
  await expect(page).toHaveURL(new RegExp(`/session/${sessionId}$`));
  await expect(page.getByRole('heading', { name: nextTitle, exact: true })).toBeVisible();
  await expect(page.getByTestId('kp-checkpoint')).toHaveCount(0);
  await expect(page.getByTestId('lesson-problem')).toBeVisible();
  const resumedRun = await currentRun(page);
  expect(resumedRun.currentPoint.title).toBe(nextTitle);
  expect(resumedRun.pendingProblem).toBeTruthy();
});

test('passes every knowledge point and restores the exact problem and result after reloads', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const sessionId = await createSession(page);
  const firstStepTitle = await page.evaluate(async () => {
    const response = await fetch('/api/lessons/supervised-learning');
    const lesson = await response.json();
    return lesson.knowledge_points[0].title as string;
  });
  const fitsHeading = page.getByRole('heading', { name: "What you're learning", exact: true });
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
  expect(run.pendingProblem.exercise.role).toBe('basics');
  expect(run.pendingProblem.exercise.id).toBe(`${run.points[0].id}-basics`);
  await expect(page.getByTestId('lesson-problem-prompt')).toContainText(
    'Which statement best describes the main idea in this step?',
  );
  await page.getByTestId('lesson-problem').screenshot({
    path: `${mcShuffleScreenshotDir}/mc.png`,
  });
  const firstDisplayedOption = page.getByRole('radio').first();
  await firstDisplayedOption.focus();
  await page.keyboard.press('1');
  await expect(firstDisplayedOption).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByLabel('0 correct in a row')).toHaveCount(0);
  run = await answerAndReload(page, true);
  expect(run.points[0]).toMatchObject({ status: 'active', answered: 0, streak: 0 });
  await expect(page.getByLabel('0 correct in a row')).toHaveCount(0);
  await expect(page.getByLabel('1 correct in a row')).toHaveCount(0);

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
        await expect(page.getByText('Correct · +10 XP')).toBeVisible();
        await expect(page.getByText('Problem 2 · up to 5')).toBeVisible();
        await expect(page.getByText('Your answer:')).toHaveCount(0);
        await expect(page.getByText('Correct answer:')).toHaveCount(0);
        await page.screenshot({
          path: `${screenshotDir}/knowledge-point-passed.png`,
          fullPage: true,
        });
      }
    }
    if (pointIndex < run.points.length - 1) {
      run = await nextProblemAndReload(page);
      if (pointIndex === 0) {
        await expect(fitsHeading).toHaveCount(0);
        const problem = page.getByTestId('lesson-problem');
        const problemId = await problem.getAttribute('data-problem-id');
        const firstStepButtonName = `Step 1 of ${run.points.length}, passed`;
        const currentStepIndex = run.points.findIndex(
          (point: { id: string }) => point.id === run.currentPointId,
        );
        expect(currentStepIndex).toBe(1);
        const backButtonName = `Back to step ${currentStepIndex + 1}`;

        await expect(problemId).toBeTruthy();
        await page.getByRole('button', { name: firstStepButtonName }).click();
        await expect(
          page.getByRole('heading', { name: firstStepTitle, exact: true }),
        ).toBeVisible();
        await expect(page.getByTestId('lesson-problem')).toHaveCount(0);
        await expect(page.getByRole('button', { name: firstStepButtonName })).toHaveAttribute(
          'aria-current',
          'step',
        );
        if (run.points.length > 2) {
          await expect(
            page.getByText(`Step 3 of ${run.points.length}`, { exact: true }),
          ).toBeVisible();
          await expect(page.getByRole('button', { name: /^Step 3 of/ })).toHaveCount(0);
        }
        await page.screenshot({ path: `${stepReviewScreenshotDir}/desktop-viewing.png` });
        await page.setViewportSize({ width: 390, height: 844 });
        await page.screenshot({ path: `${stepReviewScreenshotDir}/mobile-viewing.png` });
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.getByRole('button', { name: firstStepButtonName }).hover();
        await page.screenshot({ path: `${stepReviewScreenshotDir}/desktop-pills-hover.png` });
        await page.getByRole('button', { name: backButtonName }).first().click();
        await expect(
          page.getByRole('heading', { name: run.currentPoint.title, exact: true }),
        ).toBeVisible();
        await expect(page.getByTestId('lesson-problem')).toHaveAttribute(
          'data-problem-id',
          problemId ?? '',
        );
        await page.screenshot({ path: `${stepReviewScreenshotDir}/desktop-back.png` });
      }
    }
  }

  expect(run.status).toBe('completed');
  expect(run.xpEarned).toBe(40);
  await expect(page.getByText('Lesson complete · +40 XP')).toBeVisible();
  await page.screenshot({ path: `${screenshotDir}/lesson-complete.png`, fullPage: true });
  const firstStepButtonName = `Step 1 of ${run.points.length}, passed`;
  await page.getByRole('button', { name: firstStepButtonName }).click();
  await expect(page.getByRole('heading', { name: firstStepTitle, exact: true })).toBeVisible();
  await expect(page.getByTestId('lesson-problem')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Back to summary' }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Back to summary' }).first().click();
  await expect(page.getByText('Lesson complete · +40 XP')).toBeVisible();
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
  const problemCard = page.getByTestId('session-exercise');
  const submitButton = problemCard.locator('button[type="submit"]');
  const submitButtonBefore = await submitButton.boundingBox();
  if (!submitButtonBefore) throw new Error('Submit answer button is not visible');
  await expect(submitButton.getByTestId('button-spinner')).toHaveCount(0);
  await problemCard.screenshot({ path: `${buttonLoadingScreenshotDir}/submit-idle.png` });
  let markGradingRequestStarted!: () => void;
  let releaseGradingRequest!: () => void;
  const gradingRequestStarted = new Promise<void>((resolve) => {
    markGradingRequestStarted = resolve;
  });
  const gradingRequestGate = new Promise<void>((resolve) => {
    releaseGradingRequest = resolve;
  });
  await page.route('**/api/attempts', async (route) => {
    markGradingRequestStarted();
    await gradingRequestGate;
    const response = await route.fetch();
    await route.fulfill({ response });
  });
  await submitButton.click();
  await gradingRequestStarted;
  await expect(submitButton).toHaveAttribute('aria-busy', 'true');
  await expect(submitButton).toHaveAttribute('data-loading', 'true');
  await expect(submitButton).toBeDisabled();
  await expect(submitButton.getByTestId('button-spinner')).toBeVisible();
  await expect(submitButton.getByText('Submit answer', { exact: true })).not.toBeVisible();
  const submitButtonAfter = await submitButton.boundingBox();
  if (!submitButtonAfter) throw new Error('Loading Submit answer button is not visible');
  expect(Math.abs(submitButtonAfter.width - submitButtonBefore.width)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(submitButtonAfter.height - submitButtonBefore.height)).toBeLessThanOrEqual(0.5);
  await expect
    .poll(() => submitButton.evaluate((element) => getComputedStyle(element).opacity))
    .toBe('1');
  await problemCard.screenshot({ path: `${buttonLoadingScreenshotDir}/submit-busy.png` });
  releaseGradingRequest();
  const selfCheck = page.getByRole('button', { name: 'Submit self-check' });
  const retry = page.getByRole('button', { name: /Try again/ });
  const followUp = page.getByRole('button', { name: 'Submit again' });
  await expect
    .poll(
      async () =>
        (await selfCheck.isVisible()) ||
        (await retry.isVisible()) ||
        (await followUp.isVisible()) ||
        (await page.getByRole('button', { name: 'Continue' }).isVisible()),
    )
    .toBe(true);
  if (await selfCheck.isVisible()) {
    for (const checkbox of await page.getByRole('checkbox').all()) await checkbox.click();
    await selfCheck.click();
  } else if (await retry.isVisible()) {
    await retry.click();
  } else if (await followUp.isVisible()) {
    await followUp.click();
  }
  await expect(page.getByRole('button', { name: 'Continue' })).toBeVisible();
  await page.reload();
  await expect(page.getByText('Model answer', { exact: true })).toBeVisible();
  await expect(page.getByText('Solution', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Your answer:', { exact: true })).toHaveCount(0);
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
  await expect(
    page.getByRole('heading', { name: "What you're learning", exact: true }),
  ).toBeVisible();
});

test('shows a correct lesson-run solution inline when no feedback exists', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const db = createDb(env.TEST_DATABASE_URL);
  const [learner] = await db.select({ id: users.id }).from(users).limit(1);
  if (!learner) throw new Error('Missing E2E learner');
  const [session] = await db
    .insert(studySessions)
    .values({
      userId: learner.id,
      kind: 'weekday',
      plannedMinutes: 20,
      status: 'active',
      startedAt: new Date(),
    })
    .returning();
  if (!session) throw new Error('Could not create practice session');
  const [activity] = await db
    .insert(sessionActivities)
    .values({
      sessionId: session.id,
      idx: 0,
      kind: 'learn',
      conceptId: 'loss-functions',
      exerciseIds: [],
      plannedMinutes: 5,
      status: 'in_progress',
    })
    .returning();
  await db.$client.end();
  if (!activity) throw new Error('Could not create practice activity');

  await page.goto(`/session/${session.id}`);
  await expect(page.getByText('Basics question', { exact: true })).toBeVisible();
  await expect
    .poll(async () => (await currentRun(page, 'loss-functions'))?.pendingProblem?.id)
    .toBeTruthy();
  let run = await currentRun(page, 'loss-functions');
  expect(run.pendingProblem.exercise.id).toBe('loss-functions-fixture-1-basics');
  run = await answerAndReload(page, true, 'loss-functions');
  run = await nextProblemAndReload(page, 'loss-functions');
  expect(run.pendingProblem.exercise.id).toBe('loss-functions-fixture-practice-1');
  run = await answerAndReload(page, true, 'loss-functions');
  expect(run.lastAnsweredProblem.exercise.id).toBe('loss-functions-fixture-practice-1');

  const status = page.getByRole('status');
  await expect(status).toContainText('Correct');
  await expect(status).toContainText('1 + 1 = 2.');
  await expect(page.getByText('Solution', { exact: true })).toHaveCount(0);
  await page.screenshot({
    path: `${feedbackCorrectScreenshotDir}/correct.png`,
    fullPage: true,
  });
});

test('Enter advances a correct knowledge-point answer without another answer POST', async ({
  page,
}) => {
  const db = createDb(env.TEST_DATABASE_URL);
  const [learner] = await db.select({ id: users.id }).from(users).limit(1);
  if (!learner) throw new Error('Missing E2E learner');
  const [session] = await db
    .insert(studySessions)
    .values({
      userId: learner.id,
      kind: 'weekday',
      plannedMinutes: 20,
      status: 'active',
      startedAt: new Date('2026-01-01T12:00:00.000Z'),
    })
    .returning();
  if (!session) throw new Error('Could not create lesson session');
  const [activity] = await db
    .insert(sessionActivities)
    .values({
      sessionId: session.id,
      idx: 0,
      kind: 'learn',
      conceptId: 'loss-functions',
      exerciseIds: [],
      plannedMinutes: 5,
      status: 'in_progress',
    })
    .returning();
  await db.$client.end();
  if (!activity) throw new Error('Could not create lesson activity');

  await page.goto(`/session/${session.id}`);
  await expect(page.getByText('Basics question', { exact: true })).toBeVisible();
  let run = await currentRun(page, 'loss-functions');
  run = await answerAndReload(page, true, 'loss-functions');
  run = await nextProblemAndReload(page, 'loss-functions');
  expect(run.pendingProblem.exercise.id).toBe('loss-functions-fixture-practice-1');
  expect(run.pendingProblem.exercise.type).toBe('numeric');
  const answer = await page.evaluate(async (problemId: string) => {
    const response = await fetch(`/api/test/lesson-problems/${problemId}/answer`);
    return (await response.json()).answer;
  }, run.pendingProblem.id);
  const problemId = run.pendingProblem.id as string;
  let answerPostCount = 0;
  page.on('request', (request) => {
    if (
      request.url().endsWith('/api/lessons/loss-functions/run/answer') &&
      request.method() === 'POST'
    ) {
      answerPostCount += 1;
    }
  });

  const answerField = page.getByLabel('Your answer');
  await answerField.fill(String(answer));
  const answerResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/lessons/loss-functions/run/answer') &&
      response.request().method() === 'POST',
  );
  await answerField.press('Enter');
  expect((await answerResponse).status()).toBe(200);
  await expect(page.getByText('Correct', { exact: true })).toBeVisible();
  await expect(answerField).toBeFocused();

  const nextResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/lessons/loss-functions/run') &&
      response.request().method() === 'POST',
  );
  await answerField.press('Enter');
  await nextResponse;
  await expect(page.getByTestId('lesson-problem')).not.toHaveAttribute(
    'data-problem-id',
    problemId,
  );
  await expect(page.getByText('Not quite', { exact: true })).toHaveCount(0);
  expect(answerPostCount).toBe(1);
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
  await expect(page.getByText('Basics question', { exact: true })).toBeVisible();
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
  await expect(page.locator('section > header h2')).toHaveText('Lesson complete');
  await expect(page.getByRole('heading', { name: /^Lesson complete · \+\d+ XP$/ })).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.locator('section > header h2')).toHaveText('Final question');
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
  const followUp = page.getByRole('button', { name: 'Submit again' });
  const continueButton = page.getByRole('button', { name: 'Continue' });
  await expect
    .poll(
      async () =>
        (await selfCheck.isVisible()) ||
        (await retry.isVisible()) ||
        (await followUp.isVisible()) ||
        (await continueButton.isVisible()),
    )
    .toBe(true);
  if (await selfCheck.isVisible()) {
    for (const checkbox of await page.getByRole('checkbox').all()) await checkbox.click();
    await selfCheck.click();
  } else if (await retry.isVisible()) {
    await retry.click();
  } else if (await followUp.isVisible()) {
    await followUp.click();
  }
  await expect(page.getByText('Model answer', { exact: true })).toBeVisible();
  await expect(page.getByText('Partly correct', { exact: true })).toBeVisible();
  await expect(page.getByText('Your answer:', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Your answer')).toHaveAttribute('readonly', '');
  await page.screenshot({
    path: `${finalContinueScreenshotDir}/after-submit.png`,
    fullPage: true,
  });
  await continueButton.click();
  await expect(page.getByRole('heading', { name: 'Session complete', exact: true })).toBeVisible();
  await expect(page.getByText('Your answer:', { exact: true })).toHaveCount(0);
  await page.screenshot({
    path: `${finalContinueScreenshotDir}/after-single-continue.png`,
    fullPage: true,
  });
  const completed = await page.evaluate(
    async ({ sessionId, activityId }) => {
      const response = await fetch(`/api/sessions/${sessionId}`);
      const data = await response.json();
      return data.activities.find((item: { id: string }) => item.id === activityId);
    },
    { sessionId: session.id, activityId: activity.id },
  );
  expect(completed.status).toBe('completed');
  expect(completed.progress.finalQuestionContinued).toBe(true);
  expect(completed.lastAttempt.exerciseId).toBe('vectors-fixture-final');
});

test('a failed knowledge point shows the retry screen and resumes at round two if scheduled again', async ({
  page,
}) => {
  await createSession(page);
  let run = await currentRun(page);
  const firstProblemId = run.pendingProblem.id;
  for (let answerIndex = 0; answerIndex < 5; answerIndex += 1) {
    run = await answerAndReload(page, false);
    if (answerIndex === 0) {
      expect(run.points[0]).toMatchObject({ status: 'active', answered: 0, streak: 0 });
    }
    if (answerIndex === 0) {
      await expect(page.getByText('Your answer:')).toHaveCount(0);
      await expect(page.getByText('Correct answer:')).toHaveCount(0);
      await page.screenshot({ path: `${screenshotDir}/wrong-answer.png`, fullPage: true });
    }
    if (answerIndex < 4) run = await nextProblemAndReload(page);
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
  await expect(page.getByText('Basics question', { exact: true })).toBeVisible();
  await page.screenshot({ path: `${screenshotDir}/round-two-retry.png`, fullPage: true });
});
