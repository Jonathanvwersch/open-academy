import { mkdirSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { env } from '../../apps/api/src/config.js';
import { createDb } from '../../apps/api/src/db/client.js';
import {
  courseEnrollments,
  diagnosticRuns,
  placementGrants,
  users,
} from '../../apps/api/src/db/schema.js';

const db = createDb(env.TEST_DATABASE_URL);
const screenshots = 'test-results/screenshots/placement-withdrawal';
mkdirSync(screenshots, { recursive: true });
const note = 'Moved back into your plan: you missed a question that depends on it.';

test.beforeEach(async ({ page }) => {
  await page.route('**/api/**', (route) =>
    route.continue({
      headers: { ...route.request().headers(), 'x-now': '2026-01-07T12:00:00.000Z' },
    }),
  );
  await db.delete(users);
});

test.afterAll(async () => {
  await db.$client.end();
});

test('a withdrawn placement topic shows why it moved back into the plan', async ({ page }) => {
  test.skip(process.env.PLAYWRIGHT_CONTENT_DIR === 'content', 'Uses fixture course topics');
  const [user] = await db
    .insert(users)
    .values({
      displayName: 'Withdrawal E2E learner',
      timezone: 'UTC',
      startDate: '2026-01-01',
      activeCourseId: 'fixture-course',
      prefs: { scheduleMinutes: 60 },
    })
    .returning();
  if (!user) throw new Error('Could not create learner');
  await db.insert(courseEnrollments).values({
    userId: user.id,
    courseId: 'fixture-course',
    status: 'active',
    startMethod: 'placement',
  });
  const completedAt = new Date('2026-01-05T12:00:00.000Z');
  const [run] = await db
    .insert(diagnosticRuns)
    .values({
      userId: user.id,
      kind: 'placement',
      status: 'completed',
      state: { courseId: 'fixture-course', answers: [], known: ['vectors'], unknown: [] },
      startedAt: completedAt,
      completedAt,
    })
    .returning();
  if (!run) throw new Error('Could not create placement run');
  await db.insert(placementGrants).values({
    userId: user.id,
    runId: run.id,
    conceptId: 'vectors',
    origin: 'inferred',
    state: 'withdrawn',
    reason: 'direct_failure',
    createdAt: completedAt,
    updatedAt: new Date('2026-01-06T12:00:00.000Z'),
    withdrawnAt: new Date('2026-01-06T12:00:00.000Z'),
  });

  await page.goto('/courses/fixture-course');
  const row = page.getByRole('listitem').filter({ hasText: 'Vectors' }).first();
  await expect(row.getByText(note)).toBeVisible();
  await expect(row.getByText('Placed out')).toHaveCount(0);
  await expect(page.getByText(note)).toHaveCount(1);
  await page.screenshot({ path: `${screenshots}/course-desktop.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(row.getByText(note)).toBeVisible();
  await page.screenshot({ path: `${screenshots}/course-mobile.png`, fullPage: true });
});
