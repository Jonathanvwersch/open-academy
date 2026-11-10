import { expect, type Page, test } from '@playwright/test';
import { createDb } from '../../src/server/db/client.js';
import { diagnosticRuns, lessonRuns, users } from '../../src/server/db/schema.js';
import { env } from '../../src/server/env.js';

const db = createDb(env.TEST_DATABASE_URL);
let userId = '';

test.beforeEach(async () => {
  await db.delete(users);
  const [user] = await db
    .insert(users)
    .values({
      displayName: 'Lesson prerequisites E2E learner',
      timezone: 'UTC',
      startDate: '2026-01-01',
    })
    .returning({ id: users.id });
  if (!user) throw new Error('Could not create lesson prerequisites learner');
  userId = user.id;
  await db.insert(diagnosticRuns).values({
    userId,
    status: 'completed',
    state: {},
    startedAt: new Date(),
    completedAt: new Date(),
  });
});

test.afterAll(async () => {
  await db.delete(users);
  await db.$client.end();
});

async function expectGradientDescentRecap(page: Page) {
  await expect(page.getByRole('heading', { name: 'Recap' })).toBeVisible();
  await expect(page.getByText('Before this:', { exact: false })).toHaveCount(0);
  const recapList = page
    .locator('ul')
    .filter({ has: page.getByRole('link', { name: 'Gradient vectors', exact: true }) });
  await expect(recapList).toHaveCount(1);
  await expect(recapList.locator('li')).toHaveCount(3);
  for (const prerequisite of [
    {
      id: 'gradients',
      title: 'Gradient vectors',
      text: 'The gradient',
    },
    {
      id: 'loss-functions',
      title: 'Loss functions (MSE, MAE)',
      text: 'A loss is one number',
    },
    {
      id: 'linear-regression',
      title: 'Linear regression',
      text: 'A linear model predicts a number',
    },
  ]) {
    const link = page.getByRole('link', { name: prerequisite.title, exact: true });
    await expect(link).toHaveAttribute('href', `/lessons/${prerequisite.id}`);
    await expect(link.locator('xpath=ancestor::li[1]')).toContainText(prerequisite.text);
  }
}

test('full lesson shows recap facts and opens a prerequisite lesson', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/lessons/gradient-descent');

  await expectGradientDescentRecap(page);
  await expect(page.getByRole('heading', { name: 'What is gradient descent?' })).toBeVisible();
  const prerequisiteLink = page.getByRole('link', { name: 'Gradient vectors' });
  await expect(prerequisiteLink).toBeVisible();
  await page.screenshot({ path: '/home/ubuntu/lesson-review/recap-full.png' });

  await prerequisiteLink.click();
  await expect(page).toHaveURL(/\/lessons\/gradients$/);
});

test('session lesson shows recap facts and opens a prerequisite lesson', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await db.insert(lessonRuns).values(
    ['gradients', 'loss-functions', 'linear-regression'].map((conceptId) => ({
      userId,
      conceptId,
      status: 'completed' as const,
      completedAt: new Date(),
    })),
  );
  await page.goto('/');
  const response = await page.evaluate(async () => {
    const result = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ budgetMinutes: 60, focusConceptId: 'gradient-descent' }),
    });
    return { status: result.status, session: await result.json() };
  });
  expect(response.status).toBe(201);
  await page.goto(`/session/${response.session.id}`);
  await expect(page.getByTestId('lesson-step-content')).toBeVisible();

  await expectGradientDescentRecap(page);
  await expect(page.locator('section > header h2')).toHaveText('Take one step downhill');
  await expect(page.getByRole('heading', { name: 'What is gradient descent?' })).toBeVisible();
  const prerequisiteLink = page.getByRole('link', { name: 'Gradient vectors' });
  await expect(prerequisiteLink).toBeVisible();
  await page.screenshot({ path: '/home/ubuntu/lesson-review/recap-runner.png' });
  await prerequisiteLink.click();
  await expect(page).toHaveURL(/\/lessons\/gradients$/);
});

test('lesson without recaps keeps authored prerequisite links', async ({ page }) => {
  await page.goto('/lessons/linear-regression');
  const beforeThis = page.locator('p').filter({ hasText: 'Before this:' });

  await expect(beforeThis).toBeVisible();
  await expect(beforeThis.getByRole('link').first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Recap' })).toHaveCount(0);
});
