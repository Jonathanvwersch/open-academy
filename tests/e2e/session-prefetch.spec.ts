import { expect, type Page, test } from '@playwright/test';
import { env } from '../../apps/api/src/config.js';
import { createDb } from '../../apps/api/src/db/client.js';
import { sessionActivities, studySessions, users } from '../../apps/api/src/db/schema.js';

const db = createDb(env.TEST_DATABASE_URL);
const nextIds = ['derivatives-fixture-1-basics', 'derivatives-fixture-2-basics'];
let sessionId = '';

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
      displayName: 'Session prefetch learner',
      timezone: 'UTC',
      startDate: '2026-01-01',
      prefs: { scheduleMinutes: 60 },
    })
    .returning();
  if (!user) throw new Error('Missing learner');
  const [session] = await db
    .insert(studySessions)
    .values({
      userId: user.id,
      kind: 'weekday',
      plannedMinutes: 30,
      status: 'active',
      startedAt: new Date('2026-01-01T12:00:00.000Z'),
    })
    .returning();
  if (!session) throw new Error('Missing session');
  sessionId = session.id;
  await db.insert(sessionActivities).values([
    {
      sessionId,
      idx: 0,
      kind: 'review',
      conceptId: 'supervised-learning',
      exerciseIds: ['sl-inputs-targets-basics', 'sl-measuring-error-basics'],
      plannedMinutes: 10,
      status: 'in_progress',
    },
    {
      sessionId,
      idx: 1,
      kind: 'review',
      conceptId: 'derivatives',
      exerciseIds: nextIds,
      plannedMinutes: 10,
      status: 'planned',
    },
  ]);
});

test.afterAll(async () => {
  await db.$client.end();
});

async function answer(page: Page) {
  await page.getByRole('radio').first().click();
  await page.getByRole('button', { name: 'Submit answer', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeVisible();
}

async function finishFirstTopic(page: Page) {
  await answer(page);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Submit answer', exact: true })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  const unanswered = await page
    .getByTestId('session-exercise')
    .locator('[data-slot="card-content"]')
    .boundingBox();
  await answer(page);
  return unanswered?.height;
}

async function observeTransition(page: Page) {
  await page.evaluate(() => {
    const state = { skeleton: false };
    Object.assign(window, { transitionState: state });
    new MutationObserver(() => {
      if (document.querySelector('[data-testid="route-skeleton"]')) state.skeleton = true;
    }).observe(document.body, { childList: true, subtree: true });
  });
}

test('prefetches the next review topic before continuing and keeps the page mounted', async ({
  page,
}) => {
  const requests: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'GET' && request.url().includes('/api/exercises/')) {
      requests.push(new URL(request.url()).pathname.split('/').at(-1) ?? '');
    }
  });
  await page.goto(`/session/${sessionId}`);
  await finishFirstTopic(page);
  await expect.poll(() => nextIds.every((id) => requests.includes(id))).toBe(true);
  await observeTransition(page);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Derivatives', exact: true })).toBeVisible();
  await expect(page.getByTestId('session-exercise')).toBeVisible();
  expect(await page.evaluate(() => Reflect.get(window, 'transitionState').skeleton)).toBe(false);
  for (const id of nextIds) expect(requests.filter((request) => request === id)).toHaveLength(1);
});

for (const viewport of [
  { width: 1440, height: 900, name: 'desktop' },
  { width: 390, height: 844, name: 'mobile' },
  { width: 390, height: 844, name: 'mobile with larger text' },
]) {
  test(`a delayed next question loads only its card at ${viewport.name}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    if (viewport.name === 'mobile with larger text') {
      await page.addInitScript(() => {
        document.addEventListener('DOMContentLoaded', () => {
          document.documentElement.style.fontSize = '20px';
        });
      });
    }
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(`**/api/exercises/${nextIds[0]}`, async (route) => {
      await gate;
      await new Promise((resolve) => setTimeout(resolve, 2000));
      await route.fallback();
    });
    await page.goto(`/session/${sessionId}`);
    const previousQuestionHeight = await finishFirstTopic(page);
    await observeTransition(page);
    release();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Derivatives', exact: true })).toBeVisible();
    await expect(page.getByTestId('question-loading')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Review', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'View full lesson' })).toBeVisible();
    await expect(
      page.getByTestId('question-loading').getByTestId('question-progress'),
    ).toBeVisible();
    const loadingBox = await page.getByTestId('question-loading').boundingBox();
    await page.screenshot({ path: testInfo.outputPath('delayed-question.png') });
    await expect(page.getByTestId('session-exercise')).toBeVisible();
    const loadedBox = await page.getByTestId('session-exercise').boundingBox();
    console.log(
      `Question card heights (${viewport.name}): loading=${loadingBox?.height}, loaded=${loadedBox?.height}`,
    );
    expect(loadingBox).not.toBeNull();
    expect(loadedBox).not.toBeNull();
    expect(previousQuestionHeight).toBeDefined();
    expect(Math.abs((loadingBox?.height ?? 0) - (previousQuestionHeight ?? 0))).toBeLessThanOrEqual(
      1,
    );
    expect(Math.abs((loadingBox?.height ?? 0) - (loadedBox?.height ?? 0))).toBeLessThanOrEqual(24);
    expect(await page.evaluate(() => Reflect.get(window, 'transitionState').skeleton)).toBe(false);
  });
}
