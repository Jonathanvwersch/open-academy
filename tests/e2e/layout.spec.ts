import { expect, test } from '@playwright/test';
import { createDb } from '../../src/server/db/client.js';
import { diagnosticRuns, users } from '../../src/server/db/schema.js';
import { env } from '../../src/server/env.js';

const db = createDb(env.TEST_DATABASE_URL);
let userId = '';

test.beforeEach(async ({ page }) => {
  await page.route('**/api/**', (route) =>
    route.continue({
      headers: { ...route.request().headers(), 'x-now': '2026-01-01T12:00:00.000Z' },
    }),
  );
  await db.delete(users);
  const [user] = await db
    .insert(users)
    .values({
      displayName: 'Layout E2E learner',
      timezone: 'UTC',
      startDate: '2026-01-01',
      prefs: { scheduleMinutes: 60 },
    })
    .returning();
  if (!user) throw new Error('Could not create layout E2E learner');
  userId = user.id;
  await db.insert(diagnosticRuns).values({
    userId,
    status: 'completed',
    state: {},
    startedAt: new Date('2026-01-01T10:00:00.000Z'),
    completedAt: new Date('2026-01-01T10:10:00.000Z'),
  });
});

test.afterAll(async () => {
  await db.$client.end();
});

test('routes fit a 390px viewport without horizontal page overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const route of [
    '/',
    '/course',
    '/map',
    '/lab',
    '/progress',
    '/settings',
    '/lessons/linear-models',
  ]) {
    await page.goto(route);
    await expect(page.locator('h1').first()).toBeAttached();
    const dimensions = await page.evaluate(() => ({
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
    }));
    expect(
      dimensions.documentWidth,
      `${route} overflows a ${dimensions.viewportWidth}px viewport`,
    ).toBeLessThanOrEqual(dimensions.viewportWidth);
  }
});

test('course route skeleton aligns with the Academy wordmark', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.route('**/api/course*', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.continue({
      headers: { ...route.request().headers(), 'x-now': '2026-01-01T12:00:00.000Z' },
    });
  });
  const navigation = page.getByRole('link', { name: 'Course', exact: true }).click();
  const skeleton = page.getByTestId('route-skeleton');
  await expect(skeleton).toBeVisible();
  const skeletonBounds = await skeleton.boundingBox();
  const wordmarkBounds = await page.getByRole('link', { name: 'Academy' }).boundingBox();
  expect(skeletonBounds).not.toBeNull();
  expect(wordmarkBounds).not.toBeNull();
  expect(Math.abs((skeletonBounds?.x ?? 0) - (wordmarkBounds?.x ?? 0))).toBeLessThanOrEqual(1);
  await navigation;
});
