import { expect, test } from '@playwright/test';
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

test('full lesson shows prerequisite links and opens the prerequisite lesson', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/lessons/gradient-descent');

  await expect(page.getByText('Before this:', { exact: false })).toBeVisible();
  const prerequisiteLink = page.getByRole('link', { name: 'Gradient vectors' });
  await expect(prerequisiteLink).toBeVisible();
  await page.screenshot({ path: '/home/ubuntu/lesson-review/before-this.png' });

  await prerequisiteLink.click();
  await expect(page).toHaveURL(/\/lessons\/gradients$/);
});

test('session lesson shows prerequisite links and opens the prerequisite lesson', async ({
  page,
}) => {
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

  await expect(page.getByText('Before this:', { exact: false })).toBeVisible();
  const prerequisiteLink = page.getByRole('link', { name: 'Gradient vectors' });
  await expect(prerequisiteLink).toBeVisible();
  await prerequisiteLink.click();
  await expect(page).toHaveURL(/\/lessons\/gradients$/);
});
