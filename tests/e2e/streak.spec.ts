import { mkdirSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { env } from '../../apps/api/src/config.js';
import { createDb } from '../../apps/api/src/db/client.js';
import { users, xpEvents } from '../../apps/api/src/db/schema.js';
import { enrollInDefaultCourse } from './course-start.js';

const db = createDb(env.TEST_DATABASE_URL);
const screenshots = 'test-results/screenshots/streak';
mkdirSync(screenshots, { recursive: true });

test.afterAll(async () => {
  await db.$client.end();
});

test('The tortoise and the streak reflect persisted XP on Home and Progress at both screen sizes', async ({
  page,
}) => {
  await page.route('**/api/**', (route) =>
    route.continue({
      headers: {
        ...route.request().headers(),
        'x-now': '2026-01-01T12:00:00.000Z',
        'x-time-zone': 'UTC',
      },
    }),
  );
  await db.delete(users);
  const [user] = await db
    .insert(users)
    .values({ displayName: 'Streak learner', timezone: 'UTC', startDate: '2026-01-01' })
    .returning();
  if (!user) throw new Error('Missing learner');
  await enrollInDefaultCourse(db, user.id);
  await db.insert(xpEvents).values({
    userId: user.id,
    kind: 'activity',
    sourceKey: 'streak:yesterday',
    amount: 10,
    localDate: '2025-12-31',
    earnedAt: new Date('2025-12-31T12:00:00Z'),
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '1-day streak' })).toBeVisible();
  await expect(page.getByText('Earn XP today to keep your streak going.')).toBeVisible();
  await expect(page.getByRole('img', { name: 'Academy tortoise', exact: true })).toBeVisible();
  expect((await page.getByTestId('streak-card').boundingBox())?.height).toBeLessThan(140);
  await page.screenshot({ path: `${screenshots}/home-desktop.png`, fullPage: true });
  await page.setViewportSize({ width: 375, height: 812 });
  expect((await page.getByTestId('streak-card').boundingBox())?.height).toBeLessThan(210);
  await page.screenshot({ path: `${screenshots}/home-mobile.png`, fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );

  await db.insert(xpEvents).values({
    userId: user.id,
    kind: 'activity',
    sourceKey: 'streak:today',
    amount: 10,
    localDate: '2026-01-01',
    earnedAt: new Date('2026-01-01T12:00:00Z'),
  });
  await page.reload();
  await expect(page.getByRole('heading', { name: '2-day streak' })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Academy tortoise celebrating' })).toBeVisible();
  await expect(page.getByText("Today's streak is complete.")).toBeVisible();
  await page.goto('/progress');
  await expect(page.getByRole('heading', { name: '2-day streak' })).toBeVisible();
  await page.screenshot({ path: `${screenshots}/progress-mobile.png`, fullPage: true });
  await page.route('**/api/progress', async (route) => {
    const response = await route.fetch();
    const payload = await response.json();
    await route.fulfill({
      response,
      json: { ...payload, streak: { ...payload.streak, current: 1000, longest: 1000 } },
    });
  });
  await page.setViewportSize({ width: 320, height: 812 });
  await page.reload();
  await expect(page.getByRole('heading', { name: '1000-day streak' })).toBeVisible();
  expect((await page.getByTestId('streak-card').boundingBox())?.height).toBeLessThan(230);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: `${screenshots}/progress-small-mobile.png`, fullPage: true });
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await page.screenshot({
    path: `${screenshots}/progress-dark-mobile.png`,
    fullPage: true,
    animations: 'disabled',
  });
});
