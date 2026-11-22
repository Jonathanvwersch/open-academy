import { mkdirSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { e2ePassword } from './auth-config.js';

test.use({ storageState: { cookies: [], origins: [] } });

const screenshotDir = 'test-results/screenshots/screenshots/landing';
mkdirSync(screenshotDir, { recursive: true });

test('signed-out visitors see the landing page without the app shell', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');

  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { name: 'Learn AI from the maths up.' })).toBeVisible();
  await expect(page.locator('[data-slot="sidebar-wrapper"]')).toHaveCount(0);
  await expect(page.locator('[data-sidebar="sidebar"]')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Settings' })).toHaveCount(0);
  await expect(
    page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Courses' }),
  ).toHaveAttribute('href', '/courses');
  await expect(
    page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'How it works' }),
  ).toHaveAttribute('href', '/how-it-works');

  const signInLinks = page.getByRole('link', { name: 'Sign in', exact: true });
  await expect(signInLinks).toHaveCount(3);
  for (let index = 0; index < 3; index += 1) {
    await expect(signInLinks.nth(index)).toHaveAttribute('href', '/login');
  }
  await page.screenshot({
    path: `${screenshotDir}/landing-desktop.png`,
    fullPage: true,
  });
  await page.setViewportSize({ width: 800, height: 1000 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Learn AI from the maths up.' })).toBeVisible();
  await page.screenshot({
    path: `${screenshotDir}/landing-tablet.png`,
    fullPage: true,
  });
});

test('signed-out visitors can navigate to the public courses and how it works pages', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');

  const mainNav = page.getByRole('navigation', { name: 'Main' });
  await mainNav.getByRole('link', { name: 'Courses' }).click();
  await expect(page).toHaveURL('/courses');
  await expect(
    page.getByRole('heading', { name: 'Six courses, from vectors to LLMs' }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Mathematics for Machine Learning' }),
  ).toBeVisible();
  await expect(page).toHaveTitle('Courses · Open Academy');
  await expect(page.locator('[data-sidebar="sidebar"]')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Settings' })).toHaveCount(0);
  await expect(mainNav.getByRole('link', { name: 'Courses' })).toHaveAttribute(
    'aria-current',
    'page',
  );

  await mainNav.getByRole('link', { name: 'How it works' }).click();
  await expect(page).toHaveURL('/how-it-works');
  await expect(page.getByRole('heading', { name: 'How Open Academy works' })).toBeVisible();
  await expect(page).toHaveTitle('How it works · Open Academy');
  await expect(page.locator('[data-sidebar="sidebar"]')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Settings' })).toHaveCount(0);
  await expect(mainNav.getByRole('link', { name: 'How it works' })).toHaveAttribute(
    'aria-current',
    'page',
  );

  await page.goto('/courses/');
  await expect(
    page.getByRole('heading', { name: 'Six courses, from vectors to LLMs' }),
  ).toBeVisible();
  await page.goto('/how-it-works/');
  await expect(page.getByRole('heading', { name: 'How Open Academy works' })).toBeVisible();
});

test('signed-out visitors are redirected from course detail pages', async ({ page }) => {
  await page.goto('/courses/maths-for-ml');
  await expect(page).toHaveURL(/\/login\?redirect=%2Fcourses%2Fmaths-for-ml$/);
});

test('signed-in visitors keep the app catalogue and can open the public how it works page', async ({
  page,
}) => {
  await page.goto('/login');
  await page.getByLabel('Password').fill(e2ePassword);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page).toHaveURL('/');

  await page.goto('/courses');
  await expect(page.locator('[data-sidebar="sidebar"]').first()).toBeVisible();
  await expect(page.locator('[data-page-frame] a[href^="/courses/"]').first()).toBeVisible();

  await page.goto('/how-it-works');
  await expect(page.getByRole('heading', { name: 'How Open Academy works' })).toBeVisible();
  await expect(page.locator('[data-sidebar="sidebar"]')).toHaveCount(0);
});

test('the mobile landing page fits and keeps its sign-in action in view', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Learn AI from the maths up.' })).toBeVisible();
  await expect(
    page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Courses' }),
  ).toBeVisible();
  await expect(
    page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'How it works' }),
  ).toBeVisible();

  const heroSignIn = page
    .getByRole('main')
    .getByRole('link', { name: 'Sign in', exact: true })
    .first();
  await expect(heroSignIn).toBeInViewport();
  const bounds = await heroSignIn.boundingBox();
  expect(bounds).not.toBeNull();
  if (!bounds) throw new Error('Expected the hero sign-in link to have a bounding box');
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(844);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);

  await page.screenshot({
    path: `${screenshotDir}/landing-mobile.png`,
    fullPage: true,
  });

  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Learn AI from the maths up.' })).toBeVisible();
  await expect(
    page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Courses' }),
  ).toBeVisible();
  await expect(
    page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'How it works' }),
  ).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
});

test('public pages fit mobile viewports with their navigation visible', async ({ page }) => {
  for (const width of [390, 320]) {
    const height = width === 320 ? 640 : 844;
    for (const path of ['/', '/courses', '/how-it-works']) {
      await page.setViewportSize({ width, height });
      await page.goto(path);
      const heading =
        path === '/'
          ? 'Learn AI from the maths up.'
          : path === '/courses'
            ? 'Six courses, from vectors to LLMs'
            : 'How Open Academy works';
      await expect(page.getByRole('heading', { name: heading })).toBeVisible();
      const mainNav = page.getByRole('navigation', { name: 'Main' });
      await expect(mainNav.getByRole('link', { name: 'Courses' })).toBeVisible();
      await expect(mainNav.getByRole('link', { name: 'How it works' })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    }
  }
});

test('signing in from the landing page opens the signed-in Home page', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  await page.getByRole('main').getByRole('link', { name: 'Sign in', exact: true }).first().click();

  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel('Password').fill(e2ePassword);
  await page.getByRole('button', { name: 'Log in' }).click();

  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Settings' }).first()).toBeVisible();
});
