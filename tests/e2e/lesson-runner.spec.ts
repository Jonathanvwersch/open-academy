import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { eq } from 'drizzle-orm';
import { env } from '../../apps/api/src/config.js';
import { createDb } from '../../apps/api/src/db/client.js';
import {
  attempts,
  lessonProblems,
  lessonQuizItems,
  lessonRuns,
  sessionActivities,
  studySessions,
  users,
} from '../../apps/api/src/db/schema.js';
import { enrollInDefaultCourse } from './course-start.js';

const conceptId = 'supervised-learning';
const screenshotDir = 'test-results/screenshots/screenshots/shadcn';
const lessonCardScreenshotDir = 'test-results/screenshots/screenshots/lesson-cards';
const stepReviewScreenshotDir = 'test-results/screenshots/ui-audit/step-review';
const feedbackCorrectScreenshotDir = 'test-results/screenshots/screenshots/feedback-correct';
const mcShuffleScreenshotDir = 'test-results/screenshots/screenshots/mc-shuffle';
const buttonLoadingScreenshotDir = 'test-results/screenshots/screenshots/button-loading';
const finalContinueScreenshotDir = 'test-results/screenshots/screenshots/final-continue';
const stepToastScreenshotDir = 'test-results/screenshots/screenshots/step-toast';
const lessonQuizScreenshotDir = 'test-results/screenshots/shots/lesson-quiz';
const quizUiScreenshotDir = 'test-results/screenshots/screenshots/quiz-ui';
const spacedReviewScreenshotDir = 'test-results/screenshots/screenshots/spaced-review';
const lastTryScreenshotDir = 'test-results/screenshots/last-try';
const failedQuizScreenshotDir = 'test-results/screenshots/failed-quiz';
const quizRetryScreenshotDir = 'test-results/screenshots/quiz-retry';
const quizReviseScreenshotDir = 'test-results/screenshots/quiz-revise';
const explainItScreenshotDir = 'test-results/screenshots/explain-it';
const answerAutofocusScreenshotDir = 'test-results/screenshots/answer-autofocus';
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
mkdirSync(lastTryScreenshotDir, { recursive: true });
mkdirSync(failedQuizScreenshotDir, { recursive: true });
mkdirSync(quizRetryScreenshotDir, { recursive: true });
mkdirSync(quizReviseScreenshotDir, { recursive: true });
mkdirSync(explainItScreenshotDir, { recursive: true });
mkdirSync(answerAutofocusScreenshotDir, { recursive: true });

type QuizItemForForm = {
  id: string;
  exercise: {
    id: string;
    type: string;
    multi?: boolean;
    options?: Array<{ id: string; text: string }>;
    code?: string;
    fix_options?: Array<{ id: string; text: string }>;
  };
};

function wrongQuizAnswer(item: QuizItemForForm, answer: unknown): unknown {
  if (item.exercise.type === 'mc') {
    const correctIds = new Set(Array.isArray(answer) ? answer : [answer]);
    const wrongOption = item.exercise.options?.find((option) => !correctIds.has(option.id));
    return item.exercise.multi ? [wrongOption?.id ?? 'incorrect-option'] : wrongOption?.id;
  }
  if (item.exercise.type === 'debug') {
    const correct = answer as { line: number; fixId: string };
    const lineCount = item.exercise.code?.split(/\\n|\n/).length ?? 0;
    const wrongLine = correct.line === 1 ? 2 : 1;
    const wrongFix = item.exercise.fix_options?.find((option) => option.id !== correct.fixId);
    return {
      line: wrongLine <= lineCount ? wrongLine : correct.line + 1,
      fixId: wrongFix?.id ?? '',
    };
  }
  return typeof answer === 'number' ? answer + 1_000_000 : `${String(answer)} incorrect`;
}

async function fillQuizAnswer(page: Page, item: QuizItemForForm, answer: unknown) {
  if (item.exercise.type === 'mc') {
    const selectedIds = new Set(
      (Array.isArray(answer) ? answer : [answer]).filter(
        (value): value is string => typeof value === 'string',
      ),
    );
    for (const option of item.exercise.options ?? []) {
      const controlId = `${item.exercise.id}-${option.id}`;
      const control = page.locator(`#${controlId}`);
      const selected = (await control.getAttribute('aria-checked')) === 'true';
      if (selected !== selectedIds.has(option.id)) {
        await page.locator(`label[for="${controlId}"]`).click();
      }
    }
    return;
  }
  if (item.exercise.type === 'debug') {
    const value = answer as { line: number; fixId: string };
    const fix = item.exercise.fix_options?.find((option) => option.id === value.fixId);
    if (!fix) throw new Error(`Missing debug fix option ${value.fixId}`);
    await page.getByLabel('Buggy line').click();
    await page.getByRole('option', { name: `Line ${value.line}` }).click();
    await page.getByLabel('Fix').click();
    await page.getByRole('option').filter({ hasText: fix.text }).click();
    return;
  }
  const value =
    typeof answer === 'object' && answer !== null && 'text' in answer
      ? (answer as { text: unknown }).text
      : answer;
  await page.getByLabel('Your answer').fill(String(value ?? ''));
}

async function expectQuizAnswerPrefilled(page: Page, item: QuizItemForForm, answer: unknown) {
  if (item.exercise.type === 'mc') {
    const selectedIds = new Set(
      (Array.isArray(answer) ? answer : [answer]).filter(
        (value): value is string => typeof value === 'string',
      ),
    );
    for (const option of item.exercise.options ?? []) {
      await expect(page.locator(`#${item.exercise.id}-${option.id}`)).toHaveAttribute(
        'aria-checked',
        String(selectedIds.has(option.id)),
      );
    }
    return;
  }
  if (item.exercise.type === 'debug') {
    const value = answer as { line: number; fixId: string };
    const fix = item.exercise.fix_options?.find((option) => option.id === value.fixId);
    await expect(page.getByLabel('Buggy line')).toHaveText(`Line ${value.line}`);
    if (fix) await expect(page.getByLabel('Fix')).toContainText(fix.text);
    return;
  }
  const value =
    typeof answer === 'object' && answer !== null && 'text' in answer
      ? (answer as { text: unknown }).text
      : answer;
  await expect(page.getByLabel('Your answer')).toHaveValue(String(value ?? ''));
}

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
  await enrollInDefaultCourse(db, user.id);
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

async function createLessonActivitySession(
  runConceptId: string,
  pointId: string,
  pendingExerciseId: string,
  answeredProblems: Array<{ pointId: string; exerciseId: string }> = [],
) {
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
  await db.insert(sessionActivities).values({
    sessionId: session.id,
    idx: 0,
    kind: 'learn',
    conceptId: runConceptId,
    exerciseIds: [],
    plannedMinutes: 5,
    status: 'in_progress',
  });
  const [run] = await db
    .insert(lessonRuns)
    .values({
      userId: learner.id,
      conceptId: runConceptId,
      status: 'in_progress',
      startedAt: new Date('2026-01-01T12:00:00.000Z'),
    })
    .returning();
  if (!run) throw new Error('Could not create lesson run');
  await db.insert(lessonProblems).values([
    ...answeredProblems.map((problem, position) => ({
      runId: run.id,
      knowledgePointId: problem.pointId,
      round: 1,
      position,
      exerciseId: problem.exerciseId,
      answeredAt: new Date(`2026-01-01T12:00:0${position}Z`),
      correct: 1,
    })),
    {
      runId: run.id,
      knowledgePointId: pointId,
      round: 1,
      position: 0,
      exerciseId: pendingExerciseId,
    },
  ]);
  await db.$client.end();
  return session.id;
}

async function createPracticeActivitySession() {
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
  if (!session) throw new Error('Could not create practice session');
  await db.insert(sessionActivities).values({
    sessionId: session.id,
    idx: 0,
    kind: 'practice',
    conceptId: 'supervised-learning',
    exerciseIds: ['sl-explain-setup'],
    plannedMinutes: 5,
    status: 'in_progress',
  });
  await db.$client.end();
  return session.id;
}

async function currentRun(page: Page, runConceptId = conceptId) {
  return page.evaluate(async (concept) => {
    const response = await fetch(`/api/lessons/${concept}/run`);
    return (await response.json()).run;
  }, runConceptId);
}

async function lessonStepWidthMeasurements(page: Page) {
  return page.evaluate(() => {
    const recap = Array.from(document.querySelectorAll<HTMLElement>('[data-slot="card"]')).find(
      (card) => card.querySelector('[data-slot="card-title"]')?.textContent?.trim() === 'Recap',
    );
    const prose = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid="lesson-step-content"] .markdown'),
    ).find((element) => element.textContent?.includes('Two answers written as 0 and 1'));
    if (!recap || !prose) throw new Error('Could not find the lesson recap card and prose block');
    const recapBounds = recap.getBoundingClientRect();
    const proseBounds = prose.getBoundingClientRect();
    return {
      recapLeft: recapBounds.left,
      recapRight: recapBounds.right,
      proseLeft: proseBounds.left,
      proseRight: proseBounds.right,
      pageWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
    };
  });
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

async function expectEnterToAdvance(page: Page, runConceptId: string, problemId: string) {
  let nextPostCount = 0;
  const onRequest = (request: import('@playwright/test').Request) => {
    if (request.url().endsWith(`/api/lessons/${runConceptId}/run`) && request.method() === 'POST') {
      nextPostCount += 1;
    }
  };
  const nextAction = page
    .getByTestId('lesson-problem')
    .getByRole('button', { name: /^Next(?: problem| step|: .+)$/ });
  await expect(nextAction).toBeEnabled();
  page.on('request', onRequest);
  const nextResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/lessons/${runConceptId}/run`) &&
      response.request().method() === 'POST',
    { timeout: 5000 },
  );
  await page.keyboard.press('Enter');
  expect((await nextResponse).status()).toBe(200);
  await expect(page.getByTestId('lesson-problem')).not.toHaveAttribute(
    'data-problem-id',
    problemId,
  );
  expect(nextPostCount).toBe(1);
  page.off('request', onRequest);
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
    await expect(page.getByTestId('lesson-problem').getByRole('status')).toContainText(
      correct ? 'Correct' : 'Not quite',
    );
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

test('lesson course context links to its course and highlights the sidebar', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await createSession(page);
  const line = page.getByTestId('lesson-course');
  await expect(line).toHaveText('Fixture course · Unit 1 · 1.4');
  await expect(line.getByRole('link')).toHaveAttribute('href', '/courses/fixture-course');
  const sidebarCourse = page.getByRole('navigation').getByRole('link', { name: /Fixture course/ });
  await expect(sidebarCourse).toHaveAttribute('data-active', 'true');
  const dir = 'test-results/screenshots/lesson-course';
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: `${dir}/session-desktop.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${dir}/session-mobile.png` });
  await page.getByRole('link', { name: 'View full lesson' }).click();
  await expect(line).toHaveText('Fixture course · Unit 1 · 1.4');
  await page.screenshot({ path: `${dir}/full-mobile.png` });
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(sidebarCourse).toHaveAttribute('data-active', 'true');
  await page.screenshot({ path: `${dir}/full-desktop.png` });
  await line.getByRole('link').click();
  await expect(page).toHaveURL(/\/courses\/fixture-course$/);
});

test('lesson prose fills the recap width on desktop and mobile', async ({ page }, testInfo) => {
  test.skip(
    resolve(process.env.PLAYWRIGHT_CONTENT_DIR ?? 'tests/fixtures/content') !== resolve('content'),
    'Requires the full curriculum content; run with PLAYWRIGHT_CONTENT_DIR=content.',
  );
  const sessionId = await createLessonActivitySession(
    'logistic-regression',
    'lr-classification',
    'lr-classification-basics',
  );
  mkdirSync(testInfo.outputDir, { recursive: true });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/session/${sessionId}`);
  await expect(page.getByTestId('lesson-step-content')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Recap' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Worked example' })).toBeVisible();
  await expect(page.getByTestId('lesson-problem-prompt')).toBeVisible();
  const desktopWidths = await lessonStepWidthMeasurements(page);
  expect(Math.abs(desktopWidths.proseLeft - desktopWidths.recapLeft)).toBeLessThanOrEqual(1);
  expect(Math.abs(desktopWidths.proseRight - desktopWidths.recapRight)).toBeLessThanOrEqual(1);
  console.log('Desktop lesson prose/card bounds:', desktopWidths);
  await page.screenshot({
    path: testInfo.outputPath('lesson-step-1440x900.png'),
  });

  await page.setViewportSize({ width: 390, height: 844 });
  const mobileWidths = await lessonStepWidthMeasurements(page);
  expect(Math.abs(mobileWidths.proseLeft - mobileWidths.recapLeft)).toBeLessThanOrEqual(1);
  expect(Math.abs(mobileWidths.proseRight - mobileWidths.recapRight)).toBeLessThanOrEqual(1);
  expect(mobileWidths.pageWidth).toBeLessThanOrEqual(mobileWidths.viewportWidth);
  console.log('Mobile lesson prose/card bounds:', mobileWidths);
  await page.screenshot({
    path: testInfo.outputPath('lesson-step-390x844.png'),
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('link', { name: 'View full lesson' }).click();
  await expect(
    page.getByRole('heading', { name: 'Logistic regression and cross-entropy' }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('full-lesson-1440x900.png'),
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole('heading', { name: 'Logistic regression and cross-entropy' }),
  ).toBeVisible();
  const mobileFullLesson = await page.evaluate(() => ({
    pageWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
  }));
  expect(mobileFullLesson.pageWidth).toBeLessThanOrEqual(mobileFullLesson.viewportWidth);
  await page.screenshot({
    path: testInfo.outputPath('full-lesson-390x844.png'),
  });

  await page.goto('/lessons/convolutions');
  await expect(page.locator('.markdown').first()).toBeVisible();
  const mobileMathLayout = await page.evaluate(() => {
    const displays = Array.from(document.querySelectorAll<HTMLElement>('.katex-display')).map(
      (element) => ({
        tex: element.querySelector('annotation[encoding="application/x-tex"]')?.textContent ?? '',
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
        overflowX: getComputedStyle(element).overflowX,
      }),
    );
    return {
      pageWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
      displays,
    };
  });
  expect(mobileMathLayout.pageWidth).toBeLessThanOrEqual(mobileMathLayout.viewportWidth);
  expect(mobileMathLayout.displays.some(({ tex }) => tex.includes('\\sum'))).toBe(true);
  expect(mobileMathLayout.displays.some(({ tex }) => tex.includes('\\begin{pmatrix}'))).toBe(true);
  expect(
    mobileMathLayout.displays
      .filter(({ scrollWidth, clientWidth }) => scrollWidth > clientWidth)
      .every(({ overflowX }) => overflowX === 'auto' || overflowX === 'scroll'),
  ).toBe(true);
  console.log('Mobile matrix/sum equation layout:', mobileMathLayout);
});

test('lesson runner shows pulsing Thinking while preparing a question', async ({
  page,
}, testInfo) => {
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
    const thinking = page.getByRole('status', { name: 'Thinking', exact: true });
    await expect(thinking).toBeVisible();
    const animatedTortoise = thinking.locator('span').first();
    await expect(animatedTortoise).toHaveCSS('animation-name', 'pulse');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(animatedTortoise).toHaveCSS('animation-name', 'none');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await expect(page.getByTestId('route-skeleton')).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('question-loading-desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(thinking).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('question-loading-mobile.png') });
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
  await expect(page.getByRole('button', { name: 'Submit answer', exact: true })).toHaveCount(0);

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

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole('button', { name: /Step 1 of \d+, passed/ }).click();
  await expect(page.getByTestId('lesson-step-content')).toBeVisible();
  await page.getByRole('button', { name: 'Practise this step', exact: true }).click();
  await expect
    .poll(async () => Boolean((await currentRun(page)).pendingPracticeProblem))
    .toBe(true);
  const ordinaryProblem = (await currentRun(page)).pendingPracticeProblem;
  if (!ordinaryProblem) throw new Error('Expected a practice question for the passed step');
  const ordinaryAnswer = await page.evaluate(async (id) => {
    const response = await fetch(`/api/test/lesson-problems/${id}/answer`);
    return response.json();
  }, ordinaryProblem.id);
  if (ordinaryProblem.exercise.type === 'mc') {
    const ids = Array.isArray(ordinaryAnswer.answer)
      ? ordinaryAnswer.answer
      : [ordinaryAnswer.answer];
    for (const optionId of ids) {
      await page.locator(`[id="${ordinaryProblem.exercise.id}-${optionId}"]`).click();
    }
  } else {
    const value =
      ordinaryAnswer.answer &&
      typeof ordinaryAnswer.answer === 'object' &&
      'text' in ordinaryAnswer.answer
        ? ordinaryAnswer.answer.text
        : ordinaryAnswer.answer;
    await page.getByLabel('Your answer').fill(String(value));
  }
  await page.getByRole('button', { name: 'Submit answer', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Another question', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Another question', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Submit answer', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Ask the tutor', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Back', exact: true })).toBeVisible();
  await expect(page.getByText(toastTitle, { exact: true })).toBeHidden();
  await page.screenshot({
    path: `${quizRetryScreenshotDir}/ordinary-practice-answer-desktop.png`,
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: `${quizRetryScreenshotDir}/ordinary-practice-answer-390.png`,
    fullPage: true,
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole('button', { name: 'Back', exact: true }).click();
});

test('leaving after a step resumes on the next knowledge point', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const { sessionId, nextTitle } = await passFirstKnowledgePoint(page);
  await advanceToNextStep(page);
  await page
    .locator('[role="navigation"][aria-label="Main navigation"]')
    .getByRole('link', { name: 'Home', exact: true })
    .click();
  await expect(page).toHaveURL('/');
  const resume = page.getByRole('link', { name: 'Resume session', exact: true });
  await expect(resume).toBeVisible();
  await resume.click();
  await expect(page).toHaveURL(new RegExp(`/session/${sessionId}(?:\\?.*)?$`));
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
    'Which statement best describes the main idea of this concept?',
  );
  await page.getByTestId('lesson-problem').screenshot({
    path: `${mcShuffleScreenshotDir}/mc.png`,
  });
  const firstDisplayedOption = page.getByRole('radio').first();
  await firstDisplayedOption.focus();
  await page.keyboard.press('1');
  await expect(firstDisplayedOption).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByLabel('0 of 2 correct in a row')).toBeVisible();
  await expect(page.getByText('2 correct in a row', { exact: true })).toBeVisible();
  run = await answerAndReload(page, true);
  expect(run.points[0]).toMatchObject({ status: 'active', answered: 1, streak: 1 });
  await expect(page.getByLabel('1 of 2 correct in a row')).toBeVisible();
  await expect(
    page.getByText('1 more correct to finish', { exact: true }).filter({ visible: true }),
  ).toBeVisible();

  for (let pointIndex = 0; pointIndex < run.points.length; pointIndex += 1) {
    while (run.points[pointIndex].status !== 'passed') {
      if (!run.pendingProblem) run = await nextProblemAndReload(page, conceptId, true);
      run = await answerAndReload(page, true);
      if (pointIndex === 0 && run.points[0].streak === 1) {
        await expect(page.getByLabel('1 of 2 correct in a row')).toBeVisible();
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
  await expect(submitButton.getByText('Submit answer', { exact: true })).toHaveCSS('opacity', '0');
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

  const status = page.getByTestId('lesson-problem').getByRole('status');
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
  await expect(answerField).toHaveAttribute('readonly', '');
  await expectEnterToAdvance(page, 'loss-functions', problemId);
  await expect(page.getByTestId('lesson-problem')).not.toHaveAttribute(
    'data-problem-id',
    problemId,
  );
  await expect(page.getByText('Not quite', { exact: true })).toHaveCount(0);
  expect(answerPostCount).toBe(1);
});

test('Next focuses the next typed lesson answer', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const sessionId = await createLessonActivitySession(
    'loss-functions',
    'loss-functions-fixture-1',
    'loss-functions-fixture-1-basics',
  );
  await page.goto(`/session/${sessionId}`);
  await expect
    .poll(async () => (await currentRun(page, 'loss-functions'))?.pendingProblem?.id)
    .toBeTruthy();
  let run = await currentRun(page, 'loss-functions');
  expect(run.pendingProblem.exercise.type).toBe('mc');
  await answerAndReload(page, false, 'loss-functions');
  run = await nextProblemAndReload(page, 'loss-functions');
  expect(run.pendingProblem.exercise.id).toBe('loss-functions-fixture-practice-1');
  expect(run.pendingProblem.exercise.type).toBe('numeric');
  const answer = await page.evaluate(async (problemId: string) => {
    const response = await fetch(`/api/test/lesson-problems/${problemId}/answer`);
    return (await response.json()).answer;
  }, run.pendingProblem.id);

  const answerField = page.getByLabel('Your answer');
  await expect(answerField).toBeFocused();
  await answerField.fill(String(answer));
  const answerResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/lessons/loss-functions/run/answer') &&
      response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Submit answer' }).click();
  expect((await answerResponse).status()).toBe(200);
  await expect(page.getByText(/^Correct(?: · \+\d+ XP)?$/)).toBeVisible();

  const nextButton = page.getByTestId('lesson-problem').getByRole('button', { name: /^Next/ });
  const nextResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/lessons/loss-functions/run') &&
      response.request().method() === 'POST',
  );
  await nextButton.click();
  expect((await nextResponse).status()).toBe(200);
  await expect
    .poll(async () => (await currentRun(page, 'loss-functions'))?.pendingProblem?.id)
    .not.toBe(run.pendingProblem.id);
  const nextRun = await currentRun(page, 'loss-functions');
  expect(nextRun.pendingProblem.exercise.type).toBe('numeric');

  const nextAnswerField = page.getByLabel('Your answer');
  await expect(nextAnswerField).toBeFocused();
  await page.screenshot({ path: `${answerAutofocusScreenshotDir}/after-next.png` });
  await nextAnswerField.fill('typed into the focused answer');
  await expect(nextAnswerField).toHaveValue('typed into the focused answer');
});

test('Next preserves focus in the tutor composer', async ({ page }) => {
  const sessionId = await createLessonActivitySession(
    'loss-functions',
    'loss-functions-fixture-1',
    'loss-functions-fixture-practice-1',
  );
  await page.goto(`/session/${sessionId}`);
  await expect
    .poll(async () => (await currentRun(page, 'loss-functions'))?.pendingProblem?.id)
    .toBeTruthy();
  const run = await currentRun(page, 'loss-functions');
  expect(run.pendingProblem.exercise.type).toBe('numeric');

  const problemCard = page.getByTestId('lesson-problem');
  await problemCard.getByRole('button', { name: 'Ask the tutor' }).click();
  const tutorComposer = page
    .getByRole('complementary', { name: 'Tutor' })
    .getByLabel('Ask the tutor');
  await expect(tutorComposer).toBeFocused();

  const answer = await page.evaluate(async (problemId: string) => {
    const response = await fetch(`/api/test/lesson-problems/${problemId}/answer`);
    return (await response.json()).answer;
  }, run.pendingProblem.id);
  await page.getByLabel('Your answer').fill(String(answer));
  const answerResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/lessons/loss-functions/run/answer') &&
      response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Submit answer' }).click();
  expect((await answerResponse).status()).toBe(200);
  await expect(page.getByText(/^Correct(?: · \+\d+ XP)?$/)).toBeVisible();

  await tutorComposer.focus();
  await expect(tutorComposer).toBeFocused();
  const nextButton = page.getByTestId('lesson-problem').getByRole('button', { name: /^Next/ });
  const nextResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/lessons/loss-functions/run') &&
      response.request().method() === 'POST',
  );
  await nextButton.evaluate((button) => (button as HTMLButtonElement).click());
  expect((await nextResponse).status()).toBe(200);
  await expect
    .poll(async () => (await currentRun(page, 'loss-functions'))?.pendingProblem?.id)
    .not.toBe(run.pendingProblem.id);
  await expect(tutorComposer).toBeFocused();
});

test('LessonRunner advances from a locked expression textarea with Enter', async ({ page }) => {
  const sessionId = await createLessonActivitySession(
    'derivatives',
    'derivatives-fixture-1',
    'dx-derivatives',
  );
  await page.goto(`/session/${sessionId}`);
  await expect
    .poll(async () => (await currentRun(page, 'derivatives'))?.pendingProblem?.id)
    .toBeTruthy();
  const run = await currentRun(page, 'derivatives');
  expect(run.currentPointId).toBe('derivatives-fixture-1');
  expect(run.pendingProblem.exercise).toMatchObject({
    id: 'dx-derivatives',
    type: 'expression',
  });
  await expect(page.getByTestId('lesson-problem')).toHaveAttribute(
    'data-problem-id',
    run.pendingProblem.id,
  );
  const answer = await page.evaluate(async (problemId: string) => {
    const response = await fetch(`/api/test/lesson-problems/${problemId}/answer`);
    return (await response.json()).answer;
  }, run.pendingProblem.id);
  const problemId = run.pendingProblem.id as string;
  let answerPostCount = 0;
  page.on('request', (request) => {
    if (
      request.url().endsWith('/api/lessons/derivatives/run/answer') &&
      request.method() === 'POST'
    ) {
      answerPostCount += 1;
    }
  });
  const answerField = page.getByLabel('Your answer');
  await answerField.fill(String(answer));
  const answerResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/lessons/derivatives/run/answer') &&
      response.request().method() === 'POST',
  );
  await answerField.press('Enter');
  expect((await answerResponse).status()).toBe(200);
  await expect(page.getByText(/^Correct(?: · \+\d+ XP)?$/)).toHaveCount(1);
  await expect(answerField).toBeFocused();
  await expect(answerField).toHaveAttribute('readonly', '');
  await expectEnterToAdvance(page, 'derivatives', problemId);
  expect(answerPostCount).toBe(1);
});

test('LessonRunner advances after MC feedback when the selected label focuses its radio group', async ({
  page,
}) => {
  const sessionId = await createLessonActivitySession(
    'derivatives',
    'derivatives-fixture-1',
    'derivatives-fixture-1-basics',
  );
  await page.goto(`/session/${sessionId}`);
  await expect
    .poll(async () => (await currentRun(page, 'derivatives'))?.pendingProblem?.id)
    .toBeTruthy();
  const run = await currentRun(page, 'derivatives');
  const problem = run.pendingProblem;
  expect(problem.exercise.type).toBe('mc');
  await expect(page.getByRole('radiogroup').locator('label')).toHaveText([
    /^A\./,
    /^B\./,
    /^C\./,
    /^D\./,
  ]);
  await expect(page.getByTestId('lesson-problem')).toHaveAttribute('data-problem-id', problem.id);
  const answer = await page.evaluate(async (problemId: string) => {
    const response = await fetch(`/api/test/lesson-problems/${problemId}/answer`);
    return (await response.json()).answer;
  }, problem.id);
  const answerId = Array.isArray(answer) ? answer[0] : answer;
  const radio = page.locator(`[id="${problem.exercise.id}-${answerId}"]`);
  await radio.click();
  const answerResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/lessons/derivatives/run/answer') &&
      response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Submit answer' }).click();
  expect((await answerResponse).status()).toBe(200);
  await expect(page.getByText(/^Correct(?: · \+\d+ XP)?$/)).toHaveCount(1);
  const selectedLabel = page.locator('[data-option-state="correct"]');
  await selectedLabel.click({ force: true });
  const radioGroup = page.getByRole('radiogroup');
  await expect(radioGroup).toBeFocused();
  await expectEnterToAdvance(page, 'derivatives', problem.id);
});

test('typing a question mark in the tutor composer does not show shortcut help', async ({
  page,
}) => {
  const sessionId = await createPracticeActivitySession();
  await page.goto(`/session/${sessionId}`);
  const exercise = page.getByTestId('session-exercise');
  await expect(exercise).toBeVisible();
  await page.getByRole('button', { name: 'Ask the tutor' }).click();
  const tutor = page.getByRole('complementary', { name: 'Tutor' });
  const textarea = tutor.getByLabel('Ask the tutor');
  await textarea.pressSequentially('?');
  await expect(textarea).toHaveValue('?');
  await expect(exercise.getByText(/Enter submits/)).toHaveCount(0);
});

test('asking the tutor does not block a correct answer from completing the step', async ({
  page,
}) => {
  await createSession(page);
  let run = await answerAndReload(page, true);
  expect(run.points[0]).toMatchObject({ status: 'active', streak: 1 });

  run = await nextProblemAndReload(page);
  await page.getByRole('button', { name: 'Ask the tutor' }).click();
  const tutor = page.getByRole('complementary', { name: 'Tutor' });
  const question = 'Can you explain the reasoning for this question?';
  await tutor.getByLabel('Ask the tutor').fill(question);
  await tutor.getByLabel('Ask the tutor').press('Enter');
  await expect(tutor.getByTestId('tutor-user-message').filter({ hasText: question })).toBeVisible();
  await expect(
    tutor.getByTestId('tutor-assistant-message').filter({ hasText: `Tutor reply to: ${question}` }),
  ).toBeVisible();

  run = await answerAndReload(page, true);
  expect(run.points[0]).toMatchObject({ status: 'passed', streak: 2 });
  expect(run.lastAnsweredProblem.result.assisted).toBe(true);
  await expect(page.getByTestId('lesson-problem').getByRole('status')).toContainText('Correct');
  await expect(page.getByText(/doesn't count|without help|with help/)).toHaveCount(0);
  await expect(page.getByText('Step complete', { exact: true })).toBeVisible();
  await expect(
    tutor.getByTestId('tutor-assistant-message').filter({ hasText: `Tutor reply to: ${question}` }),
  ).toBeVisible();
  await page.getByText('Step complete', { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/academy-streak-assisted.png', fullPage: false });
  run = await nextProblemAndReload(page);
  run = await answerAndReload(page, true);
  expect(run.points[0]).toMatchObject({ status: 'passed', streak: 2 });
  expect(run.lastAnsweredProblem.result.assisted).toBe(false);
  expect(run.points[1]).toMatchObject({ status: 'active', streak: 1 });
});

test('reloading restores progress earned before tutor-assisted answers counted', async ({
  page,
}) => {
  await createSession(page);
  const initial = await currentRun(page);
  const first = initial.pending;
  const db = createDb(env.TEST_DATABASE_URL);
  try {
    await db
      .update(lessonProblems)
      .set({ correct: 1, answeredAt: new Date('2026-01-01T12:00:01Z') })
      .where(eq(lessonProblems.id, first.id));
    await db.insert(lessonProblems).values(
      [2, 3, 4].map((position) => ({
        runId: initial.id,
        knowledgePointId: first.knowledgePointId,
        round: first.round,
        position,
        exerciseId: first.exerciseId,
        seed: first.seed,
        assisted: true,
        correct: position < 4 ? 1 : null,
        servedAt: new Date(`2026-01-01T12:00:0${position}Z`),
        answeredAt: position < 4 ? new Date(`2026-01-01T12:00:0${position}Z`) : null,
      })),
    );
  } finally {
    await db.$client.end();
  }
  const synchronized = page.waitForResponse(
    (response) => response.url().endsWith('/run') && response.request().method() === 'POST',
  );
  await page.reload();
  expect((await synchronized).status()).toBe(200);
  const recovered = await currentRun(page);
  expect(recovered.needsProgressSync).toBeUndefined();
  expect(recovered.points[0]).toMatchObject({ status: 'passed', streak: 2 });
  expect(recovered.pending.knowledgePointId).not.toBe(first.knowledgePointId);
  expect(recovered.xpEarned).toBe(10);
  await expect(page.getByTestId('lesson-problem')).toHaveAttribute(
    'data-problem-id',
    recovered.pending.id,
  );
  await page.reload();
  expect((await currentRun(page)).xpEarned).toBe(10);
});

test('explains when a final explain question is locked after the last try', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
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
  if (!session) throw new Error('Could not create final-question session');
  const [activity] = await db
    .insert(sessionActivities)
    .values({
      sessionId: session.id,
      idx: 0,
      kind: 'learn',
      conceptId: 'supervised-learning',
      exerciseIds: ['sl-explain-setup'],
      plannedMinutes: 10,
      status: 'in_progress',
      progress: { lessonRunnerContinued: true },
    })
    .returning();
  await db.$client.end();
  if (!activity) throw new Error('Could not create final-question activity');

  await page.goto(`/session/${session.id}`);
  await expect(page.getByText('Explain it in your own words', { exact: true })).toBeVisible();
  await expect(page.getByTestId('exercise-prompt')).toBeVisible();

  const answer = page.getByLabel('Your answer');
  await answer.fill('A model uses inputs to predict a target.');
  await page.getByRole('button', { name: 'Submit answer' }).click();
  await expect(page.getByText('Almost', { exact: true })).toBeVisible();
  await expect(
    page.getByText(
      'That was your last try at this question. Read the model answer, then press Continue.',
      { exact: true },
    ),
  ).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Submit again' })).toBeVisible();

  await answer.fill('A model uses inputs to predict a target, and loss measures its errors.');
  await page.getByRole('button', { name: 'Submit again' }).click();
  await expect(page.getByText('Partly correct', { exact: true })).toBeVisible();
  await expect(
    page.getByText(
      'That was your last try at this question. Read the model answer, then press Continue.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByText(
      'That was your last try at this question. Read the model answer, then press Continue.',
      { exact: true },
    ),
  ).toHaveCount(1);
  await expect(answer).toHaveAttribute('readonly', '');
  await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Submit answer', exact: true })).toHaveCount(0);
  await page.screenshot({
    path: `${lastTryScreenshotDir}/final-explain-locked.png`,
    fullPage: true,
  });
});

test('session inline checks remove Submit after the final retry', async ({ page }) => {
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
  if (!session) throw new Error('Could not create inline-check session');
  await db.insert(sessionActivities).values({
    sessionId: session.id,
    idx: 0,
    kind: 'learn',
    conceptId,
    exerciseIds: ['sl-explain-setup'],
    plannedMinutes: 10,
    status: 'in_progress',
    progress: {},
  });
  await db.$client.end();

  await page.route(`**/api/lessons/${conceptId}`, async (route) => {
    const response = await route.fetch();
    const lesson = await response.json();
    delete lesson.knowledge_points;
    lesson.blocks = [{ kind: 'worked', md: 'Inline check fixture.', exercise: 'sl-explain-setup' }];
    await route.fulfill({ response, json: lesson });
  });
  await page.goto(`/session/${session.id}`);

  const answer = page.getByLabel('Your answer');
  await answer.fill('A model uses inputs to predict a target.');
  await page.getByRole('button', { name: 'Submit answer', exact: true }).click();
  await expect(page.getByText('Almost', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Submit answer', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue to practice' })).toBeDisabled();

  await answer.fill('A model uses inputs to predict a target, and loss measures its errors.');
  await page.getByRole('button', { name: 'Submit answer', exact: true }).click();
  await expect(page.getByText('Partly correct', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Submit answer', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Continue to practice' })).toBeEnabled();
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
  await expect(page.locator('section > header h2')).toHaveText('Explain it in your own words');
  await expect(page.getByTestId('explain-memory-note')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'View full lesson' })).toHaveCount(0);
  const stepChips = page.getByTestId('lesson-step-chip');
  await expect(stepChips).not.toHaveCount(0);
  for (const stepChip of await stepChips.all()) {
    await expect(stepChip).toHaveText(/^✓ Step \d+$/);
    await expect(stepChip.locator('button')).toHaveCount(1);
  }
  const explainChip = page.getByTestId('lesson-explain-chip');
  await expect(explainChip).toHaveAttribute('aria-label', 'Explain it, current');
  await expect(explainChip).toHaveText('Explain it');
  const quizChip = page.getByTestId('lesson-quiz-chip');
  await expect(quizChip).toHaveAttribute('aria-label', 'Lesson quiz, upcoming');
  await page.screenshot({
    path: `${explainItScreenshotDir}/final-before-1280.png`,
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: `${explainItScreenshotDir}/final-before-390.png`,
    fullPage: true,
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.setViewportSize({ width: 1280, height: 900 });
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
  await expect(page.getByRole('link', { name: 'View full lesson' })).toBeVisible();
  await expect(page.getByText('Partly correct', { exact: true })).toBeVisible();
  await expect(page.getByText('Your answer:', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Your answer')).toHaveAttribute('readonly', '');
  await page.screenshot({
    path: `${explainItScreenshotDir}/final-after-1280.png`,
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: `${explainItScreenshotDir}/final-after-390.png`,
    fullPage: true,
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({
    path: `${finalContinueScreenshotDir}/after-submit.png`,
    fullPage: true,
  });
  await continueButton.click();
  await expect(page.getByTestId('lesson-quiz-intro')).toBeVisible();
  await expect(explainChip).toHaveText('✓ Explain it');
  await expect(quizChip).toHaveAttribute('aria-label', 'Lesson quiz, current');
  await expect(page.getByText('Your answer:', { exact: true })).toHaveCount(0);
  const lessonStepsRow = page.getByRole('list', { name: 'Lesson steps' });
  await lessonStepsRow.screenshot({
    path: `${explainItScreenshotDir}/quiz-chips-1280.png`,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await lessonStepsRow.screenshot({
    path: `${explainItScreenshotDir}/quiz-chips-390.png`,
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.setViewportSize({ width: 1280, height: 900 });
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
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.route('**/api/**', (route) =>
    route.continue({
      headers: { ...route.request().headers(), 'x-now': '2026-01-01T12:00:00.000Z' },
    }),
  );
  const sessionId = await createSession(page);
  const quizChip = page.getByTestId('lesson-quiz-chip');
  const tutorPanel = page.getByRole('complementary', { name: 'Tutor' });
  const askTutorButton = page.getByRole('button', { name: 'Ask the tutor' });
  await expect(askTutorButton).toBeVisible();
  await askTutorButton.click();
  await expect(tutorPanel).toBeVisible();
  await expect(quizChip).toHaveAttribute('aria-label', 'Lesson quiz, upcoming');
  await page.screenshot({ path: `${quizUiScreenshotDir}/step-row-desktop.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${quizUiScreenshotDir}/step-row-mobile.png` });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.setViewportSize({ width: 1280, height: 900 });
  await tutorPanel.getByRole('button', { name: 'Close tutor' }).click();
  await expect(tutorPanel).toBeHidden();
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
  let currentActivityId = prepared.activityId;
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
  await page.goto(`/lessons/${conceptId}`);
  const lessonQuizEntry = page.getByTestId('lesson-quiz-entry');
  await expect(lessonQuizEntry).toContainText('Lesson steps done; quiz not taken yet.');
  await lessonQuizEntry.getByRole('button', { name: 'Take the quiz' }).click();
  await expect(page.getByTestId('lesson-quiz-intro')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/session/${sessionId}(?:\\?.*)?$`));
  await page.screenshot({ path: `${lessonQuizScreenshotDir}/quiz-intro.png`, fullPage: true });
  await page.getByRole('button', { name: 'Start quiz' }).click();
  await expect(page.getByTestId('lesson-quiz-question')).toBeVisible();
  await page.screenshot({ path: `${lessonQuizScreenshotDir}/quiz-question.png`, fullPage: true });
  await expect(tutorPanel).toBeHidden();
  await expect(page.getByRole('button', { name: 'Open tutor' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Ask the tutor' })).toHaveCount(0);
  await expect(page.getByText('Tutor is unavailable.', { exact: true })).toHaveCount(0);
  await page.keyboard.press('Control+b');
  await expect(tutorPanel).toBeHidden();

  const answerAttempt = async (
    wrong: boolean,
    oneWrong = false,
    wrongPointIds?: string[],
    itemPointIds: Record<string, string> = {},
  ) =>
    page.evaluate(
      async ({ conceptId, activityId, wrong, oneWrong, wrongPointIds, itemPointIds }) => {
        let run = (await (await fetch(`/api/lessons/${conceptId}/run`)).json()).run;
        let wrongUsed = false;
        for (const item of run.quiz.current.items) {
          if (item.answered) continue;
          const expected = await (
            await fetch(`/api/test/lesson-quiz-items/${item.id}/answer`)
          ).json();
          let answer = expected.answer;
          const makeWrong =
            (wrong && (wrongPointIds === null || wrongPointIds.includes(itemPointIds[item.id]))) ||
            (oneWrong && !wrongUsed);
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
      {
        conceptId,
        activityId: currentActivityId,
        wrong,
        oneWrong,
        wrongPointIds: wrongPointIds ?? null,
        itemPointIds,
      },
    );

  const quizRun = await currentRun(page);
  const questionCount = quizRun.quiz.current.items.length;
  expect(questionCount).toBeGreaterThan(1);
  const quizItemsDb = createDb(env.TEST_DATABASE_URL);
  const quizItemPoints = await quizItemsDb
    .select({ id: lessonQuizItems.id, pointId: lessonQuizItems.knowledgePointId })
    .from(lessonQuizItems)
    .where(eq(lessonQuizItems.quizAttemptId, quizRun.quiz.current.attemptId));
  await quizItemsDb.$client.end();
  const missedPointIds = [...new Set(quizItemPoints.map((item) => item.pointId))].slice(0, 2);
  if (missedPointIds.length !== 2) throw new Error('Expected quiz questions on two steps');
  const itemPointIds = Object.fromEntries(quizItemPoints.map((item) => [item.id, item.pointId]));
  const firstItem = await page.evaluate(async (concept) => {
    const run = await (await fetch(`/api/lessons/${concept}/run`)).json();
    return run.run.quiz.current.items[0];
  }, conceptId);
  if (!firstItem.exercise) throw new Error('Could not load the first quiz question');
  const firstAnswer = await page.evaluate(async (itemId) => {
    const response = await fetch(`/api/test/lesson-quiz-items/${itemId}/answer`);
    return (await response.json()).answer;
  }, firstItem.id);
  const firstWrongAnswer = wrongQuizAnswer(firstItem, firstAnswer);
  await fillQuizAnswer(page, firstItem, firstWrongAnswer);
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByRole('heading', { name: `Question 2 of ${questionCount}` })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Back', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.getByRole('heading', { name: `Question 1 of ${questionCount}` })).toBeVisible();
  await expectQuizAnswerPrefilled(page, firstItem, firstWrongAnswer);
  await fillQuizAnswer(page, firstItem, firstAnswer);
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByRole('heading', { name: `Question 2 of ${questionCount}` })).toBeVisible();
  await page.screenshot({
    path: `${quizReviseScreenshotDir}/question-with-back-1280.png`,
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: `${quizReviseScreenshotDir}/question-with-back-390.png`,
    fullPage: true,
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.reload();
  await expect(page.getByTestId('lesson-quiz-question')).toBeVisible();
  await expect(page.getByRole('heading', { name: `Question 2 of ${questionCount}` })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Back', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.getByRole('heading', { name: `Question 1 of ${questionCount}` })).toBeVisible();
  await expectQuizAnswerPrefilled(page, firstItem, firstAnswer);
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByRole('heading', { name: `Question 2 of ${questionCount}` })).toBeVisible();
  await answerAttempt(true, false, missedPointIds, itemPointIds);
  await page.reload();
  const failed = page.getByTestId('lesson-quiz-results');
  const finalQuizState = await currentRun(page);
  const finalQuizItemsDb = createDb(env.TEST_DATABASE_URL);
  const finalQuizItems = await finalQuizItemsDb
    .select({ id: lessonQuizItems.id, correct: lessonQuizItems.correct })
    .from(lessonQuizItems)
    .where(eq(lessonQuizItems.quizAttemptId, finalQuizState.quiz.last.attemptId));
  await finalQuizItemsDb.$client.end();
  expect(finalQuizItems.find((item) => item.id === firstItem.id)?.correct).toBe(1);
  expect(finalQuizState.quiz.last.correctCount).toBe(
    finalQuizItems.filter((item) => item.correct === 1).length,
  );
  await expect(failed).toContainText(/Not passed · \d+ of \d+ \(you need \d+\)/);
  await expect(failed.getByText(/Your answer:|Correct answer:|Question \d+/)).toHaveCount(0);
  await expect(failed).toContainText('You missed questions on:');
  const requiredReviews = (await currentRun(page)).quiz.reviewRequired as Array<{
    pointId: string;
    title: string;
    answered: number;
    needed: number;
  }>;
  expect(requiredReviews).toHaveLength(2);
  expect(requiredReviews.every((step) => step.answered === 0 && step.needed === 3)).toBe(true);
  await expect(failed.getByTestId('quiz-missed-steps').getByRole('listitem')).toHaveText(
    requiredReviews.map((step) => step.title),
  );
  await expect(failed.locator('button[data-variant="default"]')).toHaveCount(1);
  await expect(failed.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
  await expect(failed.getByRole('button', { name: /Practise/ })).toHaveCount(0);
  await expect(failed.getByRole('button', { name: 'Retake quiz' })).toHaveCount(0);
  const doThisLater = failed.getByRole('button', { name: 'Do this later' });
  await expect(doThisLater).toHaveAttribute('data-variant', 'ghost');
  const prepareQuizRetryScreenshot = async (actionName?: string) => {
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.mouse.move(0, 0);
    if (actionName) {
      const action = page.getByRole('button', { name: actionName, exact: true });
      await expect(action).toBeEnabled();
      await expect(action).not.toHaveAttribute('data-loading', 'true');
      await expect(action).toHaveAttribute('data-variant', 'default');
      await expect(action).toHaveCSS('background-color', 'rgb(60, 73, 57)');
    }
  };
  await prepareQuizRetryScreenshot('Retry');
  await page.screenshot({
    path: `${quizRetryScreenshotDir}/failed-card-desktop.png`,
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await prepareQuizRetryScreenshot('Retry');
  await page.screenshot({ path: `${quizRetryScreenshotDir}/failed-card-390.png`, fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({
    path: `${spacedReviewScreenshotDir}/failed-quiz-pending-desktop.png`,
    fullPage: true,
  });
  const db = createDb(env.TEST_DATABASE_URL);
  await db
    .update(sessionActivities)
    .set({ status: 'planned' })
    .where(eq(sessionActivities.id, prepared.activityId));
  await db.$client.end();
  await page.goto(`/lessons/${conceptId}`);
  const failedLessonEntry = page.getByTestId('lesson-quiz-entry');
  await expect(failedLessonEntry).toContainText(
    /Quiz not passed yet · \d+ of \d+\. Practise the steps you missed, then retake it\./,
  );
  await page.screenshot({
    path: `${failedQuizScreenshotDir}/lesson-page-card.png`,
    fullPage: true,
  });
  await failedLessonEntry.getByRole('button', { name: 'Go to the quiz' }).click();
  await expect(page).toHaveURL(new RegExp(`/session/${sessionId}(?:\\?.*)?$`));
  await expect(page).toHaveURL(/\/session\/[^/?]+(?:\?.*)?$/);
  const failedSessionId = new URL(page.url()).pathname.split('/').at(-1);
  if (!failedSessionId) throw new Error('Expected an active quiz session');
  await expect(page.getByTestId('lesson-quiz-results')).toBeVisible();
  await page
    .getByTestId('lesson-quiz-results')
    .getByRole('button', { name: 'Do this later' })
    .click();
  await expect
    .poll(async () =>
      page.evaluate(
        async ({ sessionId, activityId }) => {
          const session = await (await fetch(`/api/sessions/${sessionId}`)).json();
          const activity = session.activities.find(
            (item: { id: string; progress?: { quizContinued?: boolean } }) =>
              item.id === activityId,
          );
          return activity?.progress?.quizContinued;
        },
        { sessionId: failedSessionId, activityId: prepared.activityId },
      ),
    )
    .toBe(true);
  const completeResponse = await page.evaluate(
    async ({ sessionId, activityId }) => {
      const response = await fetch(`/api/sessions/${sessionId}/activities/${activityId}/progress`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ complete: true, lessonRunnerContinued: true, quizContinued: true }),
      });
      return response.status;
    },
    { sessionId: failedSessionId, activityId: prepared.activityId },
  );
  expect(completeResponse).toBe(200);
  await page.reload();
  await expect(page.getByRole('status')).toHaveText('Supervised learning complete.');
  const endResponse = await page.evaluate(async (id) => {
    const response = await fetch(`/api/sessions/${id}/end`, { method: 'POST' });
    return response.status;
  }, failedSessionId);
  expect(endResponse).toBe(200);
  await page.goto(`/lessons/${conceptId}`);
  await page
    .getByTestId('lesson-quiz-entry')
    .getByRole('button', { name: 'Go to the quiz' })
    .click();
  await expect(page.getByTestId('lesson-quiz-results')).toBeVisible();
  const newSessionId = new URL(page.url()).pathname.split('/').at(-1);
  if (!newSessionId) throw new Error('Expected the quiz entry to create a focused session');
  currentActivityId = await page.evaluate(
    async ({ sessionId, conceptId }) => {
      const session = await (await fetch(`/api/sessions/${sessionId}`)).json();
      const activity = session.activities.find(
        (item: { kind: string; conceptId: string }) =>
          item.kind === 'learn' && item.conceptId === conceptId,
      );
      if (!activity) throw new Error('Focused session did not contain the quiz lesson');
      return activity.id;
    },
    { sessionId: newSessionId, conceptId },
  );
  await expect(page.getByTestId('lesson-quiz-results')).toContainText('You missed questions on:');
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

  const captureQuizRetryState = async (name: string) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const actionName =
      name === 'warmup-next'
        ? 'Next'
        : name === 'warmup-last-answer'
          ? 'Start the retake'
          : undefined;
    await prepareQuizRetryScreenshot(actionName);
    await page.screenshot({
      path: `${quizRetryScreenshotDir}/${name}-desktop.png`,
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );
    await prepareQuizRetryScreenshot(actionName);
    await page.screenshot({
      path: `${quizRetryScreenshotDir}/${name}-390.png`,
      fullPage: true,
    });
    await page.setViewportSize({ width: 1280, height: 900 });
  };
  const waitForPracticeRun = async () => {
    await expect
      .poll(async () => Boolean((await currentRun(page)).pendingPracticeProblem))
      .toBe(true);
    return currentRun(page);
  };
  const answerPracticeQuestion = async (
    problem: Awaited<ReturnType<typeof currentRun>>['pendingPracticeProblem'],
    wrong: boolean,
    nextAction: string,
    expectedAnswered?: number,
  ) => {
    if (!problem) throw new Error('Expected a pending practice question');
    const expected = await page.evaluate(async (id) => {
      const response = await fetch(`/api/test/lesson-problems/${id}/answer`);
      return response.json();
    }, problem.id);
    if (problem.exercise.type === 'mc') {
      const correctIds = Array.isArray(expected.answer) ? expected.answer : [expected.answer];
      const selectedIds = wrong
        ? [
            problem.exercise.options.find(
              (option: { id: string }) => !correctIds.includes(option.id),
            )?.id,
          ]
        : correctIds;
      for (const id of selectedIds) {
        await page.locator(`[id="${problem.exercise.id}-${id}"]`).click();
      }
    } else {
      const expectedAnswer =
        expected.answer && typeof expected.answer === 'object' && 'text' in expected.answer
          ? expected.answer.text
          : expected.answer;
      const answer =
        wrong && typeof expectedAnswer === 'number'
          ? String(expectedAnswer + 1_000_000)
          : wrong
            ? `${String(expectedAnswer)} incorrect`
            : String(expectedAnswer);
      await page.getByLabel('Your answer').fill(answer);
    }
    await page.getByRole('button', { name: 'Submit answer', exact: true }).click();
    if (expectedAnswered !== undefined) {
      await expect
        .poll(
          async () =>
            (await currentRun(page)).quiz.reviewRequired.find(
              (step: { pointId: string }) => step.pointId === problem.knowledgePointId,
            )?.answered,
        )
        .toBe(expectedAnswered);
    }
    await expect(page.getByRole('button', { name: nextAction, exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: nextAction, exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Submit answer', exact: true })).toHaveCount(0);
  };

  await page.getByTestId('lesson-quiz-results').getByRole('button', { name: 'Retry' }).click();
  const warmupProgress = page.getByTestId('quiz-warmup-progress');
  await expect(warmupProgress).toHaveText('Warm-up before the retake · 1 of 6');
  await expect(page.getByTestId('lesson-step-content')).toHaveCount(0);
  await expect(page.getByTestId('lesson-problem-header')).toHaveCount(0);
  await expect(page.getByText(/^Question \d+/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Retake quiz', exact: true })).toHaveCount(0);
  await captureQuizRetryState('warmup-question');
  let practiceRun = await waitForPracticeRun();
  await answerPracticeQuestion(practiceRun.pendingPracticeProblem, false, 'Next', 1);
  await expect(warmupProgress).toHaveText('Warm-up before the retake · 1 of 6');
  await captureQuizRetryState('warmup-next');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  practiceRun = await waitForPracticeRun();
  await expect(warmupProgress).toHaveText('Warm-up before the retake · 2 of 6');
  await answerPracticeQuestion(practiceRun.pendingPracticeProblem, false, 'Next', 2);

  await page.reload();
  const continuedResults = page.getByTestId('lesson-quiz-results');
  await expect(continuedResults.getByRole('button', { name: 'Continue retry' })).toBeVisible();
  await continuedResults.getByRole('button', { name: 'Continue retry' }).click();
  await expect(warmupProgress).toHaveText('Warm-up before the retake · 3 of 6');
  const resumedPractice = (await waitForPracticeRun()).pendingPracticeProblem;
  if (!resumedPractice) throw new Error('Expected the third warm-up question');
  await page.getByRole('button', { name: 'Do this later', exact: true }).click();
  await expect(page.getByTestId('lesson-quiz-results')).toBeVisible();
  await page
    .getByTestId('lesson-quiz-results')
    .getByRole('button', { name: 'Continue retry' })
    .click();
  await expect(warmupProgress).toHaveText('Warm-up before the retake · 3 of 6');
  await expect(page.getByTestId('lesson-problem')).toHaveAttribute(
    'data-problem-id',
    resumedPractice.id,
  );

  practiceRun = await waitForPracticeRun();
  await answerPracticeQuestion(practiceRun.pendingPracticeProblem, false, 'Next', 3);
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  practiceRun = await waitForPracticeRun();
  expect(practiceRun.pendingPracticeProblem?.knowledgePointId).toBe(requiredReviews[1].pointId);
  await expect(warmupProgress).toHaveText('Warm-up before the retake · 4 of 6');
  await answerPracticeQuestion(practiceRun.pendingPracticeProblem, true, 'Next', 1);
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  practiceRun = await waitForPracticeRun();
  await answerPracticeQuestion(practiceRun.pendingPracticeProblem, false, 'Next', 2);
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  practiceRun = await waitForPracticeRun();
  await expect(warmupProgress).toHaveText('Warm-up before the retake · 6 of 6');
  await answerPracticeQuestion(practiceRun.pendingPracticeProblem, false, 'Start the retake', 3);
  await expect(warmupProgress).toHaveText('Warm-up before the retake · 6 of 6');
  await captureQuizRetryState('warmup-last-answer');
  const completedReviewRun = await currentRun(page);
  expect(
    completedReviewRun.quiz.reviewRequired.every(
      (step: { answered: number }) => step.answered === 3,
    ),
  ).toBe(true);
  await page.getByRole('button', { name: 'Do this later', exact: true }).click();
  await page.getByRole('button', { name: /Step 1 of \d+, passed/ }).click();
  await expect(page.getByTestId('lesson-step-content')).toBeVisible();
  await page.getByRole('button', { name: 'Practise this step', exact: true }).click();
  await expect(page.getByTestId('lesson-quiz-warmup')).toHaveCount(0);
  practiceRun = await waitForPracticeRun();
  await answerPracticeQuestion(practiceRun.pendingPracticeProblem, false, 'Another question');
  await expect(warmupProgress).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Back', exact: true })).toBeVisible();
  await page.reload();
  const completedReviewResults = page.getByTestId('lesson-quiz-results');
  await expect(
    completedReviewResults.getByRole('button', { name: 'Continue retry' }),
  ).toBeVisible();
  const extraPendingPractice = await page.evaluate(
    async ({ conceptId, pointId, activityId, now }) => {
      const response = await fetch(`/api/lessons/${conceptId}/run/practice`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-now': now },
        body: JSON.stringify({ pointId, activityId }),
      });
      return { status: response.status, run: (await response.json()).run };
    },
    {
      conceptId,
      pointId: requiredReviews[0].pointId,
      activityId: currentActivityId,
      now: new Date(uiPracticeTime + 1_000).toISOString(),
    },
  );
  expect(extraPendingPractice.status).toBe(200);
  const extraPendingPracticeId = extraPendingPractice.run.pendingPracticeProblem?.id;
  if (!extraPendingPracticeId) throw new Error('Expected an extra pending practice question');
  let completedReviewPracticeRequests = 0;
  await page.route(`**/api/lessons/${conceptId}/run/practice`, async (route) => {
    completedReviewPracticeRequests += 1;
    await route.continue();
  });
  await page.reload();
  const reloadedCompletedReviewResults = page.getByTestId('lesson-quiz-results');
  await expect(
    reloadedCompletedReviewResults.getByRole('button', { name: 'Continue retry' }),
  ).toBeVisible();
  await reloadedCompletedReviewResults.getByRole('button', { name: 'Continue retry' }).click();
  await expect(page.getByTestId('lesson-quiz-question')).toBeVisible();
  expect(completedReviewPracticeRequests).toBe(0);
  const cleanupDb = createDb(env.TEST_DATABASE_URL);
  await cleanupDb.delete(lessonProblems).where(eq(lessonProblems.id, extraPendingPracticeId));
  await cleanupDb.$client.end();
  await page.reload();
  await expect(page.getByTestId('lesson-quiz-question')).toBeVisible();
  await captureQuizRetryState('quiz-start');
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
  await expect(retake).toBeEnabled();
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
  await expect(failedRetake).toContainText(/Not passed · \d+ of \d+ \(you need \d+\)/);
  await expect(failedRetake).toContainText('You missed questions on:');
  await expect(failedRetake.getByRole('button', { name: 'See answers' })).toHaveCount(0);
  await expect(failedRetake.getByText(/Your answer:|Correct answer:|Question \d+/)).toHaveCount(0);
  await expect(failedRetake.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
  await failedRetake.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByTestId('lesson-quiz-question')).toBeVisible();
  expect(prepared.questionCount).toBeGreaterThan(0);
});

test('legacy quiz answers can be navigated and submitted without resaving', async ({ page }) => {
  test.setTimeout(90_000);
  await page.route('**/api/**', (route) =>
    route.continue({
      headers: { ...route.request().headers(), 'x-now': '2026-01-01T12:00:00.000Z' },
    }),
  );
  const sessionId = await createSession(page);
  const preparedAttemptId = await page.evaluate(
    async ({ conceptId, sessionId }) => {
      const session = await (await fetch(`/api/sessions/${sessionId}`)).json();
      const activity = session.activities.find(
        (item: { conceptId?: string }) => item.conceptId === conceptId,
      );
      if (!activity) throw new Error('Missing lesson activity');
      let run = (await (await fetch(`/api/lessons/${conceptId}/run`)).json()).run;
      for (let count = 0; run.status === 'in_progress' && count < 200; count += 1) {
        if (!run.pendingProblem) {
          const response = await fetch(`/api/lessons/${conceptId}/run`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ activityId: activity.id }),
          });
          run = (await response.json()).run;
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
            activityId: activity.id,
          }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error ?? 'Could not prepare quiz');
        run = result.state;
      }
      if (run.status !== 'quiz') throw new Error('Lesson steps did not reach the quiz');
      const response = await fetch(`/api/lessons/${conceptId}/quiz/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ activityId: activity.id }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? 'Could not start quiz');
      return result.run.quiz.current.attemptId as string;
    },
    { conceptId, sessionId },
  );

  const legacyAnswers = await page.evaluate(
    async ({ concept, attemptId }) => {
      const run = (await (await fetch(`/api/lessons/${concept}/run`)).json()).run;
      if (run.quiz.current.attemptId !== attemptId) throw new Error('Quiz attempt changed');
      return Promise.all(
        run.quiz.current.items.map(async (item: { id: string }) => {
          const response = await fetch(`/api/test/lesson-quiz-items/${item.id}/answer`);
          return { id: item.id, answer: (await response.json()).answer };
        }),
      );
    },
    { concept: conceptId, attemptId: preparedAttemptId },
  );
  const db = createDb(env.TEST_DATABASE_URL);
  const [learner] = await db.select({ id: users.id }).from(users).limit(1);
  if (!learner) throw new Error('Missing E2E learner');
  const [legacyAttempt] = await db
    .select({ id: attempts.id })
    .from(attempts)
    .where(eq(attempts.userId, learner.id))
    .limit(1);
  if (!legacyAttempt) throw new Error('Expected an existing lesson attempt');
  for (const item of legacyAnswers) {
    await db
      .update(lessonQuizItems)
      .set({
        answer: item.answer,
        correct: 1,
        attemptId: legacyAttempt.id,
        answeredAt: new Date('2026-01-01T12:00:00.000Z'),
      })
      .where(eq(lessonQuizItems.id, item.id));
  }
  await db.$client.end();

  await page.reload();
  await expect(page.getByTestId('lesson-quiz-question')).toBeVisible();
  const run = await currentRun(page);
  const quizItems = run.quiz.current.items;
  expect(quizItems).toHaveLength(legacyAnswers.length);
  expect(quizItems.every((item: { locked: boolean }) => item.locked)).toBe(true);
  const lastItem = quizItems.at(-1);
  if (!lastItem) throw new Error('Expected legacy quiz items');
  await expect(
    page.getByRole('heading', { name: `Question ${quizItems.length} of ${quizItems.length}` }),
  ).toBeVisible();
  await expectQuizAnswerPrefilled(page, lastItem, lastItem.answer);

  let answerPosts = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/quiz/answer')) answerPosts += 1;
  });
  await expect(page.getByRole('button', { name: 'Back', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(
    page.getByRole('heading', {
      name: `Question ${quizItems.length - 1} of ${quizItems.length}`,
    }),
  ).toBeVisible();
  const previousItem = quizItems.at(-2);
  if (!previousItem) throw new Error('Expected a previous quiz item');
  await expectQuizAnswerPrefilled(page, previousItem, previousItem.answer);
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: `Question ${quizItems.length} of ${quizItems.length}` }),
  ).toBeVisible();
  const submitResponse = page.waitForResponse(
    (response) => response.request().method() === 'POST' && response.url().endsWith('/quiz/submit'),
  );
  await page.getByRole('button', { name: 'Submit quiz', exact: true }).click();
  expect((await submitResponse).status()).toBe(200);
  await expect(page.getByTestId('lesson-quiz-results')).toContainText(/^Quiz passed ·/);
  expect(answerPosts).toBe(0);
});
