import { readFileSync } from 'node:fs';
import type { LessonPayload, LessonReviewPayload } from '@academy/aesop/api/lessons';
import { expect, test } from '@playwright/test';
import { parse } from 'yaml';
import { env } from '../../apps/api/src/config.js';
import { createDb } from '../../apps/api/src/db/client.js';
import { users } from '../../apps/api/src/db/schema.js';

const db = createDb(env.TEST_DATABASE_URL);
const screenshotStyle = 'header, button[aria-label="Open tutor"] { visibility: hidden; }';
const lesson = parse(
  readFileSync(new URL('../../content/lessons/eigen-svd.yaml', import.meta.url), 'utf8'),
) as {
  knowledge_points: LessonPayload['knowledge_points'];
  where_this_fits: string;
  summary: string;
  recap: Array<{ concept: string; text: string }>;
};
const payload: LessonReviewPayload = {
  canRestart: false,
  course: null,
  conceptTitle: 'Eigenvalues, eigenvectors and SVD',
  runStatus: null,
  checks: {},
  checkAnswers: {},
  lesson: {
    knowledge_points: lesson.knowledge_points,
    where_this_fits: lesson.where_this_fits,
    prerequisites: lesson.recap.map((item) => ({
      id: item.concept,
      title: 'Matrices and matrix-vector multiplication',
      recap: item.text,
    })),
    blocks: [{ kind: 'summary', md: lesson.summary }],
  },
};

test.beforeEach(async ({ page }) => {
  await db.delete(users);
  await db
    .insert(users)
    .values({ displayName: 'Lesson motion learner', timezone: 'UTC', startDate: '2026-01-01' });
  await page.route('**/api/lessons/eigen-svd/review', (route) => route.fulfill({ json: payload }));
});
test.afterAll(async () => {
  await db.$client.end();
});

test('the eigen transformation plays on request, pauses, scrubs, and fits desktop and mobile', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/lessons/eigen-svd');
  const visual = page.getByTestId('eigen-motion');
  const slider = visual.getByRole('slider', { name: 'Transformation progress' });
  await expect(visual).toBeVisible();
  await expect(slider).toHaveValue('0');
  await expect(visual.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
  await visual.getByRole('button', { name: 'Play', exact: true }).click();
  await expect.poll(async () => Number(await slider.inputValue())).toBeGreaterThan(5);
  await visual.getByRole('button', { name: 'Replay', exact: true }).click();
  expect(Number(await slider.inputValue())).toBeLessThan(5);
  await expect.poll(async () => Number(await slider.inputValue())).toBeGreaterThan(5);
  await visual.getByRole('button', { name: 'Pause', exact: true }).click();
  const paused = await slider.inputValue();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(slider).toHaveValue(paused);
  await slider.focus();
  await slider.press('End');
  await expect(slider).toHaveAttribute('aria-valuetext', '100 percent; output (3, 3)');
  await visual.getByRole('button', { name: '(1, −1)', exact: true }).click();
  await expect(slider).toHaveAttribute('aria-valuetext', '100 percent; output (1, −1)');
  await visual.getByRole('button', { name: '(1, 0)', exact: true }).click();
  await expect(slider).toHaveAttribute('aria-valuetext', '100 percent; output (2, 1)');
  await visual.getByRole('button', { name: 'Replay', exact: true }).click();
  await expect(visual.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  expect(Number(await slider.inputValue())).toBeLessThan(10);
  await visual.getByRole('button', { name: 'Pause', exact: true }).click();
  await slider.focus();
  await slider.press('End');
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => document.fonts.ready);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
    await visual.screenshot({
      path: `test-results/screenshots/lesson-motion/eigen-${width}.png`,
      style: screenshotStyle,
    });
  }
  await visual.getByRole('button', { name: '(1, 1)', exact: true }).click();
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [index, step] of (await page.locator('article').all()).entries()) {
      expect(await step.evaluate((element) => element.scrollWidth)).toBeLessThanOrEqual(
        await step.evaluate((element) => element.clientWidth),
      );
      await step.screenshot({
        path: `test-results/screenshots/lesson-motion/step-${index + 1}-${width}.png`,
        style: screenshotStyle,
      });
    }
  }
});

test('scene metadata accepts whitespace and unknown scenes retain the static SVG', async ({
  page,
}) => {
  const padded = structuredClone(payload);
  const paddedFirst = padded.lesson.knowledge_points?.[0];
  if (!paddedFirst) throw new Error('Missing first step');
  paddedFirst.explain = paddedFirst.explain.replace(
    'academy-visual=eigen-directions',
    'academy-visual=eigen-directions   ',
  );
  await page.route('**/api/lessons/eigen-svd/review', (route) => route.fulfill({ json: padded }));
  await page.goto('/lessons/eigen-svd');
  await expect(page.getByTestId('eigen-motion')).toBeVisible();
  const unknown = structuredClone(payload);
  const first = unknown.lesson.knowledge_points?.[0];
  if (!first) throw new Error('Missing first step');
  first.explain = first.explain.replace(
    'academy-visual=eigen-directions',
    'academy-visual=unknown',
  );
  await page.route('**/api/lessons/eigen-svd/review', (route) => route.fulfill({ json: unknown }));
  await page.reload();
  await expect(page.getByTestId('eigen-motion')).toHaveCount(0);
  await expect(page.getByRole('img', { name: /^Three grey input arrows/ })).toBeVisible();
});

test.describe('with reduced motion', () => {
  test.use({ reducedMotion: 'reduce' });
  test('shows the complete static diagram without playback controls', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/lessons/eigen-svd');
    const fallback = page.getByTestId('eigen-motion-static');
    await expect(fallback).toBeVisible();
    await expect(fallback.getByRole('img', { name: /^Three grey input arrows/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Play', exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );
    await fallback.screenshot({
      path: 'test-results/screenshots/lesson-motion/eigen-reduced-390.png',
      style: screenshotStyle,
    });
  });
});
