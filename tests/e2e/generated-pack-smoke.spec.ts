import { expect, test } from '@playwright/test';
import { asc, eq } from 'drizzle-orm';
import { env } from '../../apps/api/src/config.js';
import { createDb } from '../../apps/api/src/db/client.js';
import {
  lessonRuns,
  mastery,
  reviewCards,
  sessionActivities,
  studySessions,
  users,
} from '../../apps/api/src/db/schema.js';
import { newReviewCard } from '../../apps/api/src/learning/fsrs.js';

const db = createDb(env.TEST_DATABASE_URL);

async function seedDemoProgress() {
  const [learner] = await db
    .select()
    .from(users)
    .orderBy(asc(users.createdAt), asc(users.id))
    .limit(1);
  if (!learner) throw new Error('The generated-pack smoke requires the seeded learner');
  const startedAt = new Date('2026-01-01T12:00:30.000Z');
  const fsrs = newReviewCard(startedAt);
  await db.update(users).set({ activeCourseId: 'ml-foundations' }).where(eq(users.id, learner.id));
  await db
    .insert(mastery)
    .values({
      userId: learner.id,
      conceptId: 'gradient-descent',
      dimension: 'math',
      state: 'retained',
      evidence: {},
    })
    .onConflictDoUpdate({
      target: [mastery.userId, mastery.conceptId, mastery.dimension],
      set: { state: 'retained' },
    });
  await db
    .insert(reviewCards)
    .values({
      userId: learner.id,
      conceptId: 'gradient-descent',
      dimension: 'math',
      fsrs,
      dueAt: new Date('2025-12-31T12:00:00.000Z'),
    })
    .onConflictDoUpdate({
      target: [reviewCards.userId, reviewCards.conceptId, reviewCards.dimension],
      set: { fsrs, dueAt: new Date('2025-12-31T12:00:00.000Z') },
    });
  await db
    .insert(lessonRuns)
    .values({ userId: learner.id, conceptId: 'gradient-descent', status: 'in_progress' })
    .onConflictDoUpdate({
      target: [lessonRuns.userId, lessonRuns.conceptId],
      set: { status: 'in_progress', completedAt: null, quizPassedAt: null },
    });
  const [session] = await db
    .insert(studySessions)
    .values({
      userId: learner.id,
      kind: 'weekday',
      plannedMinutes: 30,
      startedAt,
      status: 'active',
      plan: {
        courseId: 'ml-foundations',
        activities: [{ conceptId: 'gradient-descent', exerciseIds: ['gd-check-step'] }],
      },
    })
    .returning();
  if (!session) throw new Error('Could not create demo-pack session progress');
  await db.insert(sessionActivities).values({
    sessionId: session.id,
    idx: 0,
    kind: 'learn',
    conceptId: 'gradient-descent',
    exerciseIds: ['gd-check-step'],
    plannedMinutes: 30,
    status: 'in_progress',
    reason: {},
  });
}

test.afterAll(async () => {
  await db.$client.end();
});

test('the app ignores demo-pack progress when loading a generated pack', async ({ page }) => {
  test.skip(
    !process.env.PLAYWRIGHT_CONTENT_DIR,
    'run with pnpm test:e2e:generated-pack to create a temporary course pack',
  );
  const courseTitle = process.env.PACK_SMOKE_COURSE_TITLE ?? 'Generated pack basics';
  await seedDemoProgress();
  const browserErrors: string[] = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });
  page.on('response', (response) => {
    if (response.url().includes('/api/') && response.status() >= 500) {
      browserErrors.push(`${response.status()} ${response.url()}`);
    }
  });

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Choose a course' })).toBeVisible();
  await expect(page.getByRole('heading', { name: courseTitle, exact: true })).toBeVisible();
  await page.goto('/courses/generated-pack-basics');
  await expect(page.getByRole('heading', { name: courseTitle, exact: true })).toBeVisible();
  await page.goto('/reviews');
  await expect(page.getByText('No reviews yet. Topics you finish come back here.')).toBeVisible();
  expect(browserErrors).toEqual([]);
});
