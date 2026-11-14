import { mkdirSync } from 'node:fs';
import { onScreenOptions } from '@academy/shared/shuffle';
import { expect, type Page, test } from '@playwright/test';
import { env } from '../../apps/api/src/config.js';
import { loadContent } from '../../apps/api/src/content/load.js';
import type { IndexedExercise } from '../../apps/api/src/content/types.js';
import { createDb } from '../../apps/api/src/db/client.js';
import { users } from '../../apps/api/src/db/schema.js';

const db = createDb(env.TEST_DATABASE_URL);
const contentPath =
  process.env.PLAYWRIGHT_CONTENT_DIR === 'content' ? 'content' : 'tests/fixtures/content';
const content = await loadContent(contentPath);
const screenshots =
  process.env.PLAYWRIGHT_CONTENT_DIR === 'content'
    ? 'test-results/screenshots/placement-real'
    : 'test-results/screenshots/placement-fixture';
mkdirSync(screenshots, { recursive: true });

test.beforeEach(async ({ page }) => {
  await page.route('**/api/**', (route) =>
    route.continue({
      headers: { ...route.request().headers(), 'x-now': '2026-01-07T12:00:00.000Z' },
    }),
  );
  await db.delete(users);
  await db.insert(users).values({
    displayName: 'Placement E2E learner',
    timezone: 'UTC',
    startDate: '2026-01-01',
    prefs: { scheduleMinutes: 60 },
  });
});

test.afterAll(async () => {
  await db.$client.end();
});

async function answerCurrentCorrectly(page: Page) {
  const questionText = await page.getByText(/^Question \d+ of up to 16$/).textContent();
  const questionNumber = Number(questionText?.match(/^Question (\d+)/)?.[1]);
  const question = await page.evaluate(async () => {
    const id = new URLSearchParams(window.location.search).get('id');
    if (!id) throw new Error('Placement id missing');
    const response = await fetch(`/api/placement/${id}/next`);
    return response.json();
  });
  const exercise = content.exercisesById.get(question.exercise.id);
  if (!exercise) throw new Error(`Missing exercise ${question.exercise.id}`);
  if (exercise.type === 'mc') {
    const correctOptions = exercise.options.filter((option) => option.correct);
    if (correctOptions.length === 0) throw new Error(`No correct option for ${exercise.id}`);
    const visibleOptions = onScreenOptions(exercise.options, exercise.id);
    const controls = page.getByRole(exercise.multi ? 'checkbox' : 'radio');
    for (const option of correctOptions) {
      const optionIndex = visibleOptions.findIndex((visible) => visible.id === option.id);
      await controls.nth(optionIndex).click();
    }
  } else if (exercise.type === 'numeric' && 'answer' in exercise) {
    await page.getByRole('textbox').first().fill(String(exercise.answer));
  } else if (exercise.type === 'expression') {
    await page.getByRole('textbox').first().fill(exercise.answer);
  } else {
    throw new Error(
      `Unexpected eligible placement exercise: ${(exercise as IndexedExercise).type}`,
    );
  }
  const submitted = page.waitForResponse(
    (response) =>
      response.url().includes('/api/placement/') &&
      response.url().endsWith('/answer') &&
      response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  await submitted;
  return Promise.race([
    page.waitForURL(/\/placement\/results\?/).then(() => true),
    page
      .getByText(`Question ${questionNumber + 1} of up to 16`)
      .waitFor()
      .then(() => false),
  ]);
}

test('a new learner chooses a course, resumes placement, and sees placed-out topics', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Choose a course' })).toBeVisible();
  for (const course of content.courses) {
    await expect(page.getByRole('heading', { name: course.title, exact: true })).toBeVisible();
  }
  await page.screenshot({ path: `${screenshots}/choose-course-1280.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${screenshots}/choose-course-390.png`, fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole('button', { name: 'Start', exact: true }).first().click();
  await expect(page.getByRole('heading', { name: /^Start / })).toBeVisible();
  await page.screenshot({ path: `${screenshots}/start-card-1280.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${screenshots}/start-card-390.png`, fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole('link', { name: 'Take the placement check' }).click();
  await expect(page.getByRole('heading', { name: /Placement check ·/ })).toBeVisible();
  await expect(page.getByText('Question 1 of up to 16')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Submit', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open tutor' })).toHaveCount(0);
  await page.screenshot({ path: `${screenshots}/question-1280.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${screenshots}/question-390.png`, fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  const unknownAnswer = page.waitForResponse(
    (response) =>
      response.url().includes('/api/placement/') &&
      response.url().endsWith('/answer') &&
      response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: "I don't know" }).click();
  const unknownResponse = await unknownAnswer;
  expect(await unknownResponse.json()).toEqual({ complete: false });
  await expect(page.getByText('Question 2 of up to 16')).toBeVisible();
  const secondPrompt = (await page.getByTestId('placement-prompt').textContent()) ?? '';
  await page.reload();
  await expect(page.getByTestId('placement-prompt')).toHaveText(secondPrompt);

  let complete = false;
  for (let index = 0; index < 16; index += 1) {
    if (complete) break;
    complete = await answerCurrentCorrectly(page);
  }
  await expect(page).toHaveURL(/\/placement\/results\?id=/);
  await expect(page.getByRole('heading', { name: /You placed out of/ })).toBeVisible();
  await page.screenshot({ path: `${screenshots}/results-1280.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${screenshots}/results-390.png`, fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole('link', { name: 'Start learning' }).click();
  await page.getByRole('link', { name: 'Courses', exact: true }).click();
  await expect(page.getByText('Placed out', { exact: true }).first()).toBeVisible();
  await page.screenshot({ path: `${screenshots}/placed-out-1280.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${screenshots}/placed-out-390.png`, fullPage: true });
});

test('starting from the beginning enrolls without a placement run', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Start', exact: true }).first().click();
  await page.getByRole('button', { name: "I'm new to this — start from the beginning" }).click();
  await expect(page.getByRole('heading', { name: 'Next up' })).toBeVisible();
  await page.goto('/course');
  await expect(page.getByRole('heading', { name: /^Start / })).toHaveCount(0);
});

test('switching to an unstarted course shows its start card, then switching back does not', async ({
  page,
}) => {
  await page.goto('/');
  const startedCourse = content.courses[0];
  const otherCourse = content.courses[1];
  if (!startedCourse || !otherCourse) throw new Error('Expected two course fixtures');
  await page.getByRole('button', { name: 'Start', exact: true }).first().click();
  await page.getByRole('button', { name: "I'm new to this — start from the beginning" }).click();
  await page.goto('/course');
  await page.getByRole('button', { name: 'Change course' }).click();
  const other = page
    .locator('[data-slot="card"]')
    .filter({ has: page.getByRole('heading', { name: otherCourse.title, exact: true }) });
  await other.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page.getByRole('heading', { name: `Start ${otherCourse.title}` })).toBeVisible();
  await page.getByRole('button', { name: 'Change course' }).click();
  const first = page
    .locator('[data-slot="card"]')
    .filter({ has: page.getByRole('heading', { name: startedCourse.title, exact: true }) });
  await first.getByRole('button', { name: 'Switch', exact: true }).click();
  await expect(page.getByRole('heading', { name: `Start ${startedCourse.title}` })).toHaveCount(0);
});
