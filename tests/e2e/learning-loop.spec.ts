import { mkdirSync, readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { createDb } from '../../src/server/db/client.js';
import { sessionActivities, studySessions, users } from '../../src/server/db/schema.js';
import { env } from '../../src/server/env.js';

const screenshotDir = '/home/ubuntu/screenshots/shadcn';
mkdirSync(screenshotDir, { recursive: true });
let userId = '';

declare global {
  interface Window {
    __layoutShifts: number[];
  }
}

test.beforeEach(async () => {
  const db = createDb(env.TEST_DATABASE_URL);
  await db.delete(users);
  const [user] = await db
    .insert(users)
    .values({
      displayName: 'E2E learner',
      timezone: 'UTC',
      startDate: '2026-01-01',
      prefs: { scheduleMinutes: 60 },
    })
    .returning();
  if (!user) throw new Error('Could not create E2E learner');
  userId = user.id;
  await db.$client.end();
});

test('diagnostic to hinted practice updates the map and schedules a review', async ({ page }) => {
  let now = '2026-01-01T12:00:00.000Z';
  await page.route('**/api/**', (route) =>
    route.continue({
      headers: { ...route.request().headers(), 'x-now': now },
    }),
  );
  let interceptInlineCheck = true;
  await page.route('**/api/attempts', async (route) => {
    if (interceptInlineCheck) {
      interceptInlineCheck = false;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'correct', correct: 1, feedback: 'Correct.' }),
      });
      return;
    }
    await route.continue({
      headers: { ...route.request().headers(), 'x-now': now },
    });
  });
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
  await expect(page.getByText('Machine learning', { exact: true })).toBeVisible();
  const finalSkip = page.waitForResponse(
    (response) => response.url().includes('/skip') && response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'I haven’t studied this domain' }).click();
  await finalSkip;
  await expect(page.getByRole('heading', { name: 'Your starting point' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Your plan' })).toBeVisible();
  await expect(page.getByText('90-day path')).toBeVisible();
  const runId = await page.evaluate(() => window.sessionStorage.getItem('diagnosticRunId'));
  expect(runId).toBeTruthy();
  await page.evaluate(() => window.sessionStorage.clear());
  await page.goto(`/diagnostic/results?id=${runId}`);
  await expect(page.getByText('unassessed · 0 answers', { exact: false }).first()).toBeVisible();
  await expect(page.getByText('First week: ML fundamentals')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'First session' })).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'First session' }).locator('..').locator('li').first(),
  ).toBeVisible();
  await page.evaluate(() => window.sessionStorage.clear());
  await page.goto('/diagnostic/results');
  await expect(page.getByText('First week: ML fundamentals')).toBeVisible();

  await page.getByRole('link', { name: 'View Learn' }).click();
  await expect(page.getByRole('heading', { name: 'Learn', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Next up' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Current week' })).toHaveCount(0);
  await page.screenshot({ path: `${screenshotDir}/today-plan.png`, fullPage: true });
  await page.getByRole('button', { name: 'Start learning' }).click();
  await expect(
    page.getByText('A vector is an ordered list of coordinates in a shared space.'),
  ).toBeVisible();
  await expect(page.getByText('Practice check: vectors-magnitude')).toHaveCount(0);
  await page.getByLabel('Your answer').fill('5');
  await page.getByRole('button', { name: 'Submit answer' }).click();
  await expect(page.getByRole('button', { name: 'Skip this check' })).toHaveCount(0);
  const lessonFeedback = page.getByRole('status').filter({ hasText: 'Correct' }).first();
  await expect(lessonFeedback).toBeVisible();
  await expect(lessonFeedback.getByText('Correct.', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Continue to practice' })).toBeEnabled();
  await page.evaluate(() => {
    document.body.style.minHeight = '200vh';
    window.scrollTo({ top: 500 });
  });
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Continue to practice' }).click();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
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
  await expect(page.getByText('Prerequisites not met')).toBeVisible();
  await page.getByText('Vectors', { exact: true }).first().click();
  await expect(page.getByText('Mastery by dimension')).toBeVisible();
  await expect(page.getByText('math: assisted')).toBeVisible();
  await page.screenshot({ path: `${screenshotDir}/map.png`, fullPage: true });
  await page.goto('/progress');
  await expect(page.getByRole('heading', { name: 'Progress' })).toBeVisible();
  await page.screenshot({ path: `${screenshotDir}/progress.png`, fullPage: true });

  now = '2026-01-15T12:00:00.000Z';
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Next up' })).toBeVisible();
  await expect(
    page
      .getByRole('link', { name: 'Resume session' })
      .or(page.getByRole('button', { name: 'Start learning' })),
  ).toBeVisible();
});

test('diagnostic uses radios, renders option math, and resets answers between questions', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'Start diagnostic' }).click();
  await expect(page.getByRole('radio')).toHaveCount(2);
  await expect(page.locator('.katex').first()).toBeVisible();
  await page.screenshot({ path: `${screenshotDir}/diagnostic.png`, fullPage: true });
  await page.getByRole('radio').first().click();
  await expect(page.getByRole('radio').first()).toHaveAttribute('aria-checked', 'true');
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
  await expect(page.getByText('Machine learning', { exact: true })).toBeVisible();
  const finalSkip = page.waitForResponse(
    (response) => response.url().includes('/skip') && response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'I haven’t studied this domain' }).click();
  await finalSkip;
  await expect(page.getByRole('heading', { name: 'Your starting point' })).toBeVisible();
  await page.getByRole('link', { name: 'View Learn' }).click();
  await page.getByRole('button', { name: 'Start learning' }).click();
  await expect(page.getByRole('button', { name: 'Continue to practice' })).toBeDisabled();
  await expect(page.getByText('Answer or skip the check above to continue.')).toBeVisible();
  await page.getByRole('button', { name: 'Skip this check' }).click();
  await page.getByRole('button', { name: 'Continue to practice' }).click();
  await page.getByLabel('Your answer').fill('0');
  await page.getByRole('button', { name: 'Submit answer' }).click();
  await expect(page.getByText('Not quite', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again · 1 try left' })).toBeVisible();
  await page.getByLabel('Your answer').fill('1');
  await page.getByRole('button', { name: 'Try again · 1 try left' }).click();
  await expect(page.getByText('The magnitude is', { exact: false })).toBeVisible();
});

test('an answered lesson check still unlocks Continue after a reload', async ({ page }) => {
  await page.route('**/api/**', (route) =>
    route.continue({
      headers: { ...route.request().headers(), 'x-now': '2026-01-01T12:00:00.000Z' },
    }),
  );
  await page.goto('/');
  await page.getByRole('link', { name: 'Start diagnostic' }).click();
  for (let step = 0; step < 2; step += 1) {
    const skip = page.waitForResponse(
      (response) => response.url().includes('/skip') && response.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'I haven’t studied this domain' }).click();
    await skip;
  }
  await expect(page.getByRole('heading', { name: 'Your starting point' })).toBeVisible();
  await page.getByRole('link', { name: 'View Learn' }).click();
  await page.getByRole('button', { name: 'Start learning' }).click();
  await page.getByLabel('Your answer').fill('5');
  await page.getByRole('button', { name: 'Submit answer' }).click();
  await expect(page.getByRole('button', { name: 'Continue to practice' })).toBeEnabled();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Continue to practice' })).toBeEnabled();
  await page.getByRole('button', { name: 'Continue to practice' }).click();
  await expect(page.getByRole('button', { name: 'Hint' })).toBeVisible();
});

test('lab uploads fixture results, records evidence, and reveals reflection', async ({ page }) => {
  await page.goto('/lab');
  await expect(page.getByRole('heading', { name: 'Linear regression in NumPy' })).toBeVisible();
  await page.locator('input[type="file"]').setInputFiles({
    name: 'results.json',
    mimeType: 'application/json',
    buffer: readFileSync(new URL('../fixtures/project-results.json', import.meta.url)),
  });
  await expect(page.getByText('1/1 checks passed')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Reflection questions' })).toBeVisible();
  await expect(page.getByText('Complete a gradient update.')).toBeVisible();
});

test('progress displays mastery, goal progress, study time, and evidence sections', async ({
  page,
}) => {
  await page.goto('/progress');
  await expect(page.getByRole('heading', { name: 'Progress' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '90-day goals' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Mastery by domain' })).toBeVisible();
  await expect(page.getByText('Mathematics', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Learning debt' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Study time' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Recent evidence' })).toBeVisible();
  await expect(page.getByText('No answers yet.')).toBeVisible();
});

test('progress loader failure restores the unavailable message', async ({ page }) => {
  await page.route('**/api/progress', (route) => route.abort());
  await page.goto('/progress');
  await expect(page.getByRole('alert')).toHaveText('Progress is unavailable.');
  await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
});

test('route loaders keep content stable under 300ms latency', async ({ page }) => {
  test.setTimeout(60_000);
  await page.addInitScript(() => {
    const shifts: number[] = [];
    window.__layoutShifts = shifts;
    new PerformanceObserver((entries) => {
      for (const entry of entries.getEntries()) {
        const shift = entry as PerformanceEntry & { hadRecentInput: boolean; value: number };
        if (!shift.hadRecentInput) shifts.push(shift.value);
      }
    }).observe({ type: 'layout-shift', buffered: true });
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 300,
    downloadThroughput: -1,
    uploadThroughput: -1,
    connectionType: 'wifi',
  });
  const assertStable = async (path: string) => {
    await page.waitForTimeout(500);
    const cls = await page.evaluate(() =>
      window.__layoutShifts.reduce((total, value) => total + value, 0),
    );
    expect(cls, `${path} CLS`).toBeLessThan(0.02);
    await expect(page.getByText(/Loading/).filter({ visible: true })).toHaveCount(0);
    await page.evaluate(() => {
      window.__layoutShifts = [];
    });
  };

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Welcome to Academy' })).toBeVisible();
  await assertStable('/');
  for (const route of [
    { name: 'Map', path: '/map', heading: 'Knowledge map' },
    { name: 'Lab', path: '/lab', heading: 'Linear regression in NumPy' },
    { name: 'Progress', path: '/progress', heading: 'Progress' },
    { name: 'Settings', path: '/settings', heading: 'Settings' },
    { name: 'Course', path: '/course', heading: 'Course' },
  ]) {
    await page.getByRole('link', { name: route.name }).click();
    await expect(page.getByRole('heading', { name: route.heading })).toBeVisible();
    await assertStable(route.path);
    await page.screenshot({
      path: `${screenshotDir}/${route.name.toLowerCase()}.png`,
      fullPage: true,
    });
  }

  await page.getByRole('link', { name: 'Learn', exact: true }).click();
  await page.getByRole('link', { name: 'Start diagnostic' }).click();
  await expect(page.getByRole('heading', { name: 'Starting-point diagnostic' })).toBeVisible();
  await page.getByRole('button', { name: 'I haven’t studied this domain' }).click();
  await page.getByRole('button', { name: 'I haven’t studied this domain' }).click();
  await expect(page.getByRole('heading', { name: 'Your starting point' })).toBeVisible();
  const runId = await page.evaluate(() => window.sessionStorage.getItem('diagnosticRunId'));
  expect(runId).toBeTruthy();
  await page.goto(`/diagnostic/results?id=${runId}`);
  await expect(page.getByRole('link', { name: 'View Learn' })).toBeVisible();
  await page.screenshot({ path: `${screenshotDir}/diagnostic-results.png`, fullPage: true });
  await page.getByRole('link', { name: 'View Learn' }).click();
  await expect(page.getByRole('heading', { name: 'Next up' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Start learning|Resume session/ })).toBeVisible();
  const db = createDb(env.TEST_DATABASE_URL);
  const [session] = await db
    .insert(studySessions)
    .values({
      userId,
      kind: 'weekday',
      plannedMinutes: 20,
      status: 'active',
      startedAt: new Date('2026-01-01T12:00:00.000Z'),
    })
    .returning();
  if (!session) throw new Error('Could not create session for route loader check');
  await db.insert(sessionActivities).values({
    sessionId: session.id,
    idx: 0,
    kind: 'learn',
    conceptId: 'vectors',
    exerciseIds: ['vectors-magnitude'],
    plannedMinutes: 10,
    status: 'in_progress',
  });
  await db.$client.end();
  await page.evaluate(() => {
    window.__layoutShifts = [];
  });
  await page.goto(`/session/${session.id}`);
  await expect(
    page.getByText('A vector is an ordered list of coordinates in a shared space.'),
  ).toBeVisible();
  await assertStable('/session/:id');
});
