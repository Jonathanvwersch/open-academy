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
  await expect(page.getByRole('link', { name: 'Settings' })).toHaveCount(0);
  await expect(
    page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Courses' }),
  ).toHaveAttribute('href', '#courses');
  await expect(
    page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'How it works' }),
  ).toHaveAttribute('href', '#how-it-works');

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

test('signed-out visitors do not see learner navigation while auth is pending', async ({
  page,
}) => {
  await page.route('**/api/auth/me', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await route.continue();
  });

  await page.goto('/');
  await expect(page.getByTestId('page-loading-indicator')).toBeVisible();
  await expect(page.getByTestId('app-shell-skeleton')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Settings' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Learn AI from the maths up.' })).toBeVisible();
});

test('the mobile landing page fits and keeps its sign-in action in view', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Learn AI from the maths up.' })).toBeVisible();
  await expect(
    page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Courses' }),
  ).toBeHidden();
  await expect(
    page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'How it works' }),
  ).toBeHidden();

  const heroSignIn = page
    .getByRole('main')
    .getByRole('link', { name: 'Sign in', exact: true })
    .first();
  await expect(heroSignIn).toBeInViewport();
  const bounds = await heroSignIn.boundingBox();
  expect(bounds).not.toBeNull();
  if (!bounds) throw new Error('Expected the hero sign-in link to have a bounding box');
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(844);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

  await page.screenshot({
    path: `${screenshotDir}/landing-mobile.png`,
    fullPage: true,
  });

  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Learn AI from the maths up.' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
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
