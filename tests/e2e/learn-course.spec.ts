import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { expect, type Page, test } from '@playwright/test';
import { eq } from 'drizzle-orm';
import { parse } from 'yaml';
import { env } from '../../apps/api/src/config.js';
import { LessonSchema, normalizeLesson } from '../../apps/api/src/content/schemas.js';
import { createDb } from '../../apps/api/src/db/client.js';
import {
  diagnosticRuns,
  lessonRuns,
  mastery,
  projectProgress,
  projectSubmissions,
  sessionActivities,
  studySessions,
  users,
  xpEvents,
} from '../../apps/api/src/db/schema.js';

const db = createDb(env.TEST_DATABASE_URL);
const screenshotDir = 'test-results/screenshots/screenshots/learn-course';
const brandScreenshotDir = 'test-results/screenshots/screenshots/brand';
const courseStructureScreenshotDir = 'test-results/screenshots/screenshots/course-structure';
const courseStructureBatch1ScreenshotDir = `${courseStructureScreenshotDir}/batch1`;
const courseStructureBatch2ScreenshotDir = `${courseStructureScreenshotDir}/batch2`;
const courseStructureBatch3ScreenshotDir = `${courseStructureScreenshotDir}/batch3`;
const mathLinesScreenshotDir = 'test-results/screenshots/screenshots/math-lines';
const courseComingSoonScreenshotDir = 'test-results/screenshots/screenshots/course-coming-soon';
const navCleanupScreenshotDir = 'test-results/screenshots/screenshots/nav-cleanup';
const xpFinishScreenshotDir = 'test-results/screenshots/screenshots/xp-finish';
const chooseLessonScreenshotDir = 'test-results/screenshots/screenshots/choose-lesson';
mkdirSync(screenshotDir, { recursive: true });
mkdirSync(brandScreenshotDir, { recursive: true });
mkdirSync(courseStructureScreenshotDir, { recursive: true });
mkdirSync(courseStructureBatch1ScreenshotDir, { recursive: true });
mkdirSync(courseStructureBatch2ScreenshotDir, { recursive: true });
mkdirSync(courseStructureBatch3ScreenshotDir, { recursive: true });
mkdirSync(mathLinesScreenshotDir, { recursive: true });
mkdirSync(courseComingSoonScreenshotDir, { recursive: true });
mkdirSync(navCleanupScreenshotDir, { recursive: true });
mkdirSync(xpFinishScreenshotDir, { recursive: true });
mkdirSync(chooseLessonScreenshotDir, { recursive: true });
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

test('Home shows XP and tasks, starts a session, and Course links to lessons and projects', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
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
  await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Home' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Next up' })).toBeVisible();
  const lessonTasks = page.locator('li').filter({ has: page.getByText('Lesson', { exact: true }) });
  await expect(lessonTasks.first()).toContainText('Vectors');
  const learn = await page.evaluate(async () => {
    const response = await fetch('/api/learn');
    return response.json();
  });
  await expect(
    page.getByText(`${learn.xp.today} / ${learn.xp.goal} XP`, { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/^At your pace:/)).toBeVisible();
  await expect(page.getByText(/^At your daily goal:/)).toBeVisible();
  await expect(page.getByText('Total XP').locator('..')).toContainText('45');
  await expect(page.getByRole('button', { name: 'Start learning' })).toBeEnabled();
  await page.screenshot({ path: `${screenshotDir}/learn-with-xp.png`, fullPage: true });
  await page.screenshot({
    path: `${xpFinishScreenshotDir}/home-progress.png`,
    fullPage: true,
  });

  await page.getByRole('link', { name: 'View course' }).click();
  await expect(page.getByRole('heading', { name: 'Course', exact: true })).toBeVisible();
  await expect(page.getByText('1.1', { exact: true })).toBeVisible();
  await expect(page.locator('li').filter({ hasText: '1.2' })).toContainText('Needs Vectors');
  const weekOneProject = page.getByRole('region', { name: 'Project' }).first();
  await expect(
    weekOneProject.getByRole('link', { name: 'Linear regression in NumPy' }),
  ).toHaveAttribute('href', '/projects/linreg-numpy');
  const supervisedRow = page
    .getByRole('listitem')
    .filter({ has: page.getByText('Supervised learning', { exact: true }) });
  await expect(supervisedRow).not.toContainText('Builds on:');
  await expect(supervisedRow).not.toContainText('Leads to:');
  await page.screenshot({
    path: `${courseStructureScreenshotDir}/course-week-1.png`,
    fullPage: true,
  });
  await page.screenshot({ path: `${screenshotDir}/course.png`, fullPage: true });
  await weekOneProject.getByRole('link', { name: 'Linear regression in NumPy' }).click();
  await expect(page).toHaveURL('/projects/linreg-numpy');
  await expect(page.getByRole('heading', { name: 'Linear regression in NumPy' })).toBeVisible();
  await page.goto('/course');
  await page
    .getByRole('link', { name: /Vectors/ })
    .first()
    .click();
  await expect(page).toHaveURL(/\/lessons\/vectors$/);
  await expect(page.getByRole('heading', { name: 'Vectors' })).toBeVisible();

  await page.goto('/');
  let createdSessionRequest: Record<string, unknown> | null = null;
  await page.route('**/api/sessions', async (route) => {
    if (route.request().method() === 'POST') {
      createdSessionRequest = JSON.parse(route.request().postData() ?? '{}');
    }
    await route.continue();
  });
  const documentStartedAt = await page.evaluate(() => performance.timeOrigin);
  await page.getByRole('button', { name: 'Start learning' }).click();
  await expect(page).toHaveURL(/\/session\//);
  expect(createdSessionRequest).toEqual({ kind: 'weekday' });
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(documentStartedAt);
});

test('Course weeks default to the current week and remember toggles', async ({ page }) => {
  await page.goto('/course');
  const weekOneCard = page
    .locator('[data-slot="card"]')
    .filter({ has: page.getByRole('heading', { name: 'Week 1 · ML fundamentals' }) });
  const weekTwoCard = page
    .locator('[data-slot="card"]')
    .filter({ has: page.getByRole('heading', { name: 'Week 2 · Optimization' }) });
  await expect(weekOneCard.getByRole('button', { name: 'Collapse week 1' })).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  await expect(weekOneCard.locator('ol')).toBeVisible();
  await expect(weekTwoCard.getByRole('button', { name: 'Expand week 2' })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  await expect(weekTwoCard.locator('ol')).toBeHidden();
  await expect(weekTwoCard.getByText('Project coming soon')).toBeHidden();

  await weekTwoCard.getByRole('button', { name: 'Expand week 2' }).click();
  await expect(weekTwoCard.locator('ol')).toBeVisible();
  await weekTwoCard.getByRole('heading', { name: 'Week 2 · Optimization' }).click();
  await expect(weekTwoCard.locator('ol')).toBeHidden();
  await weekTwoCard.getByRole('button', { name: 'Expand week 2' }).click();
  await weekOneCard.getByRole('button', { name: 'Collapse week 1' }).click();

  await page.reload();
  await expect(weekOneCard.getByRole('button', { name: 'Expand week 1' })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  await expect(weekOneCard.locator('ol')).toBeHidden();
  await expect(weekTwoCard.getByRole('button', { name: 'Collapse week 2' })).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  await expect(weekTwoCard.locator('ol')).toBeVisible();
});

test('completed activity deep links can continue or show the session finish screen', async ({
  page,
}) => {
  const [session] = await db
    .insert(studySessions)
    .values({
      userId,
      kind: 'saturday',
      plannedMinutes: 30,
      status: 'active',
      startedAt: new Date('2026-01-03T12:00:00.000Z'),
    })
    .returning();
  if (!session) throw new Error('Could not create session fixture');
  const [paper, nextActivity] = await db
    .insert(sessionActivities)
    .values([
      {
        sessionId: session.id,
        idx: 0,
        kind: 'paper',
        exerciseIds: [],
        plannedMinutes: 10,
        status: 'completed',
      },
      {
        sessionId: session.id,
        idx: 1,
        kind: 'practice',
        conceptId: 'vectors',
        exerciseIds: ['vectors-magnitude'],
        plannedMinutes: 20,
        status: 'planned',
      },
    ])
    .returning();
  if (!paper || !nextActivity) throw new Error('Could not create activity fixtures');

  await page.goto(`/session/${session.id}?activity=${paper.id}`);
  await expect(page.getByRole('status')).toHaveText('Paper reading complete.');
  await expect(page.getByRole('link', { name: 'Continue' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('link', { name: 'Continue' })).toBeVisible();
  await page.getByRole('link', { name: 'Continue' }).click();
  await expect(page).toHaveURL(`/session/${session.id}`);
  await expect(page.getByRole('button', { name: 'Submit answer' })).toBeVisible();

  await db
    .update(sessionActivities)
    .set({ status: 'completed' })
    .where(eq(sessionActivities.id, nextActivity.id));
  await page.goto(`/session/${session.id}?activity=${paper.id}`);
  await expect(page.getByRole('heading', { name: 'Session complete' })).toBeVisible();
});

test('project evidence and reflection survive reloading the project page', async ({ page }) => {
  await page.goto('/projects/linreg-numpy');
  await page.getByLabel('Upload results.json').setInputFiles({
    name: 'results.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        project: 'linreg-numpy',
        version: 1,
        tests: [],
        metrics: { 'validation-mse': 999 },
        generated_at: '2026-01-01T12:00:00.000Z',
      }),
    ),
  });
  const submissionResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      response.url().endsWith('/api/projects/linreg-numpy/results'),
  );
  await page.getByRole('button', { name: 'Upload results', exact: true }).click();
  const response = await submissionResponse;
  const responseBody = await response.json();
  expect(response.status(), JSON.stringify(responseBody)).toBe(201);
  await expect(page.getByRole('heading', { name: 'Project evidence' })).toBeVisible();
  await expect(page.getByText('No verifier tests were reported')).toBeVisible();
  await expect(page.getByText(/Validation MSE \(999\) must be below 0\.3/)).toBeVisible();
  await expect(page.getByText('Complete a gradient update.')).toBeVisible();

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Project evidence' })).toBeVisible();
  await expect(page.getByText('No verifier tests were reported')).toBeVisible();
  await expect(page.getByText(/Validation MSE \(999\) must be below 0\.3/)).toBeVisible();
  await expect(page.getByText('Complete a gradient update.')).toBeVisible();
});

test('failed project uploads update the Course status without a reload', async ({ page }) => {
  await db.insert(projectProgress).values({
    userId,
    projectId: 'linreg-numpy',
    status: 'completed',
    completedAt: new Date('2026-01-01T11:00:00.000Z'),
  });
  await page.goto('/course');
  const project = page.getByRole('region', { name: 'Project' }).first();
  const projectLink = project.getByRole('link', { name: 'Linear regression in NumPy' });
  await expect(projectLink).toContainText('Complete');
  await projectLink.click();
  await expect(page).toHaveURL('/projects/linreg-numpy');
  await page.getByLabel('Upload results.json').setInputFiles({
    name: 'results.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        project: 'linreg-numpy',
        version: 1,
        tests: [],
        metrics: { 'validation-mse': 999 },
        generated_at: '2026-01-01T12:00:00.000Z',
      }),
    ),
  });

  const submissionResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      response.url().endsWith('/api/projects/linreg-numpy/results'),
  );
  await page.getByRole('button', { name: 'Upload results', exact: true }).click();
  const response = await submissionResponse;
  const result = await response.json();
  expect(response.status(), JSON.stringify(result)).toBe(201);
  expect(result.status).toBe('in_progress');

  await page.getByRole('link', { name: 'Course', exact: true }).click();
  await expect(page).toHaveURL('/course');
  const updatedProject = page.getByRole('region', { name: 'Project' }).first();
  await expect(updatedProject).toContainText('In progress');
  await expect(updatedProject).not.toContainText('Complete');
});

test('lab activities show project progress and finish without awarding XP', async ({ page }) => {
  const [session] = await db
    .insert(studySessions)
    .values({
      userId,
      kind: 'weekday',
      plannedMinutes: 20,
      status: 'active',
      startedAt: new Date('2026-01-01T12:00:00.000Z'),
    })
    .returning();
  if (!session) throw new Error('Could not create lab session');
  await db.insert(sessionActivities).values({
    sessionId: session.id,
    idx: 0,
    kind: 'lab',
    projectId: 'linreg-numpy',
    exerciseIds: [],
    plannedMinutes: 20,
    status: 'in_progress',
  });

  await page.goto(`/session/${session.id}`);
  await expect(
    page.getByRole('heading', { name: 'Linear regression in NumPy' }).last(),
  ).toBeVisible();
  await expect(page.getByText('Not started', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open project' })).toHaveAttribute(
    'href',
    '/projects/linreg-numpy',
  );

  await db.insert(projectSubmissions).values({
    userId,
    projectId: 'linreg-numpy',
    results: {
      project: 'linreg-numpy',
      version: 1,
      tests: [{ id: 'test-predict', passed: true, message: 'passed' }],
      metrics: { 'validation-mse': 0.2 },
      generated_at: '2026-01-01T12:00:00.000Z',
    },
    passed: 1,
    total: 1,
    metrics: { 'validation-mse': 0.2 },
  });
  await page.reload();
  await expect(page.getByText('1 of 1 checks passed', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Done for today' }).click();
  await expect(page.getByRole('heading', { name: 'Session complete' })).toBeVisible();
  const sessionData = await page.evaluate(async (sessionId) => {
    const response = await fetch(`/api/sessions/${sessionId}`);
    return response.json() as Promise<{ xp: { session: number } }>;
  }, session.id);
  expect(sessionData.xp.session).toBe(0);
  expect(await db.select().from(xpEvents).where(eq(xpEvents.userId, userId))).toHaveLength(0);
});

test('navigation has four destinations and Lab redirects to Course', async ({ page }) => {
  await page.goto('/');
  const navigationLinks = page.locator('nav a');
  await expect(navigationLinks).toHaveCount(5);
  await expect(navigationLinks).toHaveText(['Home', 'Course', 'Reviews', 'Progress', 'Settings']);

  await page.goto('/lab');
  await expect(page).toHaveURL(/\/course$/);
  await expect(page.getByRole('heading', { name: 'Course', exact: true })).toBeVisible();
});

test('Home offers alternative lessons and starts the selected lesson', async ({ page }) => {
  await markDiagnosticComplete();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  const learn = await page.evaluate(async () => {
    const response = await fetch('/api/learn');
    return response.json() as Promise<{
      choices: Array<{
        conceptId: string;
        title: string;
        xp: number;
        recommended: boolean;
      }>;
    }>;
  });
  expect(learn.choices.length).toBeGreaterThan(1);
  const chosen = learn.choices.find((choice) => !choice.recommended);
  if (!chosen) throw new Error('Expected a non-recommended lesson choice');

  await expect(page.getByRole('heading', { name: 'Or pick a lesson', exact: true })).toBeVisible();
  const choicesList = page
    .getByRole('heading', { name: 'Or pick a lesson', exact: true })
    .locator('..')
    .getByRole('list');
  await expect(choicesList.getByRole('listitem')).toHaveCount(learn.choices.length);
  for (const choice of learn.choices) {
    await expect(choicesList.getByText(choice.title, { exact: true })).toBeVisible();
  }
  const recommended = learn.choices.find((choice) => choice.recommended);
  if (recommended) {
    await expect(
      choicesList
        .getByRole('listitem')
        .filter({ hasText: recommended.title })
        .getByText('Recommended', { exact: true }),
    ).toBeVisible();
  }
  const chosenRow = choicesList.getByRole('listitem').filter({ hasText: chosen.title });
  await expect(chosenRow.getByText(`+${chosen.xp} XP`, { exact: true })).toBeVisible();
  await expect(chosenRow.getByRole('button', { name: 'Start', exact: true })).toBeVisible();
  await page.screenshot({
    path: `${chooseLessonScreenshotDir}/home-desktop.png`,
    fullPage: true,
  });

  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: `${chooseLessonScreenshotDir}/home-mobile.png`,
    fullPage: true,
  });

  await page.setViewportSize({ width: 1280, height: 900 });
  await chosenRow.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page).toHaveURL(/\/session\//);
  await expect(page.getByRole('heading', { name: chosen.title, exact: true })).toBeVisible();
  const sessionId = new URL(page.url()).pathname.split('/').at(-1);
  if (!sessionId) throw new Error('Expected a session id after starting the lesson');
  const session = await page.evaluate(async (id) => {
    const response = await fetch(`/api/sessions/${id}`);
    return response.json() as Promise<{
      activities: Array<{ kind: string; conceptId?: string }>;
    }>;
  }, sessionId);
  expect(
    session.activities.some(
      (activity) => activity.kind === 'learn' && activity.conceptId === chosen.conceptId,
    ),
  ).toBe(true);
  await page.getByRole('link', { name: 'Home', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Resume session', exact: true })).toHaveAttribute(
    'href',
    `/session/${sessionId}`,
  );
});

test('stub projects have no lab link or results form', async ({ page }) => {
  const [session] = await db
    .insert(studySessions)
    .values({
      userId,
      kind: 'saturday',
      plannedMinutes: 120,
      status: 'active',
      startedAt: new Date('2026-01-01T12:00:00.000Z'),
    })
    .returning();
  if (!session) throw new Error('Could not create stub project session');
  await db.insert(sessionActivities).values({
    sessionId: session.id,
    idx: 0,
    kind: 'lab',
    projectId: 'optimization-project',
    exerciseIds: [],
    plannedMinutes: 50,
    status: 'in_progress',
  });

  await page.goto(`/session/${session.id}`);
  await expect(page.getByRole('heading', { name: 'Optimization playground' }).last()).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open project' })).toHaveCount(0);

  await page.goto('/projects/optimization-project');
  await expect(page.getByRole('heading', { name: 'Optimization playground' })).toBeVisible();
  await expect(page.getByText('Coming soon', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Submit results' })).toHaveCount(0);
  await expect(page.getByLabel('Upload results.json')).toHaveCount(0);
});

test('unknown projects show the unavailable route message', async ({ page }) => {
  await page.goto('/projects/unknown-project');
  await expect(page.getByRole('alert')).toHaveText('Project unavailable.');
});

test('available project rows display learner progress', async ({ page }) => {
  await db.insert(projectProgress).values({
    userId,
    projectId: 'linreg-numpy',
    status: 'in_progress',
  });
  await page.goto('/course');
  const project = page.getByRole('region', { name: 'Project' }).first();
  await expect(project.getByRole('link', { name: /Linear regression in NumPy/ })).toContainText(
    'In progress',
  );
});

test('navigation cleanup pages render at desktop and mobile widths', async ({ page }) => {
  await markDiagnosticComplete();
  const duplicateKeyWarnings: string[] = [];
  page.on('console', (message) => {
    if (/same key/i.test(message.text())) duplicateKeyWarnings.push(message.text());
  });
  await page.route('**/api/learn', async (route) => {
    const response = await route.fetch({
      headers: { ...route.request().headers(), 'x-now': '2026-01-01T12:00:00.000Z' },
    });
    const payload = await response.json();
    payload.tasks = [
      {
        id: 'next-up-vectors-practice-first',
        activityKind: 'practice',
        label: 'Practice',
        conceptId: 'vectors',
        title: 'Vectors practice',
        xp: 10,
        prerequisites: [],
      },
      {
        id: 'next-up-vectors-practice-second',
        activityKind: 'practice',
        label: 'Practice',
        conceptId: 'vectors',
        title: 'Vectors practice',
        xp: 10,
        prerequisites: [],
      },
    ];
    payload.doneToday = [
      {
        activityId: 'activity-first-session',
        label: 'Lesson',
        title: 'Vectors',
        xp: 20,
        completedAt: '2026-01-01T10:00:00.000Z',
      },
      {
        activityId: 'activity-second-session',
        label: 'Lesson',
        title: 'Vectors',
        xp: 20,
        completedAt: '2026-01-01T10:00:00.000Z',
      },
      {
        activityId: 'activity-practice',
        label: 'Practice',
        title: 'Dot product practice',
        xp: 10,
        completedAt: '2026-01-01T11:00:00.000Z',
      },
    ];
    await route.fulfill({ response, body: JSON.stringify(payload) });
  });

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  await hideTutorLauncher(page);
  const nextUpCard = page
    .locator('[data-slot="card"]')
    .filter({ has: page.getByRole('heading', { name: 'Next up' }) });
  await expect(nextUpCard.getByRole('heading', { name: 'Vectors practice' })).toHaveCount(2);
  await expect(page.getByRole('heading', { name: 'Done today' })).toBeVisible();
  const doneTodayCard = page
    .locator('[data-slot="card"]')
    .filter({ has: page.getByRole('heading', { name: 'Done today' }) });
  await expect(doneTodayCard.getByText('Vectors', { exact: true }).first()).toBeVisible();
  await expect(doneTodayCard.getByText('Dot product practice', { exact: true })).toBeVisible();
  expect(duplicateKeyWarnings).toEqual([]);
  await page.screenshot({
    path: `${navCleanupScreenshotDir}/home-desktop.png`,
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('[data-slot="card-title"]')).toHaveText([
    'Next up',
    'Done today',
    'Your progress',
  ]);
  await page.screenshot({
    path: `${navCleanupScreenshotDir}/home-mobile.png`,
    fullPage: true,
  });

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/course');
  const weekOneCard = page
    .locator('[data-slot="card"]')
    .filter({ has: page.getByRole('heading', { name: 'Week 1 · ML fundamentals' }) });
  const weekTwoCard = page
    .locator('[data-slot="card"]')
    .filter({ has: page.getByRole('heading', { name: 'Week 2 · Optimization' }) });
  await expect(weekOneCard).toContainText('Linear regression in NumPy');
  await weekTwoCard.getByRole('button', { name: 'Expand week 2' }).click();
  await expect(weekTwoCard).toContainText('Project coming soon');
  await weekOneCard.screenshot({
    path: `${navCleanupScreenshotDir}/course-week-1-desktop.png`,
  });
  await weekTwoCard.screenshot({
    path: `${navCleanupScreenshotDir}/course-week-2-desktop.png`,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await weekOneCard.screenshot({
    path: `${navCleanupScreenshotDir}/course-week-1-mobile.png`,
  });
  await weekTwoCard.screenshot({
    path: `${navCleanupScreenshotDir}/course-week-2-mobile.png`,
  });

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/progress');
  await expect(page.getByRole('heading', { name: 'Mastery by domain' })).toBeVisible();
  await page.screenshot({
    path: `${navCleanupScreenshotDir}/progress-desktop.png`,
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: `${navCleanupScreenshotDir}/progress-mobile.png`,
    fullPage: true,
  });

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/projects/linreg-numpy');
  await expect(page.getByRole('heading', { name: 'Linear regression in NumPy' })).toBeVisible();
  await page.screenshot({
    path: `${navCleanupScreenshotDir}/project-desktop.png`,
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: `${navCleanupScreenshotDir}/project-mobile.png`,
    fullPage: true,
  });
});

test('authored course-structure lessons render their diagrams', async ({ page }) => {
  test.skip(
    process.env.PLAYWRIGHT_CONTENT_DIR !== 'content',
    'requires the repository content directory',
  );
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
    name: 'House rows (12, 3, 20) and (8, 2, 5) are each dotted with weights (25, 10, minus 1) to give prices 310 and 215',
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

  await mockLessonReview(page, 'derivatives', 'Derivatives');
  await page.goto('/lessons/derivatives');
  await hideTutorLauncher(page);
  await expect(page.getByRole('heading', { name: 'Goal', exact: true })).toHaveCount(0);
  await expect(
    page.getByRole('heading', { name: "What you're learning", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('heading', { name: 'What is a derivative?', exact: true }),
  ).toBeVisible();
  const derivativeDiagram = page.getByRole('img', {
    name: 'The curve d equals t squared, the distance in metres a car has driven after t seconds. An orange straight line joins the points at t equals 3 and t equals 4 with slope 7, the average speed over that second. A blue line just touches the curve at t equals 3 with slope 6, the speed at that instant',
  });
  await expect(derivativeDiagram).toBeVisible();
  await derivativeDiagram.evaluate((image) => {
    image.style.width = '800px';
    image.style.maxWidth = 'none';
  });
  await derivativeDiagram.screenshot({
    path: `${courseStructureBatch3ScreenshotDir}/derivatives-kp1.png`,
  });

  await page.setViewportSize({ width: 1440, height: 1000 });
  for (const [conceptId, title, knowledgePointTitle, screenshotName, expectedTexts] of [
    [
      'partial-derivatives',
      'Partial derivatives',
      'Change one input at a time',
      'pd-hold-fixed',
      ['A function with two inputs', 'The definition'],
    ],
    [
      'backpropagation',
      'Backpropagation',
      'Work backwards through a small network',
      'bp-by-hand',
      ['One backward step at a time', 'Worked example'],
    ],
    [
      'chain-rule',
      'Chain rule',
      'Multiply the rates along a chain',
      'cr-rates-multiply',
      [
        'A nudge passing through two steps',
        'The chain rule',
        'How the second rate changes the answer',
      ],
    ],
    [
      'gradient-descent',
      'Gradient descent',
      'Take one step downhill',
      'gd-downhill-update',
      ['One step on a bowl', 'The update rule', 'Worked example'],
    ],
  ] as const) {
    await mockLessonReview(page, conceptId, title);
    await page.goto(`/lessons/${conceptId}`);
    await hideTutorLauncher(page);
    await expect(page.getByRole('heading', { name: 'Goal', exact: true })).toHaveCount(0);
    await expect(
      page.getByRole('heading', { name: "What you're learning", exact: true }),
    ).toHaveCount(0);
    if (conceptId === 'gradient-descent') {
      await expect(
        page.getByRole('heading', { name: 'What is gradient descent?', exact: true }),
      ).toBeVisible();
    }
    const knowledgePoint = page
      .locator('article')
      .filter({ has: page.getByRole('heading', { name: new RegExp(knowledgePointTitle) }) });
    await expect(knowledgePoint).toHaveCount(1);
    const usesWriteLessonLabels = conceptId === 'chain-rule' || conceptId === 'gradient-descent';
    for (const expectedText of expectedTexts) {
      await expect(knowledgePoint).toContainText(expectedText);
    }
    if (usesWriteLessonLabels) {
      await expect(knowledgePoint.locator('figure img[alt]')).toHaveCount(1);
    }
    await expect(knowledgePoint.locator('.katex-error')).toHaveCount(0);
    await knowledgePoint.screenshot({
      path: `${mathLinesScreenshotDir}/${screenshotName}.png`,
    });
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

test('a fresh learner sees Home onboarding without XP', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  await expect(page).toHaveTitle('Open Academy');
  await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Welcome to Open Academy' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Start diagnostic' })).toBeVisible();
  await page.screenshot({
    path: `${brandScreenshotDir}/home-desktop.png`,
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: `${brandScreenshotDir}/home-mobile.png`,
    fullPage: true,
  });
  await page.setViewportSize({ width: 1280, height: 900 });
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
  const weekTwoCard = page
    .locator('[data-slot="card"]')
    .filter({ has: page.getByRole('heading', { name: 'Week 2 · Optimization' }) });
  await weekTwoCard.getByRole('button', { name: 'Expand week 2' }).click();
  const noLessonRow = page.getByRole('listitem').filter({
    has: page.getByText('Matrix products', { exact: true }),
  });
  await expect(noLessonRow).toContainText('Needs Linear algebra for ML · Lesson coming soon');
  await expect(noLessonRow.getByRole('link')).toHaveCount(0);
  await expect(noLessonRow.locator('p.font-medium')).toHaveClass(/text-muted-foreground/);
  await expect(noLessonRow.locator(':scope > div')).not.toHaveClass(/opacity-60/);
  const lessonRow = page
    .getByRole('listitem')
    .filter({ has: page.getByText('Vectors', { exact: true }) });
  await expect(lessonRow.getByRole('link')).toHaveCount(1);
  await expect(lessonRow).not.toContainText('Lesson coming soon');
  const projectSections = page.getByRole('region', { name: 'Project' });
  const weekOneProject = projectSections.first();
  await expect(
    weekOneProject.getByRole('link', { name: 'Linear regression in NumPy' }),
  ).toHaveAttribute('href', '/projects/linreg-numpy');
  const weekTwoProject = projectSections.nth(1);
  const stubProjectTitle = weekTwoProject
    .locator('.text-muted-foreground')
    .filter({ hasText: 'Optimization playground' });
  await expect(stubProjectTitle).toHaveCount(1);
  await expect(weekTwoProject.getByText('Project coming soon', { exact: true })).toBeVisible();
  await expect(weekTwoProject.getByRole('link')).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({
    path: `${courseComingSoonScreenshotDir}/desktop.png`,
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: `${courseComingSoonScreenshotDir}/mobile.png`,
    fullPage: true,
  });
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
  await expect(completedRow).toContainText('Mastery: Familiar');
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
    for (const id of ids) {
      await page.locator(`[id="${problem.exercise.id}-${id}"]`).click();
    }
  } else {
    await page.getByLabel('Your answer').fill(String(answer.answer));
  }
  await page.getByRole('button', { name: 'Submit answer' }).click();
  await expect(page.getByRole('status')).toContainText('Correct');
}

test.describe('learner timezone header', () => {
  test.use({ timezoneId: 'America/Los_Angeles' });

  test('sends the browser timezone with API requests', async ({ page }) => {
    const request = page.waitForRequest((candidate) => candidate.url().endsWith('/api/today'));
    await page.goto('/');
    expect((await request).headers()['x-time-zone']).toBe('America/Los_Angeles');
  });
});
