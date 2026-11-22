import { mkdirSync } from 'node:fs';
import { expect, test } from '@playwright/test';

test.use({ storageState: { cookies: [], origins: [] } });

const brandScreenshotDir = 'test-results/screenshots/screenshots/brand';
const xpFinishScreenshotDir = 'test-results/screenshots/screenshots/xp-finish';
mkdirSync(brandScreenshotDir, { recursive: true });
mkdirSync(xpFinishScreenshotDir, { recursive: true });

test('password login remembers the session and logout requires login again', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/course');
  await expect(page).toHaveURL(/\/login\?redirect=%2Fcourse$/);
  await expect(page).toHaveTitle('Open Academy');
  await expect(page.getByRole('heading', { name: 'Open Academy', exact: true })).toBeVisible();
  await page.screenshot({
    path: `${brandScreenshotDir}/login-desktop.png`,
    fullPage: true,
  });

  const password = page.getByLabel('Password');
  const labelBounds = await page.locator('label[for="password"]').boundingBox();
  const inputBounds = await password.boundingBox();
  expect(labelBounds).not.toBeNull();
  expect(inputBounds).not.toBeNull();
  if (!labelBounds || !inputBounds) throw new Error('Expected the password field and label');
  expect(inputBounds.y - labelBounds.y - labelBounds.height).toBeGreaterThanOrEqual(8);
  await expect(page.getByText('Enter your password to continue.')).toHaveCount(0);
  await password.fill('wrong-password');
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('alert')).toContainText('Wrong password');

  await password.fill('test-password-123');
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page).toHaveURL(/\/course$/);
  await expect(page.getByRole('heading', { name: 'Fixture course', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Fixture course', exact: true })).toBeVisible();

  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  for (const day of ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']) {
    await page.getByLabel(`${day} study goal`).fill('30');
  }
  await page.getByLabel('Saturday study goal').fill('45');
  await page.getByLabel('Sunday study goal').fill('75');
  await expect(page.getByText('4.5 hours / week', { exact: true })).toBeVisible();
  await page.screenshot({
    path: `${xpFinishScreenshotDir}/settings-goal-hints.png`,
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Log out', exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto('/course');
  await expect(page).toHaveURL(/\/login\?redirect=%2Fcourse$/);
});

test('wrong password on /login/ stays on the login page', async ({ page }) => {
  await page.goto('/login/');
  await expect(page).toHaveURL(/\/login\/$/);

  await page.getByLabel('Password').fill('wrong-password');
  await page.getByRole('button', { name: 'Log in' }).click();

  await expect(page.getByRole('alert')).toContainText('Wrong password');
  await expect(page).toHaveURL(/\/login\/$/);
});
