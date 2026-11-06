import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { expect, type Page, test } from '@playwright/test';
import { parse } from 'yaml';
import { LessonSchema, normalizeLesson } from '../../src/server/content/schemas.js';
import { createDb } from '../../src/server/db/client.js';
import {
  diagnosticRuns,
  lessonRuns,
  mastery,
  sessionActivities,
  studySessions,
  users,
  xpEvents,
} from '../../src/server/db/schema.js';
import { env } from '../../src/server/env.js';

const db = createDb(env.TEST_DATABASE_URL);
const screenshotDir = '/home/ubuntu/screenshots/learn-course';
const courseStructureScreenshotDir = '/home/ubuntu/screenshots/course-structure';
const courseStructureBatch1ScreenshotDir = `${courseStructureScreenshotDir}/batch1`;
const courseStructureBatch2ScreenshotDir = `${courseStructureScreenshotDir}/batch2`;
mkdirSync(screenshotDir, { recursive: true });
mkdirSync(courseStructureScreenshotDir, { recursive: true });
mkdirSync(courseStructureBatch1ScreenshotDir, { recursive: true });
mkdirSync(courseStructureBatch2ScreenshotDir, { recursive: true });
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
  await expect(
    page.getByText(
      "You'll build the simplest model that learns: predicting a house's price from its measurements, trained on past sales.",
      { exact: false },
    ),
  ).toBeVisible();
  await expect(page.getByText(/^Project: /).first()).toBeVisible();
  const supervisedRow = page
    .getByRole('listitem')
    .filter({ has: page.getByText('Supervised learning', { exact: true }) });
  await expect(supervisedRow).toContainText('Builds on: Vectors');
  await expect(supervisedRow).toContainText('Leads to: Linear models');
  await page.screenshot({
    path: `${courseStructureScreenshotDir}/course-week-1.png`,
    fullPage: true,
  });
  await page.screenshot({ path: `${screenshotDir}/course.png`, fullPage: true });
  await page.getByRole('link', { name: 'View lesson' }).first().click();
  await expect(page).toHaveURL(/\/lessons\/vectors$/);
  await expect(page.getByRole('heading', { name: 'Vectors' })).toBeVisible();

  await page.goto('/');
  await page.getByRole('button', { name: 'Start learning' }).click();
  await expect(page).toHaveURL(/\/session\//);
});

test('authored course-structure lessons render their diagrams', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 1000 });
  await mockLessonReview(
    page,
    'what-is-ml',
    'What machine learning is, and how this course fits together',
  );
  await page.goto('/lessons/what-is-ml');
  await hideTutorLauncher(page);
  await expect(page.locator('article > h2').nth(1)).toContainText('2.');
  const roadmap = page.getByRole('img', {
    name: 'The seven steps of the house-price model, each taught by a Week 1 lesson',
  });
  await expect(roadmap).toBeVisible();
  await roadmap.evaluate((image) => {
    image.style.width = '800px';
    image.style.maxWidth = 'none';
  });
  await roadmap.screenshot({ path: `${courseStructureBatch1ScreenshotDir}/what-is-ml-kp2.png` });

  await mockLessonReview(page, 'matrices', 'Matrices');
  await page.goto('/lessons/matrices');
  await hideTutorLauncher(page);
  await expect(page.locator('article > h2').first()).toContainText('1.');
  const matrixDiagram = page.getByRole('img', {
    name: 'Two panels show row one and row two dotted with the same vector to produce outputs 5 and 1',
  });
  await expect(matrixDiagram).toBeVisible();
  await matrixDiagram.evaluate((image) => {
    image.style.width = '800px';
    image.style.maxWidth = 'none';
  });
  await matrixDiagram.screenshot({
    path: `${courseStructureBatch1ScreenshotDir}/matrices-kp1.png`,
  });

  for (const [conceptId, title] of [
    ['supervised-learning', 'Supervised learning'],
    ['vectors', 'Vectors'],
    ['dot-product', 'Dot product'],
  ]) {
    const knowledgePointCount = await mockLessonReview(page, conceptId, title);
    await page.goto(`/lessons/${conceptId}`);
    await hideTutorLauncher(page);
    const knowledgePoints = page.locator('article');
    await expect(knowledgePoints).toHaveCount(knowledgePointCount);
    for (let index = 0; index < (await knowledgePoints.count()); index += 1) {
      const knowledgePoint = knowledgePoints.nth(index);
      await expect(knowledgePoint.locator(':scope > h2')).toContainText(`${index + 1}.`);
      await knowledgePoint.screenshot({
        path: `${courseStructureBatch1ScreenshotDir}/${conceptId}-kp${index + 1}.png`,
      });
    }
  }

  for (const [conceptId, title] of [
    ['linear-regression', 'Linear regression'],
    ['derivatives', 'Derivatives'],
    ['loss-functions', 'Loss functions'],
    ['partial-derivatives', 'Partial derivatives'],
    ['gradients', 'Gradients'],
  ]) {
    const knowledgePointCount = await mockLessonReview(page, conceptId, title);
    await page.goto(`/lessons/${conceptId}`);
    await hideTutorLauncher(page);
    const knowledgePoints = page.locator('article');
    await expect(knowledgePoints).toHaveCount(knowledgePointCount);
    for (let index = 0; index < (await knowledgePoints.count()); index += 1) {
      const knowledgePoint = knowledgePoints.nth(index);
      await expect(knowledgePoint.locator(':scope > h2')).toContainText(`${index + 1}.`);
      await knowledgePoint.screenshot({
        path: `${courseStructureBatch2ScreenshotDir}/${conceptId}-kp${index + 1}.png`,
      });
    }
  }
});

async function mockLessonReview(
  page: Page,
  conceptId: string,
  conceptTitle: string,
): Promise<number> {
  const source = await readFile(`content/lessons/${conceptId}.yaml`, 'utf8');
  const parsed = LessonSchema.parse(parse(source));
  if (!('knowledge_points' in parsed)) throw new Error('Expected a knowledge-point lesson');
  const lesson = normalizeLesson(parsed, () => false);
  const knowledgePoints = lesson.knowledge_points;
  if (!knowledgePoints) throw new Error('Expected normalized knowledge points');
  await page.route(`**/api/lessons/${conceptId}/review`, (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        lesson: {
          where_this_fits: lesson.where_this_fits,
          final: lesson.final,
          blocks: lesson.blocks,
          knowledge_points: lesson.knowledge_points,
        },
        checkAnswers: {},
        conceptTitle,
      }),
    }),
  );
  await page.route('**/api/exercises/**', (route) => {
    const id = new URL(route.request().url()).pathname.split('/').at(-1);
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ id, type: 'explain', prompt: 'Final check.' }),
    });
  });
  return knowledgePoints.length;
}

async function hideTutorLauncher(page: Page) {
  await page.addStyleTag({
    content: 'button[aria-label="Open tutor"] { display: none !important; }',
  });
}

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

test('Course marks completed lessons green and links the whole row', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await markDiagnosticComplete();
  await db.insert(lessonRuns).values({
    userId,
    conceptId: 'vectors',
    status: 'completed',
    startedAt: new Date('2026-01-01T10:00:00.000Z'),
    updatedAt: new Date('2026-01-01T10:10:00.000Z'),
    completedAt: new Date('2026-01-01T10:10:00.000Z'),
  });
  await db.insert(mastery).values([
    { userId, conceptId: 'vectors', dimension: 'conceptual', state: 'assisted' },
    { userId, conceptId: 'vectors', dimension: 'math', state: 'assisted' },
    { userId, conceptId: 'vectors', dimension: 'transfer', state: 'assisted' },
  ]);
  await page.goto('/course');
  const completedRow = page.getByRole('link', { name: /1\.1.*Vectors/ });
  await expect(completedRow).toContainText('Complete');
  await expect(completedRow).toContainText('Familiar');
  await expect(completedRow).toHaveClass(/emerald/);
  await expect(
    page.locator('[data-slot="sidebar"][aria-label="Tutor"] [data-slot="sidebar-container"]'),
  ).toBeHidden();
  await page.screenshot({
    path: `${screenshotDir}/course-closed-1280x720.png`,
  });
  await page.screenshot({ path: `${screenshotDir}/course-complete-row.png`, fullPage: true });
  await completedRow.click();
  await expect(page).toHaveURL(/\/lessons\/vectors$/);
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
