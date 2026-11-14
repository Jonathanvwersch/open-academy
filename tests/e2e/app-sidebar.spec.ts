import { mkdirSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { and, eq } from 'drizzle-orm';
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
  const navigation = page.getByRole('navigation', { name: 'Main navigation' });
  const header = navigation.locator('[data-sidebar="header"]');
  const footer = navigation.locator('[data-sidebar="footer"]');
  await expect(header.getByRole('button', { name: 'Collapse navigation' })).toBeVisible();
  await expect(
    footer.getByRole('button', { name: /Collapse navigation|Expand navigation/ }),
  ).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Open Fixture course' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open Fixture switching course' })).toBeVisible();
  const navRows = ['Home', 'Courses', 'Reviews', 'Progress'].map((name) =>
    navigation.getByRole('link', { name, exact: true }),
  );
  const navBoxes = await Promise.all(navRows.map((row) => row.boundingBox()));
  for (let index = 1; index < navBoxes.length; index += 1) {
    const previous = navBoxes[index - 1];
    const next = navBoxes[index];
    expect(previous).not.toBeNull();
    expect(next).not.toBeNull();
    expect((next?.y ?? 0) - ((previous?.y ?? 0) + (previous?.height ?? 0))).toBeGreaterThanOrEqual(
      4,
    );
  }
  await page.getByRole('link', { name: 'Open Fixture switching course' }).hover();
  await page.screenshot({
    path: 'test-results/sidebar-home-expanded.png',
    animations: 'disabled',
  });
  await header.getByRole('button', { name: 'Collapse navigation' }).click();
  await expect(header.getByRole('button', { name: 'Expand navigation' })).toBeVisible();
  await expect(header.getByRole('link', { name: 'Open Academy home' })).toHaveCount(0);
  await page.screenshot({
    path: 'test-results/sidebar-home-collapsed.png',
    animations: 'disabled',
  });
  await page.reload();
  await expect(header.getByRole('button', { name: 'Expand navigation' })).toBeVisible();
  await header.getByRole('button', { name: 'Expand navigation' }).click();
  await expect(header.getByRole('button', { name: 'Collapse navigation' })).toBeVisible();
  await page.reload();
  await expect(header.getByRole('button', { name: 'Collapse navigation' })).toBeVisible();
});

test('mobile sidebar closes after navigating to Reviews', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Open navigation' }).click();
  const navigation = page.getByRole('navigation', { name: 'Main navigation' });
  await expect(navigation).toBeVisible();
  expect((await navigation.boundingBox())?.width).toBeCloseTo(288, 1);
  await expect(
    navigation
      .locator('[data-sidebar="header"]')
      .getByRole('button', { name: /Collapse navigation|Expand navigation/ }),
  ).toHaveCount(0);
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

test('My courses links open course details directly', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.getByRole('link', { name: 'Open Fixture switching course' }).click();
  await expect(page).toHaveURL('/courses/fixture-switching-course');
  await expect(
    page.getByRole('heading', { name: 'Fixture switching course', exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: 'test-results/sidebar-course.png', animations: 'disabled' });
});

test('course catalogue links every course and legacy course URLs redirect', async ({ page }) => {
  await page.goto('/courses');
  const catalogue = page.getByRole('main');
  await expect(catalogue.getByRole('link', { name: /Fixture course/ })).toBeVisible();
  await expect(catalogue.getByRole('link', { name: /Fixture switching course/ })).toBeVisible();
  await expect(catalogue.getByRole('link', { name: /Fixture third course/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Fixture subject' })).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.goto('/course');
  await expect(page).toHaveURL('/courses');
  await page.goto('/course?course=fixture-switching-course');
  await expect(page).toHaveURL('/courses/fixture-switching-course');
});

test('modified course-row clicks open the course in a new tab without changing enrollment', async ({
  page,
  context,
}) => {
  let switchRequests = 0;
  await page.route('**/api/course/active', async (route) => {
    switchRequests += 1;
    await route.continue();
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  const currentUrl = page.url();
  const newPagePromise = context.waitForEvent('page');
  await page.getByRole('link', { name: 'Open Fixture switching course' }).click({
    modifiers: ['Control'],
  });
  const newPage = await newPagePromise;
  await expect(newPage).toHaveURL('/courses/fixture-switching-course');
  expect(page.url()).toBe(currentUrl);
  expect(switchRequests).toBe(0);
  await newPage.close();
});

test('Home schedules learn activities from both active courses', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Vectors', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Switching topic', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'View course' })).toHaveCount(2);
});

test('adding a course from the beginning adds it to My courses', async ({ page }) => {
  await db
    .delete(courseEnrollments)
    .where(
      and(
        eq(courseEnrollments.userId, userId),
        eq(courseEnrollments.courseId, 'fixture-switching-course'),
      ),
    );
  await page.goto('/courses/fixture-switching-course');
  await page.getByRole('button', { name: 'Add to my courses' }).click();
  await page.getByRole('button', { name: "I'm new to this — start from the beginning" }).click();
  await expect(
    page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', {
      name: /Fixture switching course/,
    }),
  ).toBeVisible();
});

test('removing a course keeps its due reviews and Undo restores it', async ({ page }) => {
  await db.insert(reviewCards).values({
    userId,
    conceptId: 'switching-topic',
    dimension: 'conceptual',
    fsrs: newReviewCard(new Date('2026-01-01T12:00:00.000Z')),
    dueAt: new Date('2026-01-01T00:00:00.000Z'),
    reps: 0,
    lapses: 0,
  });
  await page.goto('/courses/fixture-switching-course');
  await page.getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByRole('link', { name: 'Open Fixture switching course' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(
    page.getByRole('link', { name: /Fixture switching course.*topics done/ }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByRole('link', { name: 'Open Fixture switching course' })).toHaveCount(0);
  await page.goto('/reviews');
  await expect(page.getByText('Switching topic', { exact: true })).toBeVisible();
});

test('captures multi-course desktop and mobile screenshots', async ({ page }) => {
  const screenshots = '/home/ubuntu/shots/study-set';
  mkdirSync(screenshots, { recursive: true });
  for (const viewport of [
    { width: 1440, height: 900, suffix: 'desktop' },
    { width: 390, height: 844, suffix: 'mobile' },
  ]) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Next up', exact: true })).toBeVisible();
    await page.screenshot({
      path: `${screenshots}/home-two-courses-${viewport.suffix}.png`,
      animations: 'disabled',
    });

    await page.goto('/courses');
    await expect(page.getByRole('heading', { name: 'Fixture course', exact: true })).toBeVisible();
    await page.screenshot({
      path: `${screenshots}/catalogue-${viewport.suffix}.png`,
      animations: 'disabled',
    });
    await page.goto('/courses/fixture-course');
    await expect(page.getByRole('heading', { name: 'Fixture course', exact: true })).toBeVisible();
    await page.screenshot({
      path: `${screenshots}/active-detail-${viewport.suffix}.png`,
      animations: 'disabled',
    });
    await page.goto('/courses/fixture-third-course');
    await expect(
      page.getByRole('heading', { name: 'Fixture third course', exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: `${screenshots}/not-started-detail-${viewport.suffix}.png`,
      animations: 'disabled',
    });
    await db.insert(courseEnrollments).values({
      userId,
      courseId: 'fixture-third-course',
      status: 'active',
      startMethod: 'beginning',
    });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Next up', exact: true })).toBeVisible();
    if (viewport.suffix === 'mobile') {
      await page.getByRole('button', { name: 'Open navigation' }).click();
    }
    await expect(
      page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', {
        name: /Fixture third course/,
      }),
    ).toBeVisible();
    await page.screenshot({
      path: `${screenshots}/sidebar-three-courses-${viewport.suffix}.png`,
      animations: 'disabled',
    });
    await db
      .delete(courseEnrollments)
      .where(
        and(
          eq(courseEnrollments.userId, userId),
          eq(courseEnrollments.courseId, 'fixture-third-course'),
        ),
      );
  }
});

test('placement starts for the course selected in the course URL', async ({ page }) => {
  await db
    .delete(courseEnrollments)
    .where(
      and(
        eq(courseEnrollments.userId, userId),
        eq(courseEnrollments.courseId, 'fixture-switching-course'),
      ),
    );
  await page.goto('/courses/fixture-switching-course');
  await expect(page.getByRole('heading', { name: 'Start Fixture switching course' })).toBeVisible();

  const placementStart = page.waitForRequest(
    (request) => request.url().endsWith('/api/placement') && request.method() === 'POST',
  );
  await page.getByRole('link', { name: 'Take the placement check' }).click();
  const request = await placementStart;
  expect(JSON.parse(request.postData() ?? '{}')).toEqual({
    courseId: 'fixture-switching-course',
  });
  await expect(page.getByRole('heading', { name: /Placement check ·/ })).toBeVisible();
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
