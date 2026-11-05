import { mkdirSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { createDb } from '../../src/server/db/client.js';
import {
  diagnosticRuns,
  sessionActivities,
  studySessions,
  users,
  xpEvents,
} from '../../src/server/db/schema.js';
import { env } from '../../src/server/env.js';

const db = createDb(env.TEST_DATABASE_URL);
const screenshotDir = '/home/ubuntu/screenshots/learn-course';
mkdirSync(screenshotDir, { recursive: true });
let userId = '';

test.beforeEach(async ({ page }) => {
  await page.route('**/api/**', (route) =>
    route.continue({
      headers: { ...route.request().headers(), 'x-now': '2026-01-01T12:00:00.000Z' },
    }),
  );
  await db.delete(users);
  const [user] = await db
    .insert(users)
    .values({
      displayName: 'Learn course E2E learner',
      timezone: 'UTC',
      startDate: '2026-01-01',
      prefs: { scheduleMinutes: 60 },
    })
    .returning();
  if (!user) throw new Error('Could not create Learn course learner');
  userId = user.id;
});

test.afterAll(async () => {
  await db.$client.end();
});

async function markDiagnosticComplete() {
  await db.insert(diagnosticRuns).values({
    userId,
    status: 'completed',
    state: {},
    startedAt: new Date('2026-01-01T10:00:00.000Z'),
    completedAt: new Date('2026-01-01T10:10:00.000Z'),
  });
}

test('Learn shows XP and tasks, starts a session, and Course links to lessons', async ({
  page,
}) => {
  await markDiagnosticComplete();
  await db.insert(xpEvents).values([
    {
      userId,
      kind: 'activity',
      sourceKey: 'activity:earlier-week',
      conceptId: 'vectors',
      amount: 35,
      earnedAt: new Date('2025-12-30T12:00:00.000Z'),
      localDate: '2025-12-30',
    },
    {
      userId,
      kind: 'knowledge_point',
      sourceKey: 'kp:today:point',
      conceptId: 'supervised-learning',
      amount: 10,
      earnedAt: new Date('2026-01-01T12:00:00.000Z'),
      localDate: '2026-01-01',
    },
  ]);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Learn', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Learn' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Next up' })).toBeVisible();
  const lessonTasks = page.locator('li').filter({ has: page.getByText('Lesson', { exact: true }) });
  await expect(lessonTasks.first()).toContainText('Vectors');
  await expect(page.getByText('10 / 60 XP')).toBeVisible();
  await expect(page.getByText('Total XP').locator('..')).toContainText('45');
  await expect(page.getByRole('button', { name: 'Start learning' })).toBeEnabled();
  await page.screenshot({ path: `${screenshotDir}/learn-with-xp.png`, fullPage: true });

  await page.getByRole('link', { name: 'View course' }).click();
  await expect(page.getByRole('heading', { name: 'Course', exact: true })).toBeVisible();
  await expect(page.getByText('1.1', { exact: true })).toBeVisible();
  await expect(page.locator('li').filter({ hasText: '1.2' })).toContainText('Needs Vectors');
  await page.screenshot({ path: `${screenshotDir}/course.png`, fullPage: true });
  await page.getByRole('link', { name: 'View lesson' }).first().click();
  await expect(page).toHaveURL(/\/lessons\/vectors$/);
  await expect(page.getByRole('heading', { name: 'Vectors' })).toBeVisible();

  await page.goto('/');
  await page.getByRole('button', { name: 'Start learning' }).click();
  await expect(page).toHaveURL(/\/session\//);
});

test('a fresh learner sees Learn onboarding without XP', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Learn', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Welcome to Academy' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Start diagnostic' })).toBeVisible();
  await page.screenshot({ path: `${screenshotDir}/learn-fresh.png`, fullPage: true });
});

test('a fresh post-diagnostic learner sees outline order and prerequisite needs', async ({
  page,
}) => {
  await markDiagnosticComplete();
  await page.goto('/');
  const firstLessonTask = page
    .locator('li')
    .filter({ has: page.getByText('Lesson', { exact: true }) })
    .first();
  await expect(firstLessonTask).toContainText('Vectors');
  await page.screenshot({
    path: `${screenshotDir}/learn-fresh-outline.png`,
    fullPage: true,
  });

  await page.goto('/course');
  const secondTopic = page.locator('li').filter({ hasText: '1.2' });
  await expect(secondTopic).toContainText('Needs Vectors');
  await page.screenshot({ path: `${screenshotDir}/course-fresh.png`, fullPage: true });
});

test('passing a knowledge point increases Learn XP after reload', async ({ page }) => {
  await markDiagnosticComplete();
  const [session] = await db
    .insert(studySessions)
    .values({ userId, plannedMinutes: 20, status: 'active', kind: 'weekday' })
    .returning();
  if (!session) throw new Error('Could not create KP session');
  await db.insert(sessionActivities).values({
    sessionId: session.id,
    idx: 0,
    kind: 'learn',
    conceptId: 'supervised-learning',
    plannedMinutes: 20,
    status: 'in_progress',
  });
  await page.goto('/');
  const before = await page.evaluate(async () => (await fetch('/api/learn')).json());
  expect(before.xp.today).toBe(0);
  await page.goto(`/session/${session.id}`);
  await expect(page.getByTestId('lesson-problem')).toBeVisible();
  await answerCurrentProblem(page);
  await expect(page.getByRole('button', { name: 'Next problem' })).toBeVisible();
  await page.getByRole('button', { name: 'Next problem' }).click();
  await answerCurrentProblem(page);
  await page.goto('/');
  await expect
    .poll(async () => {
      const response = await page.evaluate(async () => (await fetch('/api/learn')).json());
      return response.xp.today;
    })
    .toBe(10);
});

async function answerCurrentProblem(page: Page) {
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const response = await fetch('/api/lessons/supervised-learning/run');
        const body = await response.json();
        return body.run?.pendingProblem?.id ?? null;
      }),
    )
    .toBeTruthy();
  const run = await page.evaluate(async () => {
    const response = await fetch('/api/lessons/supervised-learning/run');
    return (await response.json()).run;
  });
  const problem = run.pendingProblem;
  const answer = await page.evaluate(async (id) => {
    const response = await fetch(`/api/test/lesson-problems/${id}/answer`);
    return response.json();
  }, problem.id);
  if (problem.exercise.type === 'mc') {
    const ids = Array.isArray(answer.answer) ? answer.answer : [answer.answer];
    const options = problem.exercise.options;
    for (const id of ids) {
      const index = options.findIndex((option: { id: string }) => option.id === id);
      await page
        .getByRole(problem.exercise.multi ? 'checkbox' : 'radio')
        .nth(index)
        .click();
    }
  } else {
    await page.getByLabel('Your answer').fill(String(answer.answer));
  }
  await page.getByRole('button', { name: 'Submit answer' }).click();
  await expect(page.getByRole('status')).toContainText('Correct');
}
