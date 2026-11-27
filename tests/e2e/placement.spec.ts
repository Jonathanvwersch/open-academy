import { mkdirSync } from 'node:fs';
import { onScreenOptions } from '@open-academy/engine/internal/course/option-order';
import type { IndexedExercise } from '@open-academy/engine/internal/course/types';
import { courseFoundations } from '@open-academy/engine/internal/graph/prerequisites';
import { expect, type Page, test } from '@playwright/test';
import { env } from '../../apps/api/src/config.js';
import { loadContent } from '../../apps/api/src/content/load.js';
import { createDb } from '../../apps/api/src/db/client.js';
import { users } from '../../apps/api/src/db/schema.js';

const db = createDb(env.TEST_DATABASE_URL);
const contentPath =
  process.env.PLAYWRIGHT_CONTENT_DIR === 'content' ? 'content' : 'tests/fixtures/content';
const content = await loadContent(contentPath);
const screenshots =
  process.env.PLACEMENT_SCREENSHOT_DIR ??
  (process.env.PLAYWRIGHT_CONTENT_DIR === 'content'
    ? 'test-results/screenshots/placement-real'
    : 'test-results/screenshots/placement-fixture');
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
    const visibleOptions = onScreenOptions(
      question.exercise.options as typeof exercise.options,
      exercise.id,
    ) as typeof exercise.options;
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
  const firstCourse = content.courses[0];
  if (!firstCourse) throw new Error('Expected a course fixture');
  for (const course of content.courses) {
    await expect(page.getByRole('heading', { name: course.title, exact: true })).toBeVisible();
  }
  await page.screenshot({ path: `${screenshots}/choose-course-1280.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${screenshots}/choose-course-390.png`, fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole('link', { name: new RegExp(firstCourse.title) }).click();
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
  await page.goto(`/courses/${firstCourse.id}`);
  await expect(page.getByText('Placed out', { exact: true }).first()).toBeVisible();
  await page.screenshot({ path: `${screenshots}/placed-out-1280.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${screenshots}/placed-out-390.png`, fullPage: true });
});

test('a failed placement start can be retried', async ({ page }) => {
  let startRequests = 0;
  await page.route('**/api/placement', async (route) => {
    startRequests += 1;
    if (startRequests === 1) {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Temporary error' }),
      });
      return;
    }
    await route.continue({
      headers: { ...route.request().headers(), 'x-now': '2026-01-07T12:00:00.000Z' },
    });
  });

  const firstCourse = content.courses[0];
  if (!firstCourse) throw new Error('Expected a course fixture');
  await page.goto(`/courses/${firstCourse.id}`);
  await page.getByRole('link', { name: 'Take the placement check' }).click();
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Back to Courses' })).toBeVisible();
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('heading', { name: /Placement check ·/ })).toBeVisible();
  expect(startRequests).toBe(2);
});

test('starting from the beginning enrolls without a placement run', async ({ page }) => {
  const firstCourse = content.courses[0];
  if (!firstCourse) throw new Error('Expected a course fixture');
  await page.goto(`/courses/${firstCourse.id}`);
  await page.getByRole('button', { name: "I'm new to this — start from the beginning" }).click();
  await expect(page).toHaveURL(`/courses/${firstCourse.id}`);
  await expect(page.getByRole('heading', { name: firstCourse.title, exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: /^Start / })).toHaveCount(0);
  await page.goto(`/courses/${firstCourse.id}`);
  await expect(page.getByRole('heading', { name: /^Start / })).toHaveCount(0);
});

test('adding a second course keeps both courses in My courses', async ({ page }) => {
  const startedCourse = content.courses[0];
  const otherCourse = content.courses[1];
  if (!startedCourse || !otherCourse) throw new Error('Expected two course fixtures');
  await page.goto(`/courses/${startedCourse.id}`);
  await page.getByRole('button', { name: "I'm new to this — start from the beginning" }).click();
  await page.goto(`/courses/${otherCourse.id}`);
  await expect(page.getByRole('heading', { name: `Start ${otherCourse.title}` })).toBeVisible();
  await page.getByRole('button', { name: "I'm new to this — start from the beginning" }).click();
  await expect(page.getByRole('heading', { name: `Start ${otherCourse.title}` })).toHaveCount(0);
  await page.reload();
  const navigation = page.getByRole('navigation', { name: 'Main navigation' });
  await expect(
    navigation.getByRole('link', { name: new RegExp(startedCourse.title) }),
  ).toBeVisible();
  await expect(navigation.getByRole('link', { name: new RegExp(otherCourse.title) })).toBeVisible();
});

test('placement results keep foundations separate and hide an empty foundations card', async ({
  page,
}) => {
  await page.route('**/api/placement/*/results', async (route) => {
    const runId = new URL(route.request().url()).pathname.split('/')[3];
    const hasFoundation = runId === 'with-foundation';
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        courseId: 'fixture-course',
        courseTitle: 'Fixture course',
        placedOut: hasFoundation ? ['Course topic'] : [],
        foundationsPlacedOut: hasFoundation ? ['Foundation topic'] : [],
        movedBack: [],
        topicsTotal: 9,
        topicsDone: hasFoundation ? 2 : 0,
        firstTopic: 'Next topic',
      }),
    });
  });

  await page.goto('/placement/results?id=with-foundation');
  await expect(
    page.getByRole('heading', { name: 'You placed out of 1 of 9 topics' }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Foundations you already know' })).toBeVisible();
  await expect(page.getByText('Foundation topic', { exact: true })).toBeVisible();
  await page.goto('/placement/results?id=without-foundation');
  await expect(
    page.getByText("No course topics placed out — you'll start from the beginning."),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Foundations you already know' })).toHaveCount(0);
});

test('real-content results keep known foundations separate from course topics', async ({
  page,
}) => {
  test.skip(
    process.env.PLAYWRIGHT_CONTENT_DIR !== 'content',
    'requires authored course foundations',
  );
  await page.setViewportSize({ width: 1280, height: 900 });
  const course = content.coursesById.get('deep-learning');
  if (!course) throw new Error('Missing Deep Learning course');
  const foundations = courseFoundations(content, course.id);
  if (foundations.length === 0) throw new Error('Deep Learning should have foundation topics');
  await page.goto(`/courses/${course.id}`);
  await expect(page.getByRole('heading', { name: `Start ${course.title}` })).toBeVisible();
  await page.getByRole('link', { name: 'Take the placement check' }).click();
  await expect(page.getByRole('heading', { name: /Placement check ·/ })).toBeVisible();

  let complete = false;
  for (let index = 0; index < 16; index += 1) {
    if (complete) break;
    complete = await answerCurrentCorrectly(page);
  }
  await expect(page).toHaveURL(/\/placement\/results\?id=/);
  await expect(page.getByRole('heading', { name: /You placed out of/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Foundations you already know' })).toBeVisible();
  const results = await page.evaluate(async () => {
    const runId = new URLSearchParams(window.location.search).get('id');
    if (!runId) throw new Error('Placement id missing');
    const response = await fetch(`/api/placement/${runId}/results`);
    return response.json();
  });
  expect(results.foundationsPlacedOut.length).toBeGreaterThan(0);
  await expect(page.getByText(results.foundationsPlacedOut[0], { exact: true })).toBeVisible();
  await page.screenshot({ path: `${screenshots}/foundations-results-1280.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${screenshots}/foundations-results-390.png`, fullPage: true });
});
