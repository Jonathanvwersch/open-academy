import { expect, test } from '@playwright/test';
import { env } from '../../apps/api/src/config.js';
import { createDb } from '../../apps/api/src/db/client.js';
import { sessionActivities, studySessions, users } from '../../apps/api/src/db/schema.js';
import { enrollInDefaultCourse } from './course-start.js';

const db = createDb(env.TEST_DATABASE_URL);
let userId = '';

test.beforeEach(async () => {
  await db.delete(users);
  const [user] = await db
    .insert(users)
    .values({
      displayName: 'Frontend recovery learner',
      timezone: 'UTC',
      startDate: '2026-01-01',
    })
    .returning();
  if (!user) throw new Error('Could not create learner');
  userId = user.id;
  await enrollInDefaultCourse(db, userId);
});

test.afterAll(async () => {
  await db.$client.end();
});

async function createSession(kind: 'learn' | 'practice') {
  const [session] = await db
    .insert(studySessions)
    .values({
      userId,
      status: 'active',
      plannedMinutes: 20,
      startedAt: new Date('2026-01-01T12:00:00Z'),
    })
    .returning();
  if (!session) throw new Error('Could not create session');
  await db.insert(sessionActivities).values({
    sessionId: session.id,
    idx: 0,
    kind,
    status: 'in_progress',
    plannedMinutes: 20,
    conceptId: kind === 'learn' ? 'supervised-learning' : 'vectors',
    exerciseIds: kind === 'learn' ? ['sl-explain-setup'] : ['vectors-magnitude'],
  });
  return session.id;
}

test('an interrupted lesson start shows an error and retries without reloading', async ({
  page,
}) => {
  const id = await createSession('learn');
  const path = '**/api/lessons/supervised-learning/run';
  await page.route(path, (route) =>
    route.request().method() === 'POST' ? route.abort('failed') : route.continue(),
  );
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`/session/${id}`);
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeEnabled();
  await page.screenshot({
    path: 'test-results/screenshots/frontend-recovery/lesson-start-error.png',
  });
  await page.unroute(path);
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByTestId('lesson-problem')).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('a failed hint preserves the question and retries the same hint', async ({ page }) => {
  const id = await createSession('practice');
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`/session/${id}`);
  await page.getByLabel('Your answer').fill('5');
  await page.route('**/api/hints', (route) => route.abort('failed'));
  await page.getByRole('button', { name: 'Hint', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('hint could not load');
  await expect(page.getByLabel('Your answer')).toHaveValue('5');
  await page.unroute('**/api/hints');
  await page.getByRole('button', { name: 'Hint', exact: true }).click();
  await expect(page.getByText('Hint 1', { exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('paper summaries recover from network failure and clear stale saved status after edits', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/papers/fixture-paper-one');
  const summary = page.getByLabel('Paper summary');
  await summary.fill('The paper proposes a method and supports it with evidence.');
  await page.getByRole('button', { name: 'Submit summary', exact: true }).click();
  await expect(page.getByText('Summary saved.', { exact: true })).toBeVisible();
  const revision = 'The revised summary also describes the limitations.';
  await summary.fill(revision);
  await expect(page.getByText('Summary saved.', { exact: true })).toHaveCount(0);
  await page.route('**/api/papers/fixture-paper-one/summary', (route) => route.abort('failed'));
  await page.getByRole('button', { name: 'Submit summary', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Summary could not be saved');
  await expect(summary).toHaveValue(revision);
  await expect(summary).toBeEditable();
  await page.screenshot({
    path: 'test-results/screenshots/frontend-recovery/paper-summary-error.png',
  });
  await page.unroute('**/api/papers/fixture-paper-one/summary');
  await page.getByRole('button', { name: 'Submit summary', exact: true }).click();
  await expect(page.getByText('Summary saved.', { exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('paper notes show failed autosave and can retry the retained text', async ({ page }) => {
  await page.goto('/papers/fixture-paper-one');
  const path = '**/api/papers/fixture-paper-one/progress';
  await page.route(path, (route) =>
    route.request().postDataJSON()?.notes ? route.abort('failed') : route.continue(),
  );
  const note = page.getByLabel('claim note');
  await note.fill('A note that must survive a failed request.');
  await expect(page.getByRole('alert')).toContainText('Note was not saved');
  await page.setViewportSize({ width: 375, height: 812 });
  await page
    .getByRole('button', { name: 'Retry saving note', exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: 'test-results/screenshots/frontend-recovery/paper-note-error-mobile.png',
  });
  await page.unroute(path);
  await page.getByRole('button', { name: 'Retry saving note', exact: true }).click();
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.reload();
  await page.getByRole('button', { name: 'Guide', exact: true }).click();
  await expect(note).toHaveValue('A note that must survive a failed request.');
});

test('reverting a paper note during an older save persists the latest draft', async ({ page }) => {
  await page.goto('/papers/fixture-paper-one');
  const note = page.getByLabel('claim note');
  const original = 'The original saved note.';
  const intermediate = 'An intermediate edit whose save is delayed.';
  await note.fill(original);
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();
  let markRequestStarted = () => {};
  const requestStarted = new Promise<void>((resolve) => {
    markRequestStarted = resolve;
  });
  let releaseRequest = () => {};
  const requestGate = new Promise<void>((resolve) => {
    releaseRequest = resolve;
  });
  const path = '**/api/papers/fixture-paper-one/progress';
  await page.route(path, async (route) => {
    if (route.request().postDataJSON()?.notes?.claim === intermediate) {
      markRequestStarted();
      await requestGate;
    }
    await route.continue();
  });
  await note.fill(intermediate);
  await requestStarted;
  try {
    await note.fill(original);
    await expect(page.getByText('Saved', { exact: true })).toHaveCount(0);
    const latestSave = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/papers/fixture-paper-one/progress') &&
        response.request().postDataJSON()?.notes?.claim === original,
    );
    releaseRequest();
    await latestSave;
    await expect(page.getByText('Saved', { exact: true })).toBeVisible();
    await page.reload();
    await expect(note).toHaveValue(original);
  } finally {
    releaseRequest();
  }
});

test('blocked browser storage still allows navigation and tutor use', async ({ page }) => {
  await page.addInitScript(() => {
    for (const kind of ['localStorage', 'sessionStorage']) {
      Object.defineProperty(window, kind, {
        configurable: true,
        get: () => {
          throw new DOMException('Storage blocked', 'SecurityError');
        },
      });
    }
  });
  await page.route('**/api/tutor/status', (route) =>
    route.fulfill({ json: { tutorEnabled: true } }),
  );
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/courses/fixture-course');
  await expect(page.getByRole('heading', { name: 'Fixture course', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Open tutor', exact: true }).click();
  await expect(page.getByRole('complementary', { name: 'Tutor' })).toBeVisible();
  await page.getByRole('button', { name: 'Close tutor', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open tutor', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
