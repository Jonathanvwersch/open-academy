import { expect, test } from '@playwright/test';

test('the app loads a generated pack course', async ({ page }) => {
  test.skip(
    !process.env.PLAYWRIGHT_CONTENT_DIR,
    'run with pnpm test:e2e:generated-pack to create a temporary course pack',
  );
  const courseTitle = process.env.PACK_SMOKE_COURSE_TITLE ?? 'Generated pack basics';
  await page.goto('/course');
  await expect(page.getByRole('heading', { name: courseTitle, exact: true })).toBeVisible();
});
