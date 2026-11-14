import { mkdirSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { env } from '../../apps/api/src/config.js';
import { createDb } from '../../apps/api/src/db/client.js';
import { diagnosticRuns, users, xpEvents } from '../../apps/api/src/db/schema.js';

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
  await db.insert(diagnosticRuns).values({
    userId: user.id,
    status: 'completed',
    state: {},
    completedAt: new Date('2026-01-01T10:00:00Z'),
  });
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
  await page.screenshot({ path: `${screenshots}/home-desktop.png`, fullPage: true });
  await page.setViewportSize({ width: 375, height: 812 });
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
  await expect(page.getByText('You showed up today. See you tomorrow!')).toBeVisible();
  await page.goto('/progress');
  await expect(page.getByRole('heading', { name: '2-day streak' })).toBeVisible();
  await page.screenshot({ path: `${screenshots}/progress-mobile.png`, fullPage: true });
});
