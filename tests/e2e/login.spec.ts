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
  await password.fill('wrong-password');
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('alert')).toContainText('Wrong password');

  await password.fill('test-password-123');
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page).toHaveURL(/\/course$/);
  await expect(page.getByRole('heading', { name: 'Course', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Course', exact: true })).toBeVisible();

  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  await page.getByLabel('Daily study time').fill('30');
  await expect(
    page.getByText('Daily goal: 30 XP · 1 XP ≈ 1 minute', { exact: true }),
  ).toBeVisible();
  await page.getByLabel('Saturday study time').fill('45');
  await expect(
    page.getByText('Daily goal: 45 XP · 1 XP ≈ 1 minute', { exact: true }),
  ).toBeVisible();
  await page.getByLabel('Sunday study time').fill('75');
  await expect(
    page.getByText('Daily goal: 75 XP · 1 XP ≈ 1 minute', { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: `${xpFinishScreenshotDir}/settings-goal-hints.png`,
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Log out', exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto('/course');
  await expect(page).toHaveURL(/\/login\?redirect=%2Fcourse$/);
});
