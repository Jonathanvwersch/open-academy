import { expect, test } from '@playwright/test';

test('Today displays a healthy API and database', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
  await expect(page.getByText('Health: OK · Database: connected')).toBeVisible();
});
