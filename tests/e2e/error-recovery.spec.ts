import { expect, test } from '@playwright/test';
import { env } from '../../apps/api/src/config.js';
import { createDb } from '../../apps/api/src/db/client.js';
import { sessionActivities, studySessions, users } from '../../apps/api/src/db/schema.js';

const db = createDb(env.TEST_DATABASE_URL);
let userId = '';

test.beforeEach(async () => {
  await db.delete(users);
  const [user] = await db
    .insert(users)
    .values({ displayName: 'Error recovery learner', timezone: 'UTC', startDate: '2026-01-01' })
    .returning();
  if (!user) throw new Error('Could not create learner');
  userId = user.id;
});

test.afterAll(async () => {
  await db.$client.end();
});

async function createSession(kind: 'practice' | 'reflect' | 'paper') {
  const [session] = await db
    .insert(studySessions)
    .values({
      userId,
      kind: kind === 'paper' ? 'saturday' : 'weekday',
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
    ...(kind === 'practice' ? { conceptId: 'vectors', exerciseIds: ['vectors-magnitude'] } : {}),
  });
  return session.id;
}

test('an interrupted answer submission keeps the answer editable and can retry', async ({
  page,
}) => {
  const sessionId = await createSession('practice');
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`/session/${sessionId}`);
  await page.route('**/api/attempts', (route) => route.abort('failed'));
  const answer = page.getByLabel('Your answer');
  await answer.fill('5');
  await page.getByRole('button', { name: 'Submit answer', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('try again');
  await expect(answer).toHaveValue('5');
  await expect(answer).toBeEditable();
  expect(errors).toEqual([]);
  await page.unroute('**/api/attempts');
  await page.getByRole('button', { name: 'Submit answer', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Correct');
  await expect(page.getByRole('alert')).toHaveCount(0);
});

for (const kind of ['reflect', 'paper'] as const) {
  for (const failure of ['server', 'network'] as const) {
    test(`${kind} progress recovers from a ${failure} failure`, async ({ page }) => {
      const sessionId = await createSession(kind);
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(`/session/${sessionId}`);
      const path = `**/api/sessions/${sessionId}/activities/*/progress`;
      await page.route(path, (route) =>
        failure === 'network'
          ? route.abort('failed')
          : route.fulfill({ status: 503, json: { error: 'Unavailable' } }),
      );
      const button = page.getByRole('button', {
        name: kind === 'paper' ? 'Skip for today' : 'Continue',
        exact: true,
      });
      await button.click();
      await expect(page.getByRole('alert')).toContainText('try again');
      await expect(button).toBeEnabled();
      await expect(
        page.getByRole('heading', { name: 'Session complete', exact: true }),
      ).toHaveCount(0);
      expect(errors).toEqual([]);
      await page.unroute(path);
      await button.click();
      await expect(
        page.getByRole('heading', { name: 'Session complete', exact: true }),
      ).toBeVisible();
    });
  }
}

test('an interrupted inline lesson check preserves its answer and can retry', async ({ page }) => {
  const sessionId = await createSession('practice');
  await db.update(sessionActivities).set({ kind: 'learn', progress: {} });
  await page.route('**/api/lessons/vectors', async (route) => {
    const response = await route.fetch();
    const lesson = await response.json();
    await route.fulfill({
      response,
      json: {
        ...lesson,
        knowledge_points: undefined,
        blocks: [{ kind: 'check', exercise: 'vectors-magnitude' }],
      },
    });
  });
  await page.goto(`/session/${sessionId}`);
  await page.route('**/api/attempts', (route) => route.abort('failed'));
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.getByLabel('Your answer').fill('5');
  await page.getByRole('button', { name: 'Submit answer', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('try again');
  await expect(page.getByLabel('Your answer')).toHaveValue('5');
  await expect(page.getByRole('button', { name: 'Continue to practice' })).toBeDisabled();
  expect(errors).toEqual([]);
  await page.unroute('**/api/attempts');
  await page.route('**/api/attempts', (route) =>
    route.fulfill({
      json: { status: 'graded', correct: 1, retryAllowed: false, feedback: 'Correct' },
    }),
  );
  await page.getByRole('button', { name: 'Submit answer', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Continue to practice' })).toBeEnabled();
  await expect(page.getByRole('alert')).toHaveCount(0);
});
