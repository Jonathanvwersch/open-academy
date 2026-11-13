import { expect, test } from '@playwright/test';
import { env } from '../../apps/api/src/config.js';
import { createDb } from '../../apps/api/src/db/client.js';
import { diagnosticRuns, studySessions, users } from '../../apps/api/src/db/schema.js';

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
  for (const width of [320, 390, 768]) {
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
      if (route === '/progress') {
        const masteredValue = page
          .getByText('Concepts mastered', { exact: true })
          .locator('..')
          .locator('p')
          .nth(1);
        const studyValue = page
          .getByText('Study time', { exact: true })
          .locator('..')
          .locator('p')
          .nth(1);
        for (const value of [masteredValue, studyValue]) {
          const bounds = await value.boundingBox();
          expect(bounds?.height, `progress value wraps at ${width}px`).toBeLessThanOrEqual(32);
        }
      }
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
  await expect(shell.locator('nav > *')).toHaveCount(5);
  await expect(shell).toBeHidden();
});

test('settings edits stay accessible and the save spinner keeps its geometry', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/settings');
  await page.getByLabel('Daily study time', { exact: true }).fill('90');
  await page.getByLabel('Saturday study time', { exact: true }).fill('120');
  await page.getByLabel('Sunday study time', { exact: true }).fill('90');
  await expect(page.getByText('11 hours / week')).toBeVisible();
  let releaseSave: () => void = () => {};
  const waiting = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  await page.route('**/api/settings', async (route) => {
    if (route.request().method() === 'PUT') await waiting;
    await route.continue();
  });
  const save = page.getByRole('button', { name: 'Save settings' });
  await save.scrollIntoViewIfNeeded();
  const before = await save.boundingBox();
  await save.click();
  try {
    await expect(save).toHaveAttribute('aria-busy', 'true');
    const during = await save.boundingBox();
    const spinner = await save.getByTestId('button-spinner').locator('svg').boundingBox();
    expect(during).toEqual(before);
    expect(spinner).not.toBeNull();
    if (!during || !spinner) throw new Error('Expected visible save control and spinner');
    expect(Math.abs(spinner.x + spinner.width / 2 - during.x - during.width / 2)).toBeLessThan(1);
    expect(Math.abs(spinner.y + spinner.height / 2 - during.y - during.height / 2)).toBeLessThan(1);
  } finally {
    releaseSave();
  }
  await expect(page.getByRole('status')).toContainText('Saved');
  await page.reload();
  await expect(page.getByLabel('Daily study time', { exact: true })).toHaveValue('90');
  await expect(page.getByLabel('Saturday study time', { exact: true })).toHaveValue('120');
  await expect(page.getByLabel('Sunday study time', { exact: true })).toHaveValue('90');
});

test('first visits wait for real layout data without inventing placeholder cards', async ({
  page,
}) => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/course', async (route) => {
    await gate;
    await route.continue();
  });
  await page.goto('/course');
  try {
    const pending = page.getByTestId('route-skeleton');
    await expect(pending).toBeVisible();
    await expect(pending.locator('[data-layout-shape]')).toHaveCount(0);
    await expect(page.locator('[data-page-frame] [data-slot="card"]')).toHaveCount(0);
  } finally {
    release();
  }
  await expect(page.locator('[data-page-frame] [data-slot="card"]').first()).toBeVisible();
});

test('session loading starts lesson metadata and run state together without fetching papers', async ({
  page,
}) => {
  await page.goto('/');
  const session = await page.evaluate(async () =>
    (
      await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ budgetMinutes: 60, focusConceptId: 'supervised-learning' }),
      })
    ).json(),
  );
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let runStarted = false;
  const requests: string[] = [];
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    requests.push(path);
    if (path === '/api/lessons/supervised-learning/run') runStarted = true;
    if (path === '/api/lessons/supervised-learning') await gate;
    await route.continue();
  });
  const navigation = page.goto(`/session/${session.id}`);
  try {
    await expect.poll(() => runStarted).toBe(true);
  } finally {
    release();
  }
  await navigation;
  await expect(page.getByTestId('lesson-problem')).toBeVisible();
  expect(requests).not.toContain('/api/papers');
});

test('Home and the tutor share one Today request', async ({ page }) => {
  let todayRequests = 0;
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/today') todayRequests += 1;
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Next up' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open tutor' })).toBeVisible();
  expect(todayRequests).toBe(1);
});

test('plain Settings and Course pages do not load the Markdown and math renderer', async ({
  page,
}) => {
  const markdownRequests: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.includes('/src/components/markdown.'))
      markdownRequests.push(request.url());
  });
  await page.goto('/settings');
  await expect(page.getByRole('button', { name: 'Save settings' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open tutor' })).toBeVisible();
  expect(markdownRequests).toEqual([]);
  await page.getByRole('link', { name: 'Course', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Week 1 · ML fundamentals' })).toBeVisible();
  expect(markdownRequests).toEqual([]);
});

test('finishing a session returns Home without a reload or a stale Resume action', async ({
  page,
}) => {
  const [session] = await db
    .insert(studySessions)
    .values({
      userId,
      kind: 'weekday',
      plannedMinutes: 20,
      status: 'active',
      startedAt: new Date('2026-01-01T12:00:00Z'),
    })
    .returning();
  if (!session) throw new Error('Expected a session');
  await page.goto('/');
  await page.getByRole('link', { name: 'Resume session', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Session complete', exact: true })).toBeVisible();
  const documentStartedAt = await page.evaluate(() => performance.timeOrigin);
  await page.getByRole('button', { name: 'Finish session', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Next up', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Resume session', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(documentStartedAt);
});

test('Course still renders formatted metadata when it needs Markdown and math', async ({
  page,
}) => {
  await page.route('**/api/course', async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    data.weeks[0].papers[0].title = '$x^2$';
    data.weeks[0].project.title = '**Linear model**';
    await route.fulfill({ response, json: data });
  });
  await page.goto('/course');
  await expect(page.locator('.katex').first()).toBeVisible();
  await expect(page.locator('strong').filter({ hasText: 'Linear model' })).toBeVisible();
});
