import { mkdirSync } from 'node:fs';
import { expect, type Route, test } from '@playwright/test';
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

async function fulfillCoursesWithLongTitle(route: Route) {
  const response = await route.fetch({
    headers: { ...route.request().headers(), 'x-now': '2026-01-01T12:00:00.000Z' },
  });
  const catalog = (await response.json()) as {
    subjects: Array<{ courses: Array<{ id: string; title: string }> }>;
  };
  const longTitleCourse = catalog.subjects
    .flatMap((subject) => subject.courses)
    .find((course) => course.id === 'fixture-switching-course');
  if (!longTitleCourse) throw new Error('Missing fixture switching course in catalogue');
  longTitleCourse.title = 'Mathematics for Machine Learning';
  await route.fulfill({ response, json: catalog });
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
  const navRows = ['Home', 'Courses', 'Map', 'Reviews', 'Progress'].map((name) =>
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

test('auth-pending shell shows the real sidebar without shifting navigation', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  let releaseAuth: () => void = () => {};
  const authGate = new Promise<void>((resolve) => {
    releaseAuth = resolve;
  });
  let authRequestStarted = false;
  let coursesRequests = 0;
  let reviewsRequests = 0;
  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname === '/api/courses') coursesRequests += 1;
    if (pathname === '/api/reviews') reviewsRequests += 1;
  });
  await page.route('**/api/auth/me', async (route) => {
    authRequestStarted = true;
    await authGate;
    await route.continue({
      headers: { ...route.request().headers(), 'x-now': '2026-01-01T12:00:00.000Z' },
    });
  });

  await page.goto('/');
  const shell = page.getByTestId('app-shell-skeleton');
  try {
    await expect.poll(() => authRequestStarted).toBe(true);
    await expect(shell).toBeVisible();
    const navigation = page.getByRole('navigation', { name: 'Main navigation' });
    for (const label of ['Home', 'Courses', 'Map', 'Reviews', 'Progress']) {
      await expect(navigation.getByRole('link', { name: label, exact: true })).toBeVisible();
      await expect(navigation.getByText(label, { exact: true })).toBeVisible();
    }
    await expect(navigation.getByRole('link', { name: 'Settings', exact: true })).toBeVisible();
    await expect(navigation.getByText('Settings', { exact: true })).toBeVisible();
    await expect(navigation.getByRole('button', { name: 'Collapse navigation' })).toBeVisible();
    await expect(navigation.getByTestId('sidebar-course-skeleton')).toHaveCount(3);
    await expect(navigation.getByTestId('reviews-due-skeleton')).toBeVisible();
    const navMenu = navigation.locator('[data-sidebar="menu"]').first();
    await expect(navMenu.getByTestId('sidebar-course-skeleton')).toHaveCount(0);
    await expect(navMenu.locator('[data-sidebar="menu-skeleton"]')).toHaveCount(0);
    expect(coursesRequests).toBe(0);
    expect(reviewsRequests).toBe(0);

    const linkLabels = ['Home', 'Courses', 'Map', 'Reviews', 'Progress', 'Settings'];
    const pendingBoxes = await Promise.all(
      linkLabels.map((label) =>
        navigation.getByRole('link', { name: label, exact: true }).boundingBox(),
      ),
    );
    mkdirSync(testInfo.outputDir, { recursive: true });
    await page.screenshot({
      path: testInfo.outputPath('root-pending-expanded-1440x900.png'),
      animations: 'disabled',
    });

    await navigation.getByRole('button', { name: 'Collapse navigation' }).click();
    await expect(navigation.getByRole('button', { name: 'Expand navigation' })).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath('root-pending-collapsed-1440x900.png'),
      animations: 'disabled',
    });
    await navigation.getByRole('button', { name: 'Expand navigation' }).click();
    await expect(navigation.getByRole('button', { name: 'Collapse navigation' })).toBeVisible();

    releaseAuth();
    await expect(page.getByRole('heading', { name: 'Next up', exact: true })).toBeVisible();
    await expect.poll(() => coursesRequests > 0 && reviewsRequests > 0).toBe(true);
    await expect(shell).toBeHidden();
    const loadedNavigation = page.getByRole('navigation', { name: 'Main navigation' });
    const loadedBoxes = await Promise.all(
      linkLabels.map((label) =>
        loadedNavigation.getByRole('link', { name: label, exact: true }).boundingBox(),
      ),
    );
    for (let index = 0; index < pendingBoxes.length; index += 1) {
      const pending = pendingBoxes[index];
      const loaded = loadedBoxes[index];
      expect(pending).not.toBeNull();
      expect(loaded).not.toBeNull();
      if (!pending || !loaded) throw new Error('Expected visible navigation link bounds');
      for (const key of ['x', 'y', 'width', 'height'] as const) {
        expect(Math.abs(pending[key] - loaded[key])).toBeLessThanOrEqual(1);
      }
    }
  } finally {
    releaseAuth();
  }
});

test('mobile auth-pending shell uses the real header and navigation', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let releaseAuth: () => void = () => {};
  const authGate = new Promise<void>((resolve) => {
    releaseAuth = resolve;
  });
  await page.route('**/api/auth/me', async (route) => {
    await authGate;
    await route.continue({
      headers: { ...route.request().headers(), 'x-now': '2026-01-01T12:00:00.000Z' },
    });
  });

  await page.goto('/');
  const shell = page.getByTestId('app-shell-skeleton');
  try {
    await expect(shell).toBeVisible();
    await expect(shell.getByRole('button', { name: 'Open navigation' })).toBeVisible();
    await expect(shell.getByRole('link', { name: 'Open Academy home' })).toBeVisible();
    mkdirSync(testInfo.outputDir, { recursive: true });
    await page.screenshot({
      path: testInfo.outputPath('root-pending-mobile-390x844.png'),
      animations: 'disabled',
    });

    await shell.getByRole('button', { name: 'Open navigation' }).click();
    const navigation = page.getByRole('navigation', { name: 'Main navigation' });
    await expect(navigation).toBeVisible();
    await expect(navigation.getByRole('link', { name: 'Home', exact: true })).toBeVisible();
    await expect(navigation.getByTestId('sidebar-course-skeleton')).toHaveCount(3);
    await expect(navigation.getByTestId('reviews-due-skeleton')).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath('root-pending-mobile-navigation-390x844.png'),
      animations: 'disabled',
    });
  } finally {
    releaseAuth();
  }
  await expect(page.getByRole('heading', { name: 'Next up', exact: true })).toBeVisible();
});

test('sidebar shows first-load course and review skeletons before real data', async ({
  page,
}, testInfo) => {
  await db.insert(reviewCards).values({
    userId,
    conceptId: 'supervised-learning',
    dimension: 'conceptual',
    fsrs: newReviewCard(new Date('2026-01-01T12:00:00.000Z')),
    dueAt: new Date('2026-01-01T00:00:00.000Z'),
    reps: 0,
    lapses: 0,
  });
  const createGate = () => {
    let release = () => {};
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { promise, release: () => release() };
  };
  let coursesGate = createGate();
  let reviewsGate = createGate();
  let coursesRequests = 0;
  let reviewsRequests = 0;
  await page.route('**/api/courses', async (route) => {
    coursesRequests += 1;
    await coursesGate.promise;
    await fulfillCoursesWithLongTitle(route);
  });
  await page.route('**/api/reviews', async (route) => {
    reviewsRequests += 1;
    await reviewsGate.promise;
    await route.continue({
      headers: { ...route.request().headers(), 'x-now': '2026-01-01T12:00:00.000Z' },
    });
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect.poll(() => coursesRequests > 0 && reviewsRequests > 0).toBe(true);
  const navigation = page.getByRole('navigation', { name: 'Main navigation' });
  await expect(navigation.getByText('My courses', { exact: true })).toBeVisible();
  await expect(navigation.getByTestId('sidebar-course-skeleton')).toHaveCount(3);
  await expect(navigation.getByTestId('reviews-due-skeleton')).toBeVisible();
  const skeletonRowHeights = await navigation
    .getByTestId('sidebar-course-skeleton')
    .evaluateAll((rows) => rows.map((row) => row.getBoundingClientRect().height));
  expect(skeletonRowHeights[1]).toBe(skeletonRowHeights[0]);
  expect(skeletonRowHeights[2]).toBe(skeletonRowHeights[0]);
  await page.screenshot({
    path: testInfo.outputPath('sidebar-loading-1440x900.png'),
    animations: 'disabled',
  });

  await navigation.getByRole('button', { name: 'Collapse navigation' }).click();
  await expect(navigation.getByText('My courses', { exact: true })).toHaveCount(0);
  await expect(navigation.getByTestId('sidebar-course-skeleton')).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath('sidebar-collapsed-1440x900.png'),
    animations: 'disabled',
  });
  await navigation.getByRole('button', { name: 'Expand navigation' }).click();
  await expect(navigation.getByTestId('sidebar-course-skeleton')).toHaveCount(3);

  coursesGate.release();
  reviewsGate.release();
  await expect(navigation.getByTestId('sidebar-course-skeleton')).toHaveCount(0);
  await expect(navigation.getByRole('link', { name: 'Open Fixture course' })).toBeVisible();
  const longCourseLink = navigation.getByRole('link', {
    name: 'Open Mathematics for Machine Learning',
  });
  await expect(longCourseLink).toBeVisible();
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  const longCourseLayout = await longCourseLink.evaluate((link) => {
    const [title, count] = Array.from(link.querySelectorAll<HTMLElement>(':scope > span'));
    if (!title || !count) throw new Error('Expected title and topic count in course row');
    const rowBounds = link.getBoundingClientRect();
    const titleBounds = title.getBoundingClientRect();
    const countBounds = count.getBoundingClientRect();
    return {
      titleHeight: titleBounds.height,
      titleTop: titleBounds.top,
      titleClassName: title.className,
      titleTextOverflow: getComputedStyle(title).textOverflow,
      titleWhiteSpace: getComputedStyle(title).whiteSpace,
      countTop: countBounds.top,
      countRightInset: rowBounds.right - countBounds.right,
    };
  });
  expect(longCourseLayout.titleHeight).toBeGreaterThan(20);
  expect(longCourseLayout.titleClassName).not.toMatch(/truncate|line-clamp/);
  expect(longCourseLayout.titleTextOverflow).not.toBe('ellipsis');
  expect(longCourseLayout.titleWhiteSpace).toBe('normal');
  expect(Math.abs(longCourseLayout.titleTop - longCourseLayout.countTop)).toBeLessThanOrEqual(1);
  expect(longCourseLayout.countRightInset).toBeCloseTo(8, 0);
  const desktopCourseRows = await navigation.locator('a[href^="/courses/"]').evaluateAll((links) =>
    links
      .map((link) => {
        const bounds = link.getBoundingClientRect();
        return { top: bounds.top, bottom: bounds.bottom };
      })
      .sort((a, b) => a.top - b.top),
  );
  for (let index = 1; index < desktopCourseRows.length; index += 1) {
    expect(desktopCourseRows[index].top).toBeGreaterThanOrEqual(
      desktopCourseRows[index - 1].bottom,
    );
  }
  await page.screenshot({
    path: testInfo.outputPath('sidebar-wrapped-course-1440x900.png'),
    animations: 'disabled',
  });
  await navigation.getByRole('button', { name: 'Collapse navigation' }).click();
  await expect(
    navigation.getByRole('link', { name: /Mathematics for Machine Learning/ }),
  ).toHaveCount(0);
  await navigation.getByRole('button', { name: 'Expand navigation' }).click();
  await expect(longCourseLink).toBeVisible();
  await expect(navigation.getByTestId('reviews-due-count')).toHaveText('1');
  await expect(navigation.getByTestId('reviews-due-skeleton')).toHaveCount(0);

  const previousCoursesRequests = coursesRequests;
  const previousReviewsRequests = reviewsRequests;
  coursesGate = createGate();
  reviewsGate = createGate();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect
    .poll(
      () => coursesRequests > previousCoursesRequests && reviewsRequests > previousReviewsRequests,
    )
    .toBe(true);
  await page.getByRole('button', { name: 'Open navigation' }).click();
  const mobileNavigation = page.getByRole('navigation', { name: 'Main navigation' });
  await expect(mobileNavigation.getByTestId('sidebar-course-skeleton')).toHaveCount(3);
  await expect(mobileNavigation.getByTestId('reviews-due-skeleton')).toBeVisible();
  const mobileSkeletonRowHeights = await mobileNavigation
    .getByTestId('sidebar-course-skeleton')
    .evaluateAll((rows) => rows.map((row) => row.getBoundingClientRect().height));
  expect(mobileSkeletonRowHeights[0]).toBe(mobileSkeletonRowHeights[1]);
  expect(mobileSkeletonRowHeights[2]).toBe(mobileSkeletonRowHeights[1]);
  const mobileWidths = await mobileNavigation.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(mobileWidths.scrollWidth).toBeLessThanOrEqual(mobileWidths.clientWidth);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

  coursesGate.release();
  reviewsGate.release();
  await expect(mobileNavigation.getByTestId('sidebar-course-skeleton')).toHaveCount(0);
  await expect(mobileNavigation.getByRole('link', { name: 'Open Fixture course' })).toBeVisible();
  const mobileLongCourseLink = mobileNavigation.getByRole('link', {
    name: 'Open Mathematics for Machine Learning',
  });
  await expect(mobileLongCourseLink).toBeVisible();
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  const mobileLongCourseLayout = await mobileLongCourseLink.evaluate((link) => {
    const [title, count] = Array.from(link.querySelectorAll<HTMLElement>(':scope > span'));
    if (!title || !count) throw new Error('Expected title and topic count in course row');
    const rowBounds = link.getBoundingClientRect();
    const titleBounds = title.getBoundingClientRect();
    const countBounds = count.getBoundingClientRect();
    return {
      titleHeight: titleBounds.height,
      titleTop: titleBounds.top,
      titleClassName: title.className,
      titleTextOverflow: getComputedStyle(title).textOverflow,
      titleWhiteSpace: getComputedStyle(title).whiteSpace,
      countTop: countBounds.top,
      countRightInset: rowBounds.right - countBounds.right,
    };
  });
  expect(mobileLongCourseLayout.titleHeight).toBeGreaterThanOrEqual(20);
  expect(mobileLongCourseLayout.titleClassName).not.toMatch(/truncate|line-clamp/);
  expect(mobileLongCourseLayout.titleTextOverflow).not.toBe('ellipsis');
  expect(mobileLongCourseLayout.titleWhiteSpace).toBe('normal');
  expect(
    Math.abs(mobileLongCourseLayout.titleTop - mobileLongCourseLayout.countTop),
  ).toBeLessThanOrEqual(1);
  expect(mobileLongCourseLayout.countRightInset).toBeCloseTo(8, 0);
  const mobileCourseRows = await mobileNavigation
    .locator('a[href^="/courses/"]')
    .evaluateAll((links) =>
      links
        .map((link) => {
          const bounds = link.getBoundingClientRect();
          return { top: bounds.top, bottom: bounds.bottom };
        })
        .sort((a, b) => a.top - b.top),
    );
  for (let index = 1; index < mobileCourseRows.length; index += 1) {
    expect(mobileCourseRows[index].top).toBeGreaterThanOrEqual(mobileCourseRows[index - 1].bottom);
  }
  await page.screenshot({
    path: testInfo.outputPath('sidebar-wrapped-course-390x844.png'),
    animations: 'disabled',
  });
  await expect(mobileNavigation.getByTestId('reviews-due-count')).toHaveText('1');
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
    modifiers: ['ControlOrMeta'],
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
  await expect(page.getByRole('button', { name: 'Add to my courses' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Take the placement check' })).toBeVisible();
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
  await expect(page.getByRole('button', { name: 'Add to my courses' })).toBeVisible();
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
  const screenshots = 'test-results/screenshots/study-set';
  mkdirSync(screenshots, { recursive: true });
  await page.route('**/api/courses', async (route) => {
    const response = await route.fetch();
    const catalog = (await response.json()) as {
      subjects: Array<{ courses: Array<{ id: string; title: string }> }>;
    };
    const longTitleCourse = catalog.subjects
      .flatMap((subject) => subject.courses)
      .find((course) => course.id === 'fixture-switching-course');
    if (!longTitleCourse) throw new Error('Missing fixture switching course in catalogue');
    longTitleCourse.title = 'Mathematics for Machine Learning';
    await route.fulfill({ response, json: catalog });
  });
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
    await expect(
      page.getByRole('heading', { name: 'Mathematics for Machine Learning', exact: true }),
    ).toBeVisible();
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
    await expect(page.getByRole('button', { name: 'Add to my courses' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Take the placement check' })).toBeVisible();
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
