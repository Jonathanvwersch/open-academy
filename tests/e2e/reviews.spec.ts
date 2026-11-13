import { mkdirSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { env } from '../../apps/api/src/config.js';
import { createDb } from '../../apps/api/src/db/client.js';
import {
  diagnosticRuns,
  reviewCards,
  sessionActivities,
  studySessions,
  users,
} from '../../apps/api/src/db/schema.js';
import { newReviewCard } from '../../apps/api/src/learning/fsrs.js';

const db = createDb(env.TEST_DATABASE_URL);
const screenshotDir = 'test-results/screenshots/screenshots/spaced-review';
mkdirSync(screenshotDir, { recursive: true });
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
      displayName: 'Spaced review E2E learner',
      timezone: 'UTC',
      startDate: '2026-01-01',
      prefs: { scheduleMinutes: 60 },
    })
    .returning();
  if (!user) throw new Error('Could not create spaced review learner');
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

async function insertReviewCards() {
  for (const card of [
    { dimension: 'conceptual', dueAt: '2026-01-01T00:00:00.000Z', reps: 0, lapses: 0 },
    { dimension: 'implementation', dueAt: '2026-01-01T20:00:00.000Z', reps: 1, lapses: 0 },
    { dimension: 'math', dueAt: '2026-01-03T12:00:00.000Z', reps: 2, lapses: 1 },
    { dimension: 'transfer', dueAt: '2026-01-04T12:00:00.000Z', reps: 1, lapses: 0 },
  ]) {
    const fsrs = newReviewCard(new Date('2026-01-01T12:00:00.000Z'));
    await db.insert(reviewCards).values({
      userId,
      conceptId: 'supervised-learning',
      dimension: card.dimension,
      fsrs,
      dueAt: new Date(card.dueAt),
      reps: card.reps,
      lapses: card.lapses,
    });
  }
}

test('Reviews page shows due and upcoming topics at desktop and mobile widths', async ({
  page,
}) => {
  await insertReviewCards();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/reviews');
  await expect(page.getByRole('heading', { name: 'Reviews' })).toBeVisible();
  await expect(page.getByText('1 due now')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Topics' })).toBeVisible();
  await expect(page.getByText('Supervised learning').first()).toBeVisible();
  await expect(page.getByText(/Due now ·/)).toBeVisible();
  await expect(page.getByText('Due later today')).toBeVisible();
  await expect(page.getByText('Due in 2 days')).toBeVisible();
  await expect(page.getByText('Transfer')).toBeVisible();
  await expect(page.getByText('Not reviewed yet')).toBeVisible();
  await expect(page.getByText(/Reviewed once/).first()).toBeVisible();
  await expect(page.getByText('Due reviews come up in your next session.')).toBeVisible();
  await page.screenshot({ path: `${screenshotDir}/reviews-desktop.png`, fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: `${screenshotDir}/reviews-mobile.png`, fullPage: true });
});

test('review session header shows its label without an activity count', async ({ page }) => {
  const [session] = await db
    .insert(studySessions)
    .values({
      userId,
      kind: 'weekday',
      plannedMinutes: 10,
      startedAt: new Date('2026-01-01T12:00:00.000Z'),
      status: 'active',
    })
    .returning();
  if (!session) throw new Error('Could not create review session');
  await db.insert(sessionActivities).values({
    sessionId: session.id,
    idx: 0,
    kind: 'review',
    conceptId: 'supervised-learning',
    exerciseIds: ['sl-explain-setup'],
    plannedMinutes: 5,
    status: 'in_progress',
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/session/${session.id}`);
  await expect(page.getByRole('heading', { name: 'Supervised learning' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Review' })).toBeVisible();
  await expect(page.getByText(/Activity \d+ of \d+ today/)).toHaveCount(0);
  await page.screenshot({
    path: `${screenshotDir}/review-session-header-desktop.png`,
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: `${screenshotDir}/review-session-header-mobile.png`,
    fullPage: true,
  });
});
