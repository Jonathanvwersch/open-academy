import { expect, test } from '@playwright/test';
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
      displayName: 'Sidebar E2E learner',
      timezone: 'UTC',
      startDate: '2026-01-01',
      prefs: { scheduleMinutes: 60 },
    })
    .returning();
  if (!user) throw new Error('Could not create sidebar E2E learner');
  userId = user.id;
  await enrollInDefaultCourse(db, userId);
  await db.insert(courseEnrollments).values({
    userId,
    courseId: 'fixture-switching-course',
    status: 'active',
    startMethod: 'beginning',
  });
});

test.afterAll(async () => {
  await db.$client.end();
});

test('desktop sidebar collapse persists across reload', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Next up', exact: true })).toBeVisible();
  await expect(
    page.getByRole('link', { name: /Fixture course.*0 of 9 topics done/ }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Switch to Fixture switching course' }),
  ).toBeVisible();
  await page.screenshot({
    path: 'test-results/sidebar-home-expanded.png',
    animations: 'disabled',
  });
  await page.getByRole('button', { name: 'Collapse navigation' }).click();
  await expect(page.getByRole('button', { name: 'Expand navigation' })).toBeVisible();
  await page.screenshot({
    path: 'test-results/sidebar-home-collapsed.png',
    animations: 'disabled',
  });
  await page.reload();
  await expect(page.getByRole('button', { name: 'Expand navigation' })).toBeVisible();
  await page.getByRole('button', { name: 'Expand navigation' }).click();
  await expect(page.getByRole('button', { name: 'Collapse navigation' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Collapse navigation' })).toBeVisible();
});

test('mobile sidebar closes after navigating to Reviews', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Open navigation' }).click();
  const navigation = page.getByRole('navigation', { name: 'Main navigation' });
  await expect(navigation).toBeVisible();
  expect((await navigation.boundingBox())?.width).toBeCloseTo(288, 1);
  await expect(navigation.locator('[data-active="true"]')).toHaveCount(0);
  await expect(navigation.getByRole('link', { name: 'Open Academy home' })).not.toHaveAttribute(
    'data-sidebar',
    'menu-button',
  );
  const navigationWidth = await navigation.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(navigationWidth.scrollWidth).toBeLessThanOrEqual(navigationWidth.clientWidth);
  await page.screenshot({
    path: 'test-results/sidebar-mobile-open.png',
    animations: 'disabled',
  });
  await navigation.getByRole('link', { name: 'Reviews', exact: true }).click();
  await expect(page).toHaveURL(/\/reviews$/);
  await expect(page.getByRole('heading', { name: 'Reviews' })).toBeVisible();
  await expect(navigation).toBeHidden();
  await page.screenshot({
    path: 'test-results/sidebar-mobile-closed.png',
    animations: 'disabled',
  });
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Open navigation' }).click();
  const narrowNavigation = page.getByRole('navigation', { name: 'Main navigation' });
  const narrowWidth = await narrowNavigation.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(narrowWidth.scrollWidth).toBeLessThanOrEqual(narrowWidth.clientWidth);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
});

test('switching a My courses entry opens that course', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Switch to Fixture switching course' }).click();
  await expect(
    page.getByRole('heading', { name: 'Fixture switching course', exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: 'test-results/sidebar-course.png', animations: 'disabled' });
});

test('Reviews badge and Start reviews work from the sidebar', async ({ page }) => {
  await db.insert(reviewCards).values({
    userId,
    conceptId: 'supervised-learning',
    dimension: 'conceptual',
    fsrs: newReviewCard(new Date('2026-01-01T12:00:00.000Z')),
    dueAt: new Date('2026-01-01T00:00:00.000Z'),
    reps: 0,
    lapses: 0,
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(page.getByTestId('reviews-due-count')).toHaveText('1');
  await page.getByRole('link', { name: 'Reviews', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Start reviews' })).toBeVisible();
  await page.screenshot({
    path: 'test-results/sidebar-reviews-badge.png',
    animations: 'disabled',
  });
  await page.getByRole('button', { name: 'Start reviews' }).click();
  await expect(page).toHaveURL(/\/session\//);
});

test('Reviews badge clears when a review is completed in an active session', async ({ page }) => {
  await db.insert(reviewCards).values({
    userId,
    conceptId: 'supervised-learning',
    dimension: 'math',
    fsrs: newReviewCard(new Date('2026-01-01T12:00:00.000Z')),
    dueAt: new Date('2026-01-01T00:00:00.000Z'),
    reps: 0,
    lapses: 0,
  });
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
  if (!session) throw new Error('Could not create active review session');
  await db.insert(sessionActivities).values({
    sessionId: session.id,
    idx: 0,
    kind: 'review',
    conceptId: 'supervised-learning',
    exerciseIds: ['supervised-learning-fixture-review'],
    plannedMinutes: 5,
    status: 'in_progress',
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(page.getByTestId('reviews-due-count')).toHaveText('1');
  await page.getByRole('link', { name: 'Reviews', exact: true }).click();
  const continueReviews = page.getByRole('link', { name: 'Continue reviews' });
  await expect(continueReviews).toHaveAttribute('href', `/session/${session.id}`);
  await continueReviews.click();
  await expect(page.getByTestId('session-exercise')).toBeVisible();
  await page.getByLabel('Your answer').fill('4');
  await page.getByRole('button', { name: 'Submit answer' }).click();
  await expect(page.getByTestId('reviews-due-count')).toHaveCount(0);
});

test('tutor opens without moving the app navigation', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/lessons/supervised-learning');
  await expect(page.getByRole('heading', { name: 'Supervised learning' })).toBeVisible();
  const navigation = page.getByRole('navigation', { name: 'Main navigation' });
  const before = await navigation.boundingBox();
  await page.getByRole('button', { name: 'Open tutor' }).click();
  await expect(page.getByRole('complementary', { name: 'Tutor' })).toBeVisible();
  await page.screenshot({ path: 'test-results/sidebar-tutor-open.png', animations: 'disabled' });
  const after = await navigation.boundingBox();
  expect(after?.x).toBe(before?.x);
  expect(after?.width).toBe(before?.width);
});
