import { expect, test } from '@playwright/test';
import { env } from '../../apps/api/src/config.js';
import { createDb } from '../../apps/api/src/db/client.js';
import { diagnosticRuns, users } from '../../apps/api/src/db/schema.js';

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

test('routes fit mobile viewports without horizontal page or navigation overflow', async ({
  page,
}) => {
  for (const width of [390, 360]) {
    await page.setViewportSize({ width, height: 844 });
    for (const route of [
      '/',
      '/course',
      '/projects/linreg-numpy',
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
      const navigation = await page
        .getByRole('navigation', { name: 'Main navigation' })
        .evaluate((element) => ({
          scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth,
          items: Array.from(element.children).map((item) => ({
            text: item.textContent,
            width: item.getBoundingClientRect().width,
            padding: getComputedStyle(item).paddingInline,
            fontSize: getComputedStyle(item).fontSize,
          })),
        }));
      expect(
        navigation.scrollWidth,
        `navigation overflows at ${width}px: ${JSON.stringify(navigation)}`,
      ).toBeLessThanOrEqual(navigation.clientWidth);
    }
  }
});

test('course route skeleton aligns with the Open Academy wordmark', async ({ page }) => {
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
  const wordmark = page.getByRole('link', { name: 'Open Academy', exact: true });
  await expect(wordmark.locator('svg')).toHaveAttribute('viewBox', '0 0 16 16');
  const wordmarkBounds = await wordmark.boundingBox();
  expect(skeletonBounds).not.toBeNull();
  expect(wordmarkBounds).not.toBeNull();
  expect(Math.abs((skeletonBounds?.x ?? 0) - (wordmarkBounds?.x ?? 0))).toBeLessThanOrEqual(1);
  await navigation;
});

test('root auth pending renders the app-shell skeleton', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route('**/api/auth/me', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1800));
    await route.continue({
      headers: { ...route.request().headers(), 'x-now': '2026-01-01T12:00:00.000Z' },
    });
  });
  await page.goto('/course');
  const shell = page.getByTestId('app-shell-skeleton');
  await expect(shell).toBeVisible();
  await expect(shell.locator('header')).toBeVisible();
  await expect(shell.getByTestId('route-skeleton')).toBeVisible();
  await expect(shell.locator('nav > *')).toHaveCount(4);
  await expect(shell).toBeHidden();
});
