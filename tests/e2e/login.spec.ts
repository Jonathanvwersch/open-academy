import { expect, test } from '@playwright/test';

test.use({ storageState: { cookies: [], origins: [] } });

test('password login remembers the session and logout requires login again', async ({ page }) => {
  await page.goto('/course');
  await expect(page).toHaveURL(/\/login\?redirect=%2Fcourse$/);

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
  await page.getByRole('button', { name: 'Log out', exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto('/course');
  await expect(page).toHaveURL(/\/login\?redirect=%2Fcourse$/);
});
