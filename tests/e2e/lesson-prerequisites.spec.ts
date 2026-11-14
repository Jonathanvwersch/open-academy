import { mkdirSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { and, eq } from 'drizzle-orm';
import { env } from '../../apps/api/src/config.js';
import { createDb } from '../../apps/api/src/db/client.js';
import { lessonRuns, users } from '../../apps/api/src/db/schema.js';
import { enrollInDefaultCourse } from './course-start.js';

const db = createDb(env.TEST_DATABASE_URL);
const screenshotDir = 'test-results/screenshots/shots/lesson-quiz';
let userId = '';
mkdirSync(screenshotDir, { recursive: true });

function requireRepositoryContent() {
  test.skip(
    process.env.PLAYWRIGHT_CONTENT_DIR !== 'content',
    'requires the repository content directory',
  );
}

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
  await enrollInDefaultCourse(db, userId);
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
      text: 'A linear model predicts',
    },
  ]) {
    const link = page.getByRole('link', { name: prerequisite.title, exact: true });
    await expect(link).toHaveAttribute('href', `/lessons/${prerequisite.id}`);
    await expect(link.locator('xpath=ancestor::li[1]')).toContainText(prerequisite.text);
  }
}

test('full lesson shows recap facts and opens a prerequisite lesson', async ({ page }) => {
  requireRepositoryContent();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/lessons/gradient-descent');

  await expectGradientDescentRecap(page);
  await expect(page.getByRole('heading', { name: 'What is gradient descent?' })).toBeVisible();
  const prerequisiteLink = page.getByRole('link', { name: 'Gradient vectors' });
  await expect(prerequisiteLink).toBeVisible();
  await page.screenshot({ path: 'test-results/screenshots/lesson-review/recap-full.png' });

  await prerequisiteLink.click();
  await expect(page).toHaveURL(/\/lessons\/gradients$/);
});

test('session lesson shows recap facts and opens a prerequisite lesson', async ({ page }) => {
  requireRepositoryContent();
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
  await page.screenshot({ path: 'test-results/screenshots/lesson-review/recap-runner.png' });
  await prerequisiteLink.click();
  await expect(page).toHaveURL(/\/lessons\/gradients$/);
});

test('course shows an unpassed quiz and locks a dependent lesson', async ({ page }) => {
  requireRepositoryContent();
  await page.setViewportSize({ width: 1280, height: 900 });
  const completedAt = new Date();
  await db.insert(lessonRuns).values([
    { userId, conceptId: 'supervised-learning', status: 'quiz' },
    {
      userId,
      conceptId: 'dot-product',
      status: 'completed',
      completedAt,
      quizPassedAt: completedAt,
    },
    {
      userId,
      conceptId: 'matrices',
      status: 'completed',
      completedAt,
      quizPassedAt: completedAt,
    },
  ]);

  await page.goto('/course');
  await expect(page.getByText('Quiz not passed', { exact: true })).toBeVisible();
  const lockedDependent = page.getByRole('link', { name: /1\.6 Linear regression/ });
  await expect(lockedDependent).toHaveClass(/opacity-60/);
  await expect(lockedDependent).toContainText('Pass the Supervised learning setup quiz first');
  await page.screenshot({
    path: `${screenshotDir}/course-quiz-not-passed.png`,
  });
  await lockedDependent.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: `${screenshotDir}/locked-dependent-quiz-prerequisite.png`,
  });

  await db
    .update(lessonRuns)
    .set({ status: 'completed', completedAt, quizPassedAt: completedAt })
    .where(and(eq(lessonRuns.userId, userId), eq(lessonRuns.conceptId, 'supervised-learning')));
  await page.reload();
  await expect(lockedDependent).not.toHaveClass(/opacity-60/);
  await expect(lockedDependent).not.toContainText('Pass the Supervised learning setup quiz first');
});

test('loss functions shows its authored prerequisite recap', async ({ page }) => {
  requireRepositoryContent();
  await page.goto('/lessons/loss-functions');

  await expect(page.getByRole('heading', { name: 'Recap' })).toBeVisible();
  await expect(page.getByText('Before this:', { exact: false })).toHaveCount(0);
  for (const prerequisite of [
    { id: 'supervised-learning', title: 'Supervised learning setup' },
    { id: 'derivatives', title: 'Derivatives' },
  ]) {
    const link = page.getByRole('link', { name: prerequisite.title, exact: true });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('href', `/lessons/${prerequisite.id}`);
  }
});
