import { expect, type Page, test } from '@playwright/test';
import { env } from '../../apps/api/src/config.js';
import { createDb } from '../../apps/api/src/db/client.js';
import {
  diagnosticRuns,
  sessionActivities,
  studySessions,
  users,
} from '../../apps/api/src/db/schema.js';

const db = createDb(env.TEST_DATABASE_URL);
let userId = '';

async function expectCenteredPageLoader(page: Page) {
  const indicator = page.getByTestId('page-loading-indicator');
  await expect(indicator).toBeVisible();
  const geometry = await indicator.evaluate((element) => {
    const frame = element.closest('[data-page-frame]');
    if (!frame) throw new Error('Expected a page frame');
    const bounds = frame.getBoundingClientRect();
    const style = getComputedStyle(frame);
    const left = Number.parseFloat(style.paddingLeft);
    const right = Number.parseFloat(style.paddingRight);
    const top = Number.parseFloat(style.paddingTop);
    const bottom = Number.parseFloat(style.paddingBottom);
    const spinner = element.getBoundingClientRect();
    return {
      x: spinner.x + spinner.width / 2,
      y: spinner.y + spinner.height / 2,
      centerX: bounds.x + left + (bounds.width - left - right) / 2,
      centerY: bounds.y + top + (bounds.height - top - bottom) / 2,
      bottom: bounds.bottom,
      viewport: window.innerHeight,
    };
  });
  expect(Math.abs(geometry.x - geometry.centerX)).toBeLessThan(1);
  expect(Math.abs(geometry.y - geometry.centerY)).toBeLessThan(1);
  expect(geometry.bottom).toBeGreaterThanOrEqual(geometry.viewport - 1);
}

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
  await expect(wordmark.locator('svg')).toBeVisible();
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
  await expectCenteredPageLoader(page);
  await expect(shell).toBeHidden();
});

test('settings edits stay accessible and the save spinner keeps its geometry', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/settings');
  for (const day of ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']) {
    await page.getByLabel(`${day} study goal`, { exact: true }).fill('90');
  }
  await expect(page.getByRole('spinbutton')).toHaveCount(7);
  await expect(page.getByLabel('Learning start date')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Log out of all devices' })).toHaveCount(0);
  await page.getByLabel('Tuesday study goal', { exact: true }).fill('60');
  await page.getByLabel('Saturday study goal', { exact: true }).fill('120');
  await page.getByLabel('Sunday study goal', { exact: true }).fill('90');
  await expect(page.getByText('10.5 hours / week')).toBeVisible();
  let releaseSave: () => void = () => {};
  const waiting = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  await page.route('**/api/settings', async (route) => {
    if (route.request().method() === 'PUT') await waiting;
    await route.continue();
  });
  const save = page.getByRole('button', { name: 'Save goal' });
  await save.scrollIntoViewIfNeeded();
  const before = await save.boundingBox();
  await save.click();
  try {
    await expect(save).toHaveAttribute('aria-busy', 'true');
    await expect(page.getByLabel('Monday study goal', { exact: true })).toBeDisabled();
    await page.screenshot({ path: 'test-results/settings-goal-saving.png', fullPage: true });
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
  expect(await (await page.request.get('/api/today')).json()).toMatchObject({ budgetMinutes: 90 });
  await page.getByRole('link', { name: 'Home', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Next up', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page.getByLabel('Monday study goal', { exact: true })).toHaveValue('90');
  await expect(page.getByLabel('Saturday study goal', { exact: true })).toHaveValue('120');
  await expect(page.getByLabel('Sunday study goal', { exact: true })).toHaveValue('90');
  await page.reload();
  await expect(page.getByLabel('Tuesday study goal', { exact: true })).toHaveValue('60');
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({ path: `test-results/settings-goal-${width}.png`, fullPage: true });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  }
  await expect(page.getByLabel('Monday study goal', { exact: true })).toHaveValue('90');
  await expect(page.getByLabel('Saturday study goal', { exact: true })).toHaveValue('120');
  await expect(page.getByLabel('Sunday study goal', { exact: true })).toHaveValue('90');
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
    await expectCenteredPageLoader(page);
    await page.screenshot({ path: '/tmp/academy-loading-desktop.png' });
  } finally {
    release();
  }
  await expect(page.locator('[data-page-frame] [data-slot="card"]').first()).toBeVisible();
});

test('first-visit loaders stay centered on mobile during auth and page loading', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let releaseAuth: () => void = () => {};
  let releasePage: () => void = () => {};
  const authGate = new Promise<void>((resolve) => {
    releaseAuth = resolve;
  });
  const pageGate = new Promise<void>((resolve) => {
    releasePage = resolve;
  });
  await page.route('**/api/auth/me', async (route) => {
    await authGate;
    await route.continue();
  });
  await page.route('**/api/course', async (route) => {
    await pageGate;
    await route.continue();
  });
  await page.goto('/settings');
  let navigation: Promise<void> | undefined;
  try {
    await expect(page.getByTestId('app-shell-skeleton')).toBeVisible();
    await expectCenteredPageLoader(page);
    releaseAuth();
    await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
    await page.getByRole('button', { name: 'Save goal' }).waitFor();
    navigation = page.getByRole('link', { name: 'Course', exact: true }).click();
    await expectCenteredPageLoader(page);
    await page.screenshot({ path: '/tmp/academy-loading-mobile.png' });
  } finally {
    releaseAuth();
    releasePage();
  }
  await navigation;
  await expect(page.getByRole('heading', { name: /Unit 1/ })).toBeVisible();
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

test('resuming shows the current question without loading later lessons or the final exercise', async ({
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
  await db.insert(sessionActivities).values({
    sessionId: session.id,
    idx: 99,
    kind: 'learn',
    conceptId: 'vectors',
    exerciseIds: [],
    plannedMinutes: 10,
    status: 'planned',
  });
  const requests: string[] = [];
  page.on('request', (request) => requests.push(new URL(request.url()).pathname));
  await page.route('**/api/lessons/vectors*', (route) => route.abort());
  await page.goto(`/session/${session.id}`);
  await expect(page.getByTestId('lesson-problem')).toBeVisible();
  expect(requests.filter((path) => path.startsWith('/api/lessons/vectors'))).toEqual([]);
  expect(requests.filter((path) => path.startsWith('/api/exercises/'))).toEqual([]);
});

test('full lessons and Back to session use one document and one review request', async ({
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
  await page.goto(`/session/${session.id}`);
  await expect(page.getByTestId('lesson-problem')).toBeVisible();
  const startedAt = await page.evaluate(() => performance.timeOrigin);
  const requests: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/api/lessons/') || path.startsWith('/api/exercises/')) requests.push(path);
  });
  await page.getByRole('link', { name: 'View full lesson' }).click();
  await expect(
    page.getByRole('heading', { name: 'Supervised learning', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Show answer' })).toBeVisible();
  expect(requests).toEqual(['/api/lessons/supervised-learning/review']);
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(startedAt);
  await page.getByRole('link', { name: 'Back to session' }).click();
  await expect(page.getByTestId('lesson-problem')).toBeVisible();
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(startedAt);
});

test('Home and tutor availability avoid building a second learning plan', async ({ page }) => {
  let todayRequests = 0;
  let statusRequests = 0;
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/today') todayRequests += 1;
    if (new URL(request.url()).pathname === '/api/tutor/status') statusRequests += 1;
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Next up' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open tutor' })).toBeVisible();
  expect(todayRequests).toBe(0);
  expect(statusRequests).toBe(1);
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
  await expect(page.getByRole('button', { name: 'Save goal' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open tutor' })).toBeVisible();
  expect(markdownRequests).toEqual([]);
  await page.getByRole('link', { name: 'Course', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Unit 1 · ML fundamentals' })).toBeVisible();
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

for (const failure of ['save response', 'save network', 'Home refresh'] as const) {
  test(`finishing a session reports a failed ${failure} and can retry`, async ({ page }) => {
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
    await expect(
      page.getByRole('heading', { name: 'Session complete', exact: true }),
    ).toBeVisible();
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    const failedPath =
      failure === 'Home refresh' ? '**/api/learn' : `**/api/sessions/${session.id}/end`;
    await page.route(failedPath, (route) =>
      failure === 'save network'
        ? route.abort('failed')
        : route.fulfill({ status: 503, json: { error: 'Temporarily unavailable' } }),
    );
    const finish = page.getByRole('button', { name: 'Finish session', exact: true });
    await finish.click();
    await expect(page.getByRole('alert')).toContainText('Please try again.', { timeout: 15_000 });
    await expect(page).toHaveURL(`/session/${session.id}`);
    await expect(finish).toBeEnabled();
    expect(pageErrors).toEqual([]);
    if (failure === 'save response') {
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 844 });
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        ).toBe(true);
        await page.screenshot({ path: `test-results/session-finish-error-${width}.png` });
      }
    }
    await page.unroute(failedPath);
    await finish.click();
    await expect(page.getByRole('heading', { name: 'Next up', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Resume session', exact: true })).toHaveCount(0);
  });
}

test('Course still renders formatted metadata when it needs Markdown and math', async ({
  page,
}) => {
  await page.route('**/api/course', async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    data.units[0].papers[0].title = '$x^2$';
    data.units[0].project.title = '**Linear model**';
    await route.fulfill({ response, json: data });
  });
  await page.goto('/course');
  await expect(page.locator('.katex').first()).toBeVisible();
  await expect(page.locator('strong').filter({ hasText: 'Linear model' })).toBeVisible();
});

test('study goal save failures keep the draft available to retry', async ({ page }) => {
  await page.goto('/settings');
  await page.getByLabel('Wednesday study goal').fill('35');
  await page.route('**/api/settings', async (route) => {
    if (route.request().method() === 'PUT') {
      await route.fulfill({ status: 503, json: { error: 'Unavailable' } });
    } else {
      await route.continue();
    }
  });
  await page.getByRole('button', { name: 'Save goal' }).click();
  await expect(page.getByRole('alert')).toContainText('Settings could not be saved.');
  await expect(page.getByLabel('Wednesday study goal')).toHaveValue('35');
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({
      path: `test-results/settings-goal-error-${width}.png`,
      fullPage: true,
    });
  }
  await page.unroute('**/api/settings');
  await page.getByRole('button', { name: 'Save goal' }).click();
  await expect(page.getByRole('status')).toContainText('Saved');
  await page.reload();
  await expect(page.getByLabel('Wednesday study goal')).toHaveValue('35');
});
