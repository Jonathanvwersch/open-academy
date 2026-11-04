import { expect, test } from '@playwright/test';
import { createDb } from '../../src/server/db/client.js';
import { users } from '../../src/server/db/schema.js';
import { env } from '../../src/server/env.js';

test.beforeEach(async () => {
  const db = createDb(env.TEST_DATABASE_URL);
  await db.delete(users);
  await db.insert(users).values({
    displayName: 'E2E learner',
    timezone: 'UTC',
    startDate: '2026-01-01',
    prefs: { scheduleMinutes: 60 },
  });
  await db.$client.end();
});

test('diagnostic to hinted practice updates the map and schedules a review', async ({ page }) => {
  let now = '2026-01-01T12:00:00.000Z';
  await page.route('**/api/**', (route) =>
    route.continue({
      headers: { ...route.request().headers(), 'x-now': now },
    }),
  );
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Welcome to Academy' })).toBeVisible();
  await page.evaluate(async () => {
    await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scheduleMinutes: 60, startDate: '2026-01-01' }),
    });
  });

  await page.getByRole('link', { name: 'Start diagnostic' }).click();
  await expect(page.getByRole('heading', { name: 'Starting-point diagnostic' })).toBeVisible();
  const firstSkip = page.waitForResponse(
    (response) => response.url().includes('/skip') && response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'I haven’t studied this domain' }).click();
  const firstSkipResult = await (await firstSkip).json();
  expect(firstSkipResult).toMatchObject({
    complete: false,
    state: { domains: { math: { status: 'unassessed' }, ml: { status: 'active' } } },
  });
  await expect(page.locator('article > p').first()).toHaveText('ml');
  const finalSkip = page.waitForResponse(
    (response) => response.url().includes('/skip') && response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'I haven’t studied this domain' }).click();
  await finalSkip;
  await expect(page.getByRole('heading', { name: 'Your starting point' })).toBeVisible();

  await page.getByRole('link', { name: 'View Today' }).click();
  await page.getByRole('button', { name: 'Start session' }).click();
  await expect(
    page.getByText('A vector is an ordered list of coordinates in a shared space.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue to practice' })).toBeVisible();
  await page.getByRole('button', { name: 'Continue to practice' }).click();
  await expect(page.getByRole('button', { name: 'Hint' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Hint' })).toBeVisible();
  await page.getByRole('button', { name: 'Hint' }).click();
  await expect(page.getByText('Use the Pythagorean theorem.')).toBeVisible();
  await page.getByLabel('Your answer').fill('5');
  await page.getByRole('button', { name: 'Submit answer' }).click();
  await expect(page.getByText('Correct', { exact: true })).toBeVisible();

  await page.goto('/map');
  await page.getByText('Vectors', { exact: true }).first().click();
  await expect(page.getByText('Mastery by dimension')).toBeVisible();
  await expect(page.getByText('math: assisted')).toBeVisible();

  now = '2026-01-15T12:00:00.000Z';
  await page.goto('/');
  await expect(page.getByText('1 review due')).toBeVisible();
  await expect(page.getByText('Review · vectors', { exact: false })).toBeVisible();
});
