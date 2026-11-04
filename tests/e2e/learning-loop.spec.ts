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
  await expect(page.locator('article > p').first()).toHaveText('Machine learning');
  const finalSkip = page.waitForResponse(
    (response) => response.url().includes('/skip') && response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'I haven’t studied this domain' }).click();
  await finalSkip;
  await expect(page.getByRole('heading', { name: 'Your starting point' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Your plan' })).toBeVisible();
  await expect(page.getByText('90-day path')).toBeVisible();
  await expect(page.getByText('assessed', { exact: false }).first()).toBeVisible();

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
  const attemptResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/attempts') && response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Submit answer' }).click();
  expect(await (await attemptResponse).json()).toMatchObject({ hintsUsed: 1, credit: 0.7 });
  await expect(page.getByText('Correct', { exact: true })).toBeVisible();
  const today = await page.evaluate(async () => (await fetch('/api/today')).json());
  expect(today.dueReviews).toBe(0);
  const concepts = today.plan.activities
    .map((activity: { conceptId?: string }) => activity.conceptId)
    .filter(Boolean);
  expect(new Set(concepts).size).toBe(concepts.length);
  expect(today.plan.activities.length).toBeLessThanOrEqual(6);

  await page.goto('/map');
  await page.getByText('Vectors', { exact: true }).first().click();
  await expect(page.getByText('Mastery by dimension')).toBeVisible();
  await expect(page.getByText('math: assisted')).toBeVisible();

  now = '2026-01-15T12:00:00.000Z';
  await page.goto('/');
  await expect(page.getByText('1 review due')).toBeVisible();
  await expect(page.getByText('Review · vectors', { exact: false })).toBeVisible();
});

test('diagnostic uses radios, renders option math, and resets answers between questions', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'Start diagnostic' }).click();
  await expect(page.getByRole('radio')).toHaveCount(2);
  await expect(page.locator('.katex').first()).toBeVisible();
  await page.getByRole('radio').first().check();
  await page.getByRole('button', { name: 'Submit answer' }).click();
  await expect(page.getByLabel('Your answer')).toBeVisible();
  await expect(page.getByLabel('Your answer')).toHaveValue('');
});

test('a final wrong practice answer reveals the worked solution', async ({ page }) => {
  await page.route('**/api/**', (route) =>
    route.continue({
      headers: { ...route.request().headers(), 'x-now': '2026-01-01T12:00:00.000Z' },
    }),
  );
  await page.goto('/');
  await page.getByRole('link', { name: 'Start diagnostic' }).click();
  await expect(page.getByRole('heading', { name: 'Starting-point diagnostic' })).toBeVisible();
  const firstSkip = page.waitForResponse(
    (response) => response.url().includes('/skip') && response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'I haven’t studied this domain' }).click();
  await firstSkip;
  await expect(page.locator('article > p').first()).toHaveText('Machine learning');
  const finalSkip = page.waitForResponse(
    (response) => response.url().includes('/skip') && response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'I haven’t studied this domain' }).click();
  await finalSkip;
  await expect(page.getByRole('heading', { name: 'Your starting point' })).toBeVisible();
  await page.getByRole('link', { name: 'View Today' }).click();
  await page.getByRole('button', { name: 'Start session' }).click();
  await page.getByRole('button', { name: 'Continue to practice' }).click();
  await page.getByLabel('Your answer').fill('0');
  await page.getByRole('button', { name: 'Submit answer' }).click();
  await expect(page.getByText('Not quite', { exact: true })).toBeVisible();
  await page.getByLabel('Your answer').fill('1');
  await page.getByRole('button', { name: 'Submit answer' }).click();
  await expect(page.getByText('The magnitude is', { exact: false })).toBeVisible();
});
