import { mkdirSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { eq } from 'drizzle-orm';
import { env } from '../../apps/api/src/config.js';
import { createDb } from '../../apps/api/src/db/client.js';
import {
  courseEnrollments,
  reviewCards,
  sessionActivities,
  studySessions,
  users,
} from '../../apps/api/src/db/schema.js';
import { newReviewCard } from '../../apps/api/src/learning/fsrs.js';
import { enrollInDefaultCourse } from './course-start.js';

const db = createDb(env.TEST_DATABASE_URL);
const screenshotDir = '/home/ubuntu/shots/reviews';
const sessionScreenshotDir = 'test-results/screenshots/screenshots/spaced-review';
mkdirSync(screenshotDir, { recursive: true });
mkdirSync(sessionScreenshotDir, { recursive: true });
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
  await enrollInDefaultCourse(db, userId);
  await db.insert(courseEnrollments).values({
    userId,
    courseId: 'fixture-switching-course',
    status: 'active',
    startMethod: 'beginning',
  });
  await db
    .update(users)
    .set({ activeCourseId: 'fixture-switching-course' })
    .where(eq(users.id, userId));
});

test.afterAll(async () => {
  await db.$client.end();
});

async function insertReviewCards() {
  for (const card of [
    {
      conceptId: 'supervised-learning',
      dimension: 'conceptual',
      dueAt: '2026-01-01T00:00:00.000Z',
      reps: 0,
      lapses: 0,
    },
    {
      conceptId: 'supervised-learning',
      dimension: 'math',
      dueAt: '2026-01-01T20:00:00.000Z',
      reps: 1,
      lapses: 0,
    },
    {
      conceptId: 'vectors',
      dimension: 'math',
      dueAt: '2026-01-03T12:00:00.000Z',
      reps: 2,
      lapses: 1,
    },
    {
      conceptId: 'linear-models',
      dimension: 'transfer',
      dueAt: '2026-01-04T12:00:00.000Z',
      reps: 1,
      lapses: 0,
    },
    {
      conceptId: 'loss-functions',
      dimension: 'conceptual',
      dueAt: '2026-01-20T12:00:00.000Z',
      reps: 1,
      lapses: 0,
    },
  ]) {
    const fsrs = newReviewCard(new Date('2026-01-01T12:00:00.000Z'));
    await db.insert(reviewCards).values({
      userId,
      conceptId: card.conceptId,
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
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/reviews');
  await expect(page.getByRole('heading', { name: 'Reviews' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Due now · 1' })).toBeVisible();
  await expect(page.getByText('Supervised learning').first()).toBeVisible();
  await expect(page.getByText('Concept', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Maths', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: /Later · 1/ })).toBeVisible();
  await expect(page.getByText(/recall|reviewed/i)).toHaveCount(0);
  const dayStrip = page.getByRole('group', {
    name: 'Upcoming reviews for the next seven days',
  });
  await expect(dayStrip.getByRole('button', { name: /Fri.*0/ })).toBeDisabled();
  await expect(page.locator('#reviews-2026-01-03').getByRole('button')).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  await page.screenshot({ path: `${screenshotDir}/reviews-default-desktop.png` });

  const sunday = dayStrip.getByRole('button', { name: /Sun.*1/ });
  await sunday.click();
  await expect(page.getByText('Apply it', { exact: true })).toBeVisible();
  await page.goto('/reviews');
  const saturday = dayStrip.getByRole('button', { name: /Sat.*1/ });
  await saturday.click();
  await expect(saturday).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#reviews-2026-01-03')).toBeInViewport();
  await expect(page.getByRole('heading', { name: /Fixture course/ }).first()).toBeVisible();
  await page.goto('/reviews');
  await page
    .getByRole('group', { name: 'Upcoming reviews for the next seven days' })
    .getByRole('button', { name: /Sun.*1/ })
    .click();
  await expect(
    page.getByRole('heading', { name: /Fixture switching course/ }).first(),
  ).toBeVisible();
  await page.screenshot({ path: `${screenshotDir}/reviews-day-open-desktop.png` });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/reviews');
  await expect(page.getByRole('heading', { name: 'Due now · 1' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: `${screenshotDir}/reviews-default-mobile.png` });
  await page
    .getByRole('group', { name: 'Upcoming reviews for the next seven days' })
    .getByRole('button', { name: /Sat.*1/ })
    .click();
  await page.screenshot({ path: `${screenshotDir}/reviews-day-open-mobile.png` });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Home' })).toBeAttached();
  await page.screenshot({ path: `${screenshotDir}/home-desktop.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${screenshotDir}/home-mobile.png` });

  for (const viewport of [
    { width: 1440, height: 900, name: 'desktop' },
    { width: 390, height: 844, name: 'mobile' },
  ]) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto('/course');
    await expect(page.getByRole('heading', { name: 'Fixture switching course' })).toBeVisible();
    await page.waitForTimeout(200);
    await page.goto('/reviews');
    let release!: () => void;
    const delayed = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/api/course', async (route) => {
      await delayed;
      await route.continue();
    });
    const courseNavigation = page.goto('/course', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('route-skeleton')).toBeVisible();
    await page.screenshot({
      path: `${screenshotDir}/course-loading-skeleton-${viewport.name}.png`,
    });
    release();
    await courseNavigation;
    await page.unroute('**/api/course');
  }
});

test('Reviews labels topics due tomorrow as Tomorrow', async ({ page }) => {
  const fsrs = newReviewCard(new Date('2026-01-01T12:00:00.000Z'));
  await db.insert(reviewCards).values({
    userId,
    conceptId: 'derivatives',
    dimension: 'math',
    fsrs,
    dueAt: new Date('2026-01-02T12:00:00.000Z'),
    reps: 0,
    lapses: 0,
  });

  await page.goto('/reviews');

  await expect(page.getByRole('button', { name: 'Tomorrow · 1', exact: true })).toBeVisible();
});

test('Reviews empty state explains how topics return', async ({ page }) => {
  await page.goto('/reviews');
  await expect(page.getByText('No reviews yet. Topics you finish come back here.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start reviews' })).toHaveCount(0);
});

test('Start reviews starts a session and navigates to it', async ({ page }) => {
  await insertReviewCards();
  await page.goto('/reviews');
  await page.getByRole('button', { name: 'Start reviews' }).click();
  await expect(page).toHaveURL(/\/session\/[^/]+$/);
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
    path: `${sessionScreenshotDir}/review-session-header-desktop.png`,
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: `${sessionScreenshotDir}/review-session-header-mobile.png`,
    fullPage: true,
  });
});
