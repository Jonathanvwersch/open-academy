import { mkdirSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { env } from '../../apps/api/src/config.js';
import { createDb } from '../../apps/api/src/db/client.js';
import { sessionActivities, studySessions, users } from '../../apps/api/src/db/schema.js';

const screenshotDir = 'test-results/screenshots/screenshots/stable-card';
mkdirSync(screenshotDir, { recursive: true });

test.describe.configure({ mode: 'serial' });

async function createLessonSession(page: Page) {
  await page.goto('/');
  const response = await page.evaluate(async () => {
    const result = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ budgetMinutes: 60, focusConceptId: 'supervised-learning' }),
    });
    return { status: result.status, body: await result.json() };
  });
  expect(response.status).toBe(201);
  await page.goto(`/session/${response.body.id}`);
  await expect(page.getByTestId('lesson-problem')).toBeVisible();
}

async function currentRun(page: Page) {
  return page.evaluate(async () => {
    const response = await fetch('/api/lessons/supervised-learning/run');
    return (await response.json()).run;
  });
}

async function correctAnswer(page: Page, problemId: string) {
  return page.evaluate(async (id) => {
    const response = await fetch(`/api/test/lesson-problems/${id}/answer`);
    return (await response.json()).answer;
  }, problemId);
}

async function submitLessonAnswer(page: Page, answer: unknown) {
  const run = await currentRun(page);
  const exercise = run.pendingProblem.exercise;
  const submit = page.getByRole('button', { name: 'Submit answer' });
  await submit.scrollIntoViewIfNeeded();
  const scrollYBefore = await page.evaluate(() => window.scrollY);
  const submitted = answer;
  if (exercise.type === 'mc') {
    const ids = Array.isArray(submitted) ? submitted : [submitted];
    for (const id of ids) await page.locator(`[id="${exercise.id}-${id}"]`).click();
  } else {
    await page.getByLabel('Your answer').fill(String(submitted));
  }
  const response = page.waitForResponse(
    (item) =>
      item.url().endsWith('/api/lessons/supervised-learning/run/answer') &&
      item.request().method() === 'POST',
  );
  await submit.click();
  await response;
  await expect(page.getByRole('button', { name: /Next problem|Next step/ })).toBeVisible();
  expect(await page.evaluate(() => window.scrollY)).toBe(scrollYBefore);
}

async function nextLessonProblem(page: Page) {
  const previousId = await page.getByTestId('lesson-problem').getAttribute('data-problem-id');
  if (!previousId) throw new Error('Missing current problem id');
  await page.getByRole('button', { name: 'Next problem' }).click();
  await expect(page.getByTestId('lesson-problem')).not.toHaveAttribute(
    'data-problem-id',
    previousId,
  );
}

async function box(locator: ReturnType<Page['locator']>) {
  return locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      x: rect.x + window.scrollX,
      y: rect.y + window.scrollY,
      width: rect.width,
      height: rect.height,
    };
  });
}

function expectStableBox(
  before: { x: number; y: number; width: number; height: number },
  after: { x: number; y: number; width: number; height: number },
  fields: Array<'x' | 'y' | 'width' | 'height'> = ['x', 'y', 'width'],
) {
  for (const field of fields) expect(Math.abs(before[field] - after[field])).toBeLessThanOrEqual(1);
}

test.beforeEach(async () => {
  const db = createDb(env.TEST_DATABASE_URL);
  await db.delete(users);
  await db.insert(users).values({
    displayName: 'Stable card E2E learner',
    timezone: 'UTC',
    startDate: '2026-01-01',
    prefs: { scheduleMinutes: 60 },
  });
  await db.$client.end();
});

test('lesson problem inputs, action, and feedback stay in place across answers and next question', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await createLessonSession(page);
  await page.getByTestId('lesson-problem').scrollIntoViewIfNeeded();

  const firstRun = await currentRun(page);
  const firstExercise = firstRun.pendingProblem.exercise;
  expect(firstExercise.type).toBe('mc');
  const firstOption = page.getByRole('radio').first().locator('xpath=..');
  const submit = page.getByRole('button', { name: 'Submit answer' });
  await submit.scrollIntoViewIfNeeded();
  const before = {
    prompt: await box(page.getByTestId('lesson-problem-prompt')),
    option: await box(firstOption),
    button: await box(submit),
  };
  await page.screenshot({ path: `${screenshotDir}/lesson-answering.png`, fullPage: true });

  const correct = await correctAnswer(page, firstRun.pendingProblem.id);
  await submitLessonAnswer(page, correct);
  const afterCorrect = {
    prompt: await box(page.getByTestId('lesson-problem-prompt')),
    option: await box(firstOption),
    button: await box(page.getByRole('button', { name: 'Next problem' })),
  };
  expectStableBox(before.prompt, afterCorrect.prompt);
  expectStableBox(before.option, afterCorrect.option);
  expectStableBox(before.button, afterCorrect.button);
  await expect(page.locator('[role="status"]').filter({ hasText: 'Correct' })).toBeVisible();
  await expect(page.getByText('Your answer:')).toHaveCount(0);
  await page.screenshot({ path: `${screenshotDir}/lesson-correct.png`, fullPage: true });

  await nextLessonProblem(page);
  let run = await currentRun(page);
  let problem = run.pendingProblem;
  let answer = await correctAnswer(page, problem.id);
  await submitLessonAnswer(page, Number(answer) + 1_000_000);
  await nextLessonProblem(page);
  run = await currentRun(page);
  problem = run.pendingProblem;
  answer = await correctAnswer(page, problem.id);
  await submitLessonAnswer(page, answer);
  await nextLessonProblem(page);

  run = await currentRun(page);
  problem = run.pendingProblem;
  expect(problem.exercise.type).toBe('mc');
  const submitBeforeWrong = page.getByRole('button', { name: 'Submit answer' });
  await submitBeforeWrong.scrollIntoViewIfNeeded();
  const aboveBeforeNext = {
    pills: await box(page.getByRole('list', { name: 'Lesson steps' })),
    content: await box(page.getByTestId('lesson-step-content')),
    header: await box(page.getByTestId('lesson-problem-header')),
  };
  const correctIds = [await correctAnswer(page, problem.id)].flat();
  const wrongId = problem.exercise.options.find(
    (option: { id: string }) => !correctIds.includes(option.id),
  ).id;
  const promptBeforeNext = await box(page.getByTestId('lesson-problem-prompt'));
  const wrongOption = page.locator(`[id="${problem.exercise.id}-${wrongId}"]`).locator('xpath=..');
  const optionBeforeWrong = await box(wrongOption);
  const buttonBeforeWrong = await box(page.getByRole('button', { name: 'Submit answer' }));
  await submitLessonAnswer(page, wrongId);
  await expect(wrongOption).toHaveAttribute('data-option-state', 'incorrect');
  await expect(page.locator('[data-option-state="correct"]').first()).toBeVisible();
  await expect(page.getByText('Your answer:')).toHaveCount(0);
  const feedback = page.locator('[role="status"]').filter({ hasText: 'Not quite' });
  const feedbackBox = await box(feedback);
  const actionBox = await box(page.getByRole('button', { name: 'Next problem' }));
  expect(feedbackBox.y).toBeGreaterThan(actionBox.y + actionBox.height);
  const afterWrong = {
    prompt: await box(page.getByTestId('lesson-problem-prompt')),
    option: await box(wrongOption),
    button: actionBox,
  };
  expectStableBox(promptBeforeNext, afterWrong.prompt);
  expectStableBox(optionBeforeWrong, afterWrong.option);
  expectStableBox(buttonBeforeWrong, afterWrong.button);
  await page.screenshot({ path: `${screenshotDir}/lesson-wrong.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${screenshotDir}/lesson-wrong-mobile.png`, fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole('button', { name: 'Next problem' }).scrollIntoViewIfNeeded();
  const afterWrongDesktop = {
    prompt: await box(page.getByTestId('lesson-problem-prompt')),
    button: await box(page.getByRole('button', { name: 'Next problem' })),
  };

  let releaseNext!: () => void;
  let nextStarted!: () => void;
  const nextGate = new Promise<void>((resolve) => {
    releaseNext = resolve;
  });
  const requestStarted = new Promise<void>((resolve) => {
    nextStarted = resolve;
  });
  const pointBeforeNext = (await currentRun(page)).currentPointId;
  await page.route('**/api/lessons/supervised-learning/run', async (route) => {
    if (route.request().method() === 'POST') {
      nextStarted();
      await nextGate;
    }
    await route.continue();
  });
  await page.getByRole('button', { name: 'Next problem' }).click();
  await requestStarted;
  await expect(page.getByTestId('lesson-problem')).toHaveAttribute('data-problem-id', problem.id);
  await expect(page.locator('button[data-loading="true"]')).toHaveAttribute('aria-busy', 'true');
  await expect(page.getByTestId('button-spinner')).toBeVisible();
  releaseNext();
  await expect.poll(async () => (await currentRun(page)).pendingProblem?.id).not.toBe(problem.id);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  const nextRun = await currentRun(page);
  const pointAfterNext = nextRun.currentPointId;
  const aboveAfterNext = {
    pills: await box(page.getByRole('list', { name: 'Lesson steps' })),
    content: await box(page.getByTestId('lesson-step-content')),
    header: await box(page.getByTestId('lesson-problem-header')),
  };
  const afterNextPrompt = await box(page.getByTestId('lesson-problem-prompt'));
  const afterNextButton = await box(page.getByRole('button', { name: 'Submit answer' }));
  expect(pointAfterNext).toBe(pointBeforeNext);
  expectStableBox(aboveBeforeNext.pills, aboveAfterNext.pills);
  expectStableBox(aboveBeforeNext.content, aboveAfterNext.content);
  expectStableBox(aboveBeforeNext.header, aboveAfterNext.header);
  expectStableBox(afterWrongDesktop.prompt, afterNextPrompt, ['y']);
  expectStableBox(afterWrongDesktop.button, afterNextButton, ['y']);
  await page.screenshot({ path: `${screenshotDir}/next-problem.png`, fullPage: true });
});

test('session retries keep the action in place and reveal the answer only after the final attempt', async ({
  page,
}) => {
  const db = createDb(env.TEST_DATABASE_URL);
  const [user] = await db.select().from(users).limit(1);
  if (!user) throw new Error('Missing E2E learner');
  const [session] = await db
    .insert(studySessions)
    .values({
      userId: user.id,
      kind: 'weekday',
      plannedMinutes: 20,
      status: 'active',
      startedAt: new Date('2026-01-01T12:00:00.000Z'),
    })
    .returning();
  if (!session) throw new Error('Could not create session');
  await db.insert(sessionActivities).values({
    sessionId: session.id,
    idx: 0,
    kind: 'practice',
    conceptId: 'linear-algebra-fixture-1',
    exerciseIds: ['linear-algebra-fixture-1-basics'],
    plannedMinutes: 10,
    status: 'in_progress',
  });
  await db.$client.end();

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/session/${session.id}`);
  await expect(page.getByTestId('session-exercise')).toBeVisible();
  const submit = page.getByRole('button', { name: 'Submit answer' });
  await submit.scrollIntoViewIfNeeded();
  const before = await box(submit);
  const exercise = await page.evaluate(async () => {
    const response = await fetch('/api/exercises/linear-algebra-fixture-1-basics');
    return response.json();
  });
  const wrong = exercise.options.find((option: { id: string }) => option.id === 'b');
  const correct = exercise.options.find((option: { id: string }) => option.id === 'a');
  await page.locator(`[id="${exercise.id}-${wrong.id}"]`).click();
  const scrollYBefore = await page.evaluate(() => window.scrollY);
  await submit.click();
  const retry = page.getByRole('button', { name: 'Try again · 1 try left' });
  await expect(retry).toBeVisible();
  const actionLabelMeasure = await retry.evaluate((button) => {
    const style = window.getComputedStyle(button);
    const context = document.createElement('canvas').getContext('2d');
    if (!context) throw new Error('Could not measure button labels');
    context.font = style.font;
    const labels = [
      'Submit answer',
      'Submit self-check',
      'Next problem',
      'Next step',
      'Continue',
      'Try again · 1 try left',
    ];
    const widestLabel = labels
      .map((label) => ({ label, width: context.measureText(label).width }))
      .sort((first, second) => second.width - first.width)[0];
    const padding = Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight);
    return {
      buttonWidth: button.getBoundingClientRect().width,
      requiredWidth: widestLabel.width + padding,
      widestLabel: widestLabel.label,
      textWidth: widestLabel.width,
      padding,
    };
  });
  console.log('ExerciseForm primary action width', actionLabelMeasure);
  expect(actionLabelMeasure.buttonWidth).toBeGreaterThanOrEqual(actionLabelMeasure.requiredWidth);
  expect(await page.evaluate(() => window.scrollY)).toBe(scrollYBefore);
  expectStableBox(before, await box(retry));
  await expect(page.locator('[data-option-state="correct"]')).toHaveCount(0);
  await expect(page.locator(`[for="${exercise.id}-${wrong.id}"]`)).toHaveAttribute(
    'data-option-state',
    'incorrect',
  );
  await page.screenshot({ path: `${screenshotDir}/practice-retry.png`, fullPage: true });

  await page.locator(`[id="${exercise.id}-${wrong.id}"]`).click();
  await retry.click();
  await expect(page.getByRole('button', { name: 'Continue' })).toBeVisible();
  await expect(page.locator(`[for="${exercise.id}-${correct.id}"]`)).toHaveAttribute(
    'data-option-state',
    'correct',
  );
});
