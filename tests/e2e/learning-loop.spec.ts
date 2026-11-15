import { mkdirSync, readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { env } from '../../apps/api/src/config.js';
import { createDb } from '../../apps/api/src/db/client.js';
import { sessionActivities, studySessions, users } from '../../apps/api/src/db/schema.js';
import { enrollInDefaultCourse } from './course-start.js';

const screenshotDir = 'test-results/screenshots/screenshots/shadcn';
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
  await enrollInDefaultCourse(db, userId);
  await db.$client.end();
});

test('project uploads fixture results, records evidence, and reveals reflection', async ({
  page,
}) => {
  await page.goto('/projects/linreg-numpy');
  await expect(page.getByRole('heading', { name: 'Linear regression in NumPy' })).toBeVisible();
  await page.locator('input[type="file"]').setInputFiles({
    name: 'results.json',
    mimeType: 'application/json',
    buffer: readFileSync(new URL('../fixtures/project-results.json', import.meta.url)),
  });
  await page.getByRole('button', { name: 'Upload results', exact: true }).click();
  await expect(page.getByText('1/1 checks passed')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Reflection questions' })).toBeVisible();
  await expect(page.getByText('Complete a gradient update.')).toBeVisible();
});

test('progress displays mastery and stats without debt or recent answers', async ({ page }) => {
  await page.goto('/progress');
  await expect(page.getByRole('heading', { name: 'Progress' })).toBeVisible();
  await expect(page.getByText(/Topics done:/)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'By course' })).toBeVisible();
  await expect(page.getByText('Fixture subject', { exact: true })).toBeVisible();
  await expect(page.getByText(/Study time:/)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Learning debt' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Recent answers' })).toHaveCount(0);
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
  await expect(page.getByRole('heading', { name: 'Next up' })).toBeVisible();
  await assertStable('/');
  for (const route of [
    { name: 'Progress', path: '/progress', heading: 'Progress' },
    { name: 'Settings', path: '/settings', heading: 'Settings' },
    { name: 'Courses', path: '/course', heading: 'Fixture course' },
  ]) {
    await page.getByRole('link', { name: route.name }).click();
    await expect(page.getByRole('heading', { name: route.heading })).toBeVisible();
    await assertStable(route.path);
    await page.screenshot({
      path: `${screenshotDir}/${route.name.toLowerCase()}.png`,
      fullPage: true,
    });
  }

  await page.goto('/projects/linreg-numpy');
  await expect(page.getByRole('heading', { name: 'Linear regression in NumPy' })).toBeVisible();
  await assertStable('/projects/linreg-numpy');
  await page.screenshot({
    path: `${screenshotDir}/linear-regression-project.png`,
    fullPage: true,
  });

  await page.getByRole('link', { name: 'Home', exact: true }).click();
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
    exerciseIds: ['vectors-component-sum'],
    plannedMinutes: 10,
    status: 'in_progress',
  });
  await db.$client.end();
  await page.evaluate(() => {
    window.__layoutShifts = [];
  });
  await page.goto(`/session/${session.id}`);
  await expect(page.getByText('Question 1', { exact: true })).toBeVisible();
  await expect(page.getByTestId('lesson-problem-prompt')).toContainText(
    'Which statement best describes the main idea',
  );
  await assertStable('/session/:id');
});
