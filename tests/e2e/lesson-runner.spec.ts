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
const stepToastScreenshotDir = '/home/ubuntu/screenshots/step-toast';
const lessonQuizScreenshotDir = '/home/ubuntu/shots/lesson-quiz';
const quizUiScreenshotDir = '/home/ubuntu/screenshots/quiz-ui';
const spacedReviewScreenshotDir = '/home/ubuntu/screenshots/spaced-review';
mkdirSync(screenshotDir, { recursive: true });
mkdirSync(lessonCardScreenshotDir, { recursive: true });
mkdirSync(stepReviewScreenshotDir, { recursive: true });
mkdirSync(feedbackCorrectScreenshotDir, { recursive: true });
mkdirSync(mcShuffleScreenshotDir, { recursive: true });
mkdirSync(buttonLoadingScreenshotDir, { recursive: true });
mkdirSync(finalContinueScreenshotDir, { recursive: true });
mkdirSync(quizUiScreenshotDir, { recursive: true });
mkdirSync(stepToastScreenshotDir, { recursive: true });
mkdirSync(lessonQuizScreenshotDir, { recursive: true });
mkdirSync(spacedReviewScreenshotDir, { recursive: true });

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

async function expectToastInViewport(page: Page, text: string) {
  const toast = page.locator('[data-sonner-toast]').filter({ hasText: text });
  await expect(toast).toBeVisible();
  const viewport = page.viewportSize();
  if (!viewport) throw new Error('Expected a viewport size');
  await expect
    .poll(async () => {
      const bounds = await toast.boundingBox();
      return (
        bounds !== null &&
        bounds.x >= 0 &&
        bounds.x + bounds.width <= viewport.width &&
        bounds.y >= 0 &&
        bounds.y + bounds.height <= viewport.height
      );
    })
    .toBe(true);
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
  if (body.state.status === 'in_progress') {
    await expect(page.getByRole('status')).toContainText(correct ? 'Correct' : 'Not quite');
    await expect(page.getByTestId('lesson-problem')).toHaveAttribute('data-problem-id', problem.id);
    await expect(page.getByTestId('lesson-problem-prompt')).toBeVisible();
  } else {
    await expect(page.getByTestId('lesson-steps-complete')).toBeVisible();
  }
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
  const advancesStep = buttonName.startsWith('Next: ');
  const checkScroll = advancesStep || buttonName === 'Next step' || assertWithinStepScroll;
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
  if (advancesStep) {
    await expect(
      page.getByRole('heading', { name: body.run.currentPoint.title, exact: true }),
    ).toBeVisible();
    await expect(page.getByTestId('lesson-problem')).toBeVisible();
    await expect(page.getByTestId('kp-checkpoint')).toHaveCount(0);
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
  await expect(page.getByText(/^Question \d+$/)).toBeVisible();
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

async function advanceToNextStep(page: Page) {
  const run = await currentRun(page);
  const nextTitle = run.currentPoint?.title;
  if (!nextTitle) throw new Error('Expected a next knowledge point');
  const responsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/lessons/${conceptId}/run`) &&
      response.request().method() === 'POST',
  );
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  await page.getByRole('button', { name: `Next: ${nextTitle}`, exact: true }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  const body = await response.json();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await expect(page.getByRole('heading', { name: nextTitle, exact: true })).toBeVisible();
  await expect(page.getByTestId('lesson-problem')).toBeVisible();
  await expect(page.getByTestId('kp-checkpoint')).toHaveCount(0);
  return body.run;
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

test('a passed knowledge point opens the next step and shows an XP toast', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const { sessionId, run, nextTitle } = await passFirstKnowledgePoint(page);
  expect(run.points[0].xpEarned).toBe(10);
  await expect(page.getByText('Correct · +10 XP')).toBeVisible();
  await expect(page.getByRole('button', { name: `Next: ${nextTitle}`, exact: true })).toBeVisible();

  const advancedRun = await advanceToNextStep(page);
  await expect(page.locator('section > header h2')).toHaveText(nextTitle);
  const session = await page.evaluate(async (id) => {
    const response = await fetch(`/api/sessions/${id}`);
    return response.json();
  }, sessionId);
  expect(session.xp.session).toBe(10);
  expect(session.xp.today).toBe(10);
  await expect(page.getByTestId('kp-checkpoint')).toHaveCount(0);
  const toastTitle = 'Step 1 done';
  const toastDescription = `+${run.points[0].xpEarned} XP · Today: ${session.xp.today} / ${session.xp.goal} XP`;
  await expect(page.getByText(toastTitle, { exact: true })).toBeVisible();
  await expect(page.getByText(toastDescription, { exact: true })).toBeVisible();
  await expectToastInViewport(page, toastTitle);
  const [toastFont, appFont] = await Promise.all([
    page
      .locator('[data-sonner-toaster]')
      .evaluate((element) => getComputedStyle(element).fontFamily),
    page.locator('body').evaluate((element) => getComputedStyle(element).fontFamily),
  ]);
  expect(toastFont).toBe(appFont);
  await page.screenshot({ path: `${stepToastScreenshotDir}/desktop.png` });

  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await expect(page.getByText(toastTitle, { exact: true })).toBeVisible();
  await expect(page.getByText(toastDescription, { exact: true })).toBeVisible();
  await expectToastInViewport(page, toastTitle);
  await page.screenshot({ path: `${stepToastScreenshotDir}/mobile.png` });
  await expect(page.getByRole('heading', { name: nextTitle, exact: true })).toBeVisible();
  await expect(page.getByTestId('lesson-problem')).toBeVisible();
  expect(advancedRun.currentPoint.title).toBe(nextTitle);
});

test('leaving after a step resumes on the next knowledge point', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const { sessionId, nextTitle } = await passFirstKnowledgePoint(page);
  await advanceToNextStep(page);
  await page
    .locator('nav[aria-label="Main navigation"]')
    .getByRole('link', { name: 'Home' })
    .click();
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
  await expect(fitsHeading).toHaveCount(0);
  await expect(
    page.getByText('Many useful tasks start with examples whose correct answers are already known'),
  ).toBeVisible();
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
  await expect(page.getByText('Question 1', { exact: true })).toBeVisible();
  await page.screenshot({ path: `${lessonQuizScreenshotDir}/step-question.png`, fullPage: true });
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
  await expect(page.getByLabel('0 correct in a row')).toBeVisible();
  run = await answerAndReload(page, true);
  expect(run.points[0]).toMatchObject({ status: 'active', answered: 1, streak: 1 });
  await expect(page.getByLabel('1 correct in a row')).toBeVisible();

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
        await expect(page.getByText('Question 2', { exact: true })).toBeVisible();
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
        const backButtonName = 'Back';

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
          await expect(page.getByText('Step 3', { exact: true })).toBeVisible();
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

  expect(run.status).toBe('quiz');
  expect(run.xpEarned).toBe(40);
  await expect(page.getByTestId('lesson-steps-complete')).toBeVisible();
  await page.screenshot({ path: `${screenshotDir}/lesson-steps-complete.png`, fullPage: true });
  const firstStepButtonName = `Step 1 of ${run.points.length}, passed`;
  await page.getByRole('button', { name: firstStepButtonName }).click();
  await expect(page.getByRole('heading', { name: firstStepTitle, exact: true })).toBeVisible();
  await expect(page.getByTestId('lesson-problem')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Back', exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Back', exact: true }).first().click();
  await expect(page.getByTestId('lesson-steps-complete')).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();
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
  expect(finalActivity.status).toBe('in_progress');
  expect(finalActivity.progress.completedExerciseIds).toContain('sl-explain-setup');
  expect(finalActivity.lastAttempt.exerciseId).toBe('sl-explain-setup');
  expect(finalActivity.lastAttempt.status).toBe('graded');
  expect(finalActivity.lastAttempt.yourAnswer).toContain('Predict delivery time');
  expect(page.url()).toContain(`/session/${sessionId}`);
  await page.goto('/lessons/supervised-learning');
  await expect(
    page.getByRole('heading', { name: "What you're learning", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText('Many useful tasks start with examples whose correct answers are already known'),
  ).toBeVisible();
});

test('shows a correct lesson-run solution without repeating generic feedback', async ({ page }) => {
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
  await expect(page.getByText('Question 1', { exact: true })).toBeVisible();
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
  await expect(status.getByText(/^Correct(?: · \+\d+ XP)?$/)).toHaveCount(1);
  await expect(status.getByText('Correct.', { exact: true })).toHaveCount(0);
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
  await expect(page.getByText('Question 1', { exact: true })).toBeVisible();
  let run = await currentRun(page, 'loss-functions');
  run = await answerAndReload(page, false, 'loss-functions');
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
  await expect(page.getByText(/^Correct(?: · \+\d+ XP)?$/)).toHaveCount(1);
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
  await expect(page.getByText('Question 1', { exact: true })).toBeVisible();
  await expect
    .poll(async () => (await currentRun(page, 'vectors'))?.pendingProblem?.id)
    .toBeTruthy();
  let run = await currentRun(page, 'vectors');
  expect(run.currentPointId).toBe('vectors-fixture-1');
  expect(run.points[0]).toMatchObject({ status: 'active', round: 1, answered: 0 });

  while (run.status === 'in_progress') {
    run = run.pendingProblem
      ? await answerAndReload(page, true, 'vectors')
      : await nextProblemAndReload(page, 'vectors');
  }
  expect(run.status).toBe('quiz');
  await expect(page.getByTestId('lesson-steps-complete')).toBeVisible();
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
  const nextStep = page.getByTestId('almost-next-step');
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
    await expect(nextStep).toBeVisible();
    await expect(nextStep).toContainText('Submit again');
    await expect(nextStep).toContainText('one more try');
    await followUp.click();
    await expect(nextStep).toHaveCount(0);
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
  await expect(page.getByTestId('lesson-quiz-intro')).toBeVisible();
  await expect(page.getByText('Your answer:', { exact: true })).toHaveCount(0);
  await page.screenshot({
    path: `${finalContinueScreenshotDir}/after-single-continue.png`,
    fullPage: true,
  });
  const continued = await page.evaluate(
    async ({ sessionId, activityId }) => {
      const response = await fetch(`/api/sessions/${sessionId}`);
      const data = await response.json();
      return data.activities.find((item: { id: string }) => item.id === activityId);
    },
    { sessionId: session.id, activityId: activity.id },
  );
  expect(continued.status).toBe('in_progress');
  expect(continued.progress.finalQuestionContinued).toBe(true);
  expect(continued.lastAttempt.exerciseId).toBe('vectors-fixture-final');
});

test('a knowledge point keeps serving questions after five misses in the same round', async ({
  page,
}) => {
  await createSession(page);
  let run = await currentRun(page);
  for (let answerIndex = 0; answerIndex < 6; answerIndex += 1) {
    run = await answerAndReload(page, false);
    if (answerIndex === 0) {
      expect(run.points[0]).toMatchObject({ status: 'active', answered: 1, streak: 0 });
    }
    if (answerIndex === 0) {
      await expect(page.getByText('Your answer:')).toHaveCount(0);
      await expect(page.getByText('Correct answer:')).toHaveCount(0);
      await page.screenshot({ path: `${screenshotDir}/wrong-answer.png`, fullPage: true });
    }
    if (answerIndex < 5) run = await nextProblemAndReload(page);
  }
  expect(run.status).toBe('in_progress');
  expect(run.points[0]).toMatchObject({ status: 'active', round: 1, answered: 6 });
  await expect(page.getByText('Try again later')).toHaveCount(0);
  run = await nextProblemAndReload(page);
  expect(run.pendingProblem).toMatchObject({ round: 1, position: 7 });
  expect(run.points[0]).toMatchObject({ status: 'active', round: 1, answered: 6 });
  await expect(page.getByText('Question 7', { exact: true })).toBeVisible();
});

test('lesson quiz results are hidden until submit, resume after reload, and allow review after passing', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const sessionId = await createSession(page);
  const quizChip = page.getByTestId('lesson-quiz-chip');
  await expect(quizChip).toHaveAttribute('aria-label', 'Lesson quiz, upcoming');
  await page.screenshot({ path: `${quizUiScreenshotDir}/step-row-desktop.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${quizUiScreenshotDir}/step-row-mobile.png` });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.setViewportSize({ width: 1280, height: 900 });
  const prepared = await page.evaluate(
    async ({ conceptId, sessionId }) => {
      const sessionResponse = await fetch(`/api/sessions/${sessionId}`);
      const session = await sessionResponse.json();
      const activity = session.activities.find(
        (item: { conceptId?: string }) => item.conceptId === conceptId,
      );
      let run = (await (await fetch(`/api/lessons/${conceptId}/run`)).json()).run;
      for (let count = 0; run.status === 'in_progress' && count < 200; count += 1) {
        if (!run.pendingProblem) {
          run = (
            await (
              await fetch(`/api/lessons/${conceptId}/run`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ activityId: activity.id }),
              })
            ).json()
          ).run;
          continue;
        }
        const answer = await (
          await fetch(`/api/test/lesson-problems/${run.pendingProblem.id}/answer`)
        ).json();
        const response = await fetch(`/api/lessons/${conceptId}/run/answer`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            problemId: run.pendingProblem.id,
            answer: answer.answer,
            activityId: activity.id,
          }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error ?? 'Could not answer lesson step');
        run = result.state;
      }
      if (run.status !== 'quiz') throw new Error('Lesson steps did not reach the quiz');
      return { activityId: activity.id, questionCount: run.quiz.questionCount };
    },
    { conceptId, sessionId },
  );
  await page.reload();
  await expect(page.getByTestId('lesson-steps-complete')).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByTestId('exercise-prompt')).toContainText('Pick any real problem');
  await page
    .getByLabel('Your answer')
    .fill(
      'Inputs are distance and time of day; the target is delivery time. A linear model combines the inputs, squared error measures mistakes, and past deliveries provide the data.',
    );
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
  await continueButton.click();
  await expect(page.getByTestId('lesson-quiz-intro')).toBeVisible();
  await expect(quizChip).toHaveAttribute('aria-label', 'Lesson quiz, current');
  await page.screenshot({ path: `${lessonQuizScreenshotDir}/quiz-intro.png`, fullPage: true });
  await page.getByRole('button', { name: 'Start quiz' }).click();
  await expect(page.getByTestId('lesson-quiz-question')).toBeVisible();
  await page.screenshot({ path: `${lessonQuizScreenshotDir}/quiz-question.png`, fullPage: true });
  await expect(page.getByRole('button', { name: 'Open tutor' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Ask the tutor' })).toBeDisabled();

  const answerAttempt = async (wrong: boolean, oneWrong = false) =>
    page.evaluate(
      async ({ conceptId, activityId, wrong, oneWrong }) => {
        let run = (await (await fetch(`/api/lessons/${conceptId}/run`)).json()).run;
        let wrongUsed = false;
        for (const item of run.quiz.current.items) {
          if (item.answered) continue;
          const expected = await (
            await fetch(`/api/test/lesson-quiz-items/${item.id}/answer`)
          ).json();
          let answer = expected.answer;
          const makeWrong = wrong || (oneWrong && !wrongUsed);
          if (makeWrong) {
            wrongUsed = true;
            if (item.exercise.type === 'mc') {
              const correctIds = Array.isArray(answer) ? answer : [answer];
              const other = item.exercise.options.find(
                (option: { id: string }) => !correctIds.includes(option.id),
              )?.id;
              answer = item.exercise.multi ? [other] : other;
            } else if (typeof answer === 'number') {
              answer += 1_000_000;
            } else {
              answer = `${String(answer)} incorrect`;
            }
          }
          const response = await fetch(`/api/lessons/${conceptId}/quiz/answer`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ itemId: item.id, answer, activityId }),
          });
          const result = await response.json();
          if (!response.ok) throw new Error(result.error ?? 'Could not save quiz answer');
          run = result.run;
        }
        const response = await fetch(`/api/lessons/${conceptId}/quiz/submit`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ activityId }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error ?? 'Could not submit quiz');
        return result.run;
      },
      { conceptId, activityId: prepared.activityId, wrong, oneWrong },
    );

  const firstItem = await page.evaluate(async (concept) => {
    const run = await (await fetch(`/api/lessons/${concept}/run`)).json();
    return run.run.quiz.current.items[0];
  }, conceptId);
  const firstAnswer = await page.evaluate(
    async ({ concept, item, activityId }) => {
      const expected = await (await fetch(`/api/test/lesson-quiz-items/${item.id}/answer`)).json();
      let answer = expected.answer;
      if (item.exercise.type === 'mc') {
        const correctIds = Array.isArray(answer) ? answer : [answer];
        const other = item.exercise.options.find(
          (option: { id: string }) => !correctIds.includes(option.id),
        )?.id;
        answer = item.exercise.multi ? [other] : other;
      } else if (typeof answer === 'number') {
        answer += 1_000_000;
      } else {
        answer = `${String(answer)} incorrect`;
      }
      const response = await fetch(`/api/lessons/${concept}/quiz/answer`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ itemId: item.id, answer, activityId }),
      });
      return response.status;
    },
    { concept: conceptId, item: firstItem, activityId: prepared.activityId },
  );
  expect(firstAnswer).toBe(200);
  await page.reload();
  await expect(page.getByTestId('lesson-quiz-question')).toBeVisible();
  await answerAttempt(true);
  await page.reload();
  const failed = page.getByTestId('lesson-quiz-results');
  await expect(failed).toContainText('Not passed yet');
  await expect(failed.getByText(/^Step \d+ · /).first()).toBeVisible();
  await expect(failed.getByText(/Your answer:|Correct answer:|Question \d+/)).toHaveCount(0);
  await expect(failed).toContainText(
    'Before you retake it, answer 3 more questions on each step you missed.',
  );
  const requiredReviews = (await currentRun(page)).quiz.reviewRequired as Array<{
    pointId: string;
    answered: number;
    needed: number;
  }>;
  expect(requiredReviews.length).toBeGreaterThan(0);
  const reviewStepButton = failed.getByRole('button', { name: 'Review · 0/3' }).first();
  await expect(reviewStepButton).toBeVisible();
  await expect(failed.getByRole('button', { name: 'Retake quiz' })).toBeDisabled();
  await page.screenshot({
    path: `${spacedReviewScreenshotDir}/failed-quiz-pending-desktop.png`,
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: `${spacedReviewScreenshotDir}/failed-quiz-pending-mobile.png`,
    fullPage: true,
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await reviewStepButton.click();
  await expect(page.getByRole('button', { name: 'Back to quiz results' })).toBeVisible();
  await expect(page.getByTestId('lesson-quiz-chip')).toBeVisible();
  await page.screenshot({
    path: `${spacedReviewScreenshotDir}/failed-step-back-desktop.png`,
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: `${spacedReviewScreenshotDir}/failed-step-back-mobile.png`,
    fullPage: true,
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByTestId('lesson-quiz-chip').click();
  await expect(page.getByTestId('lesson-quiz-results')).toBeVisible();
  const reviewStepAfterReturn = page
    .getByTestId('lesson-quiz-results')
    .getByRole('button', { name: 'Review · 0/3' })
    .first();
  await reviewStepAfterReturn.click();
  await expect(page.getByRole('button', { name: 'Practise this step' })).toBeVisible();
  await page.getByRole('button', { name: 'Practise this step' }).click();
  await expect(page.getByTestId('lesson-problem')).toBeVisible();
  const firstPracticeRun = await currentRun(page);
  const firstPractice = firstPracticeRun.pendingPracticeProblem;
  const practiceAnswer = await page.evaluate(async (id) => {
    const response = await fetch(`/api/test/lesson-problems/${id}/answer`);
    return response.json();
  }, firstPractice.id);
  if (firstPractice.exercise.type === 'mc') {
    const ids = Array.isArray(practiceAnswer.answer)
      ? practiceAnswer.answer
      : [practiceAnswer.answer];
    for (const id of ids) {
      await page.locator(`[id="${firstPractice.exercise.id}-${id}"]`).click();
    }
  } else {
    await page.getByLabel('Your answer').fill(String(practiceAnswer.answer));
  }
  let uiPracticeTime = Date.parse('2026-01-01T12:01:00.000Z');
  await page.route(`**/api/lessons/${conceptId}/run/answer`, async (route) => {
    uiPracticeTime += 1_000;
    await route.continue({
      headers: {
        ...route.request().headers(),
        'x-now': new Date(uiPracticeTime).toISOString(),
      },
    });
  });
  await page.getByRole('button', { name: 'Submit answer' }).click();
  await expect
    .poll(async () => {
      const run = await currentRun(page);
      return run.quiz.reviewRequired.find(
        (step: { pointId: string }) => step.pointId === firstPractice.knowledgePointId,
      )?.answered;
    })
    .toBe(1);
  await page.getByTestId('lesson-quiz-chip').click();
  await expect(
    page.getByTestId('lesson-quiz-results').getByRole('button', { name: 'Review · 1/3' }),
  ).toBeVisible();
  await page
    .getByTestId('lesson-quiz-results')
    .getByRole('button', { name: 'Review · 1/3' })
    .click();
  await page.getByRole('button', { name: 'Practise this step' }).click();
  await expect.poll(async () => (await currentRun(page)).pendingPracticeProblem?.id).toBeTruthy();
  const nextPractice = (await currentRun(page)).pendingPracticeProblem;
  if (!nextPractice) throw new Error('Expected a fresh practice question');
  expect(nextPractice.id).not.toBe(firstPractice.id);
  await page.reload();
  const reloadedRun = await currentRun(page);
  expect(reloadedRun.pendingPracticeProblem?.id).toBe(nextPractice.id);
  expect(reloadedRun.pendingPracticeProblem?.answeredAt).toBeNull();
  await expect(page.getByRole('button', { name: 'Back to quiz results' })).toBeVisible();
  await expect(page.getByTestId('lesson-problem')).toHaveAttribute(
    'data-problem-id',
    nextPractice.id,
  );
  if (nextPractice.exercise.type === 'mc') {
    const choice = page.getByTestId('lesson-problem').getByRole('radio').first();
    await expect(choice).toBeEnabled();
    await expect(choice).not.toBeChecked();
  } else {
    const answer = page.getByTestId('lesson-problem').getByLabel('Your answer');
    await expect(answer).toBeEnabled();
    await expect(answer).toHaveValue('');
  }
  await expect(page.getByTestId('lesson-problem').getByRole('status')).toHaveCount(0);
  await page.getByTestId('lesson-quiz-chip').click();
  const practiceStatus = await page.evaluate(
    async ({ concept, activityId, requiredReviews }) => {
      let practiceTime = Date.parse('2026-01-01T12:00:00.000Z');
      for (const step of requiredReviews) {
        for (let count = step.answered; count < step.needed; count += 1) {
          let run = (await (await fetch(`/api/lessons/${concept}/run`)).json()).run;
          let pending = run.pendingPracticeProblem;
          if (!pending) {
            practiceTime += 1_000;
            const response = await fetch(`/api/lessons/${concept}/run/practice`, {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                'x-now': new Date(practiceTime).toISOString(),
              },
              body: JSON.stringify({ pointId: step.pointId, activityId }),
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error ?? 'Could not start step practice');
            run = data.run;
            pending = run.pendingPracticeProblem;
          }
          const expected = await (
            await fetch(`/api/test/lesson-problems/${pending.id}/answer`)
          ).json();
          practiceTime += 1_000;
          const response = await fetch(`/api/lessons/${concept}/run/answer`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-now': new Date(practiceTime).toISOString(),
            },
            body: JSON.stringify({
              problemId: pending.id,
              answer: expected.answer,
              activityId,
            }),
          });
          const data = await response.json();
          if (!response.ok) throw new Error(data.error ?? 'Could not answer step practice');
        }
      }
      return (await (await fetch(`/api/lessons/${concept}/run`)).json()).run.quiz.reviewRequired;
    },
    {
      concept: conceptId,
      activityId: prepared.activityId,
      requiredReviews: (await currentRun(page)).quiz.reviewRequired,
    },
  );
  expect(practiceStatus.every((step: { answered: number }) => step.answered === 3)).toBe(true);
  await page.reload();
  const reviewedFailure = page.getByTestId('lesson-quiz-results');
  await expect(reviewedFailure.getByText('✓ Reviewed').first()).toBeVisible();
  await expect(reviewedFailure.getByRole('button', { name: 'Retake quiz' })).toBeEnabled();
  await page.screenshot({ path: `${lessonQuizScreenshotDir}/failed-results.png`, fullPage: true });
  await page.getByRole('button', { name: 'Retake quiz' }).click();
  await expect(page.getByTestId('lesson-quiz-question')).toBeVisible();
  await answerAttempt(false, true);
  await page.reload();
  const passed = page.getByTestId('lesson-quiz-results');
  await expect(passed).toContainText(/^Quiz passed ·/);
  await expect(passed.getByRole('heading')).not.toContainText('XP');
  await expect(passed.getByText(/^\+\d+ XP$/)).toBeVisible();
  await expect(quizChip).toHaveAttribute('aria-label', 'Lesson quiz, passed');
  await expect(quizChip).toContainText('✓ Quiz');
  const seeAnswers = passed.getByRole('button', { name: 'See answers' });
  const retake = passed.getByRole('button', { name: 'Retake quiz' });
  const resultsContinueButton = passed.getByRole('button', { name: 'Continue' });
  const [seeBounds, retakeBounds, continueBounds] = await Promise.all([
    seeAnswers.boundingBox(),
    retake.boundingBox(),
    resultsContinueButton.boundingBox(),
  ]);
  if (!seeBounds || !retakeBounds || !continueBounds) {
    throw new Error('Quiz result buttons should be visible');
  }
  expect(seeBounds.x).toBeLessThan(retakeBounds.x);
  expect(retakeBounds.x).toBeLessThan(continueBounds.x);
  await page.screenshot({ path: `${lessonQuizScreenshotDir}/passed-results.png`, fullPage: true });
  await page.screenshot({ path: `${quizUiScreenshotDir}/passed-desktop.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: `${quizUiScreenshotDir}/passed-mobile.png`, fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.route(`**/api/lessons/${conceptId}/quiz/*/review`, async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    data.items[0].yourAnswer = '$-1$';
    await route.fulfill({ response, json: data });
  });
  await seeAnswers.click();
  const review = page.getByTestId('lesson-quiz-review');
  const mathAnswer = review
    .locator('article')
    .first()
    .locator('p')
    .filter({ hasText: 'Your answer:' });
  await expect(mathAnswer.locator('.katex')).toBeVisible();
  await expect(mathAnswer).not.toContainText('$');
  const wrongMark = review
    .locator('[data-testid="quiz-review-mark"][data-correct="false"]')
    .first();
  const rightMark = review.locator('[data-testid="quiz-review-mark"][data-correct="true"]').first();
  await expect(wrongMark).toContainText('Incorrect');
  await expect(
    wrongMark.locator('xpath=ancestor::article').getByText('Correct answer:'),
  ).toBeVisible();
  await expect(rightMark).toContainText('Correct');
  await expect(
    rightMark.locator('xpath=ancestor::article').getByText('Correct answer:'),
  ).toHaveCount(0);
  await page.screenshot({ path: `${quizUiScreenshotDir}/review-desktop.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: `${quizUiScreenshotDir}/review-mobile.png`, fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(review).toContainText('Correct answer:');
  await page.screenshot({ path: `${lessonQuizScreenshotDir}/see-answers.png`, fullPage: true });
  await page.getByRole('button', { name: 'Back to results' }).click();
  await page.getByRole('button', { name: 'Retake quiz' }).click();
  await expect(page.getByTestId('lesson-quiz-question')).toBeVisible();
  await answerAttempt(true);
  await page.reload();
  const failedRetake = page.getByTestId('lesson-quiz-results');
  await expect(failedRetake).toContainText('Retake not passed');
  await expect(failedRetake).toContainText('Your lesson quiz is already passed.');
  await expect(failedRetake.getByText(/^Step \d+ · /).first()).toBeVisible();
  await expect(failedRetake.getByRole('button', { name: 'See answers' })).toHaveCount(0);
  await expect(failedRetake.getByText(/Your answer:|Correct answer:|Question \d+/)).toHaveCount(0);
  expect(prepared.questionCount).toBeGreaterThan(0);
});
