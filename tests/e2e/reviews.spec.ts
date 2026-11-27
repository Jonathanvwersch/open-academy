import { instantiateExercise, isTemplate } from '@open-academy/engine/internal/course/templates';
import { newReviewCard } from '@open-academy/engine/internal/memory/fsrs';
import { expect, test } from '@playwright/test';
import { eq } from 'drizzle-orm';
import { env } from '../../apps/api/src/config.js';
import { loadContent } from '../../apps/api/src/content/load.js';
import { createDb } from '../../apps/api/src/db/client.js';
import {
  courseEnrollments,
  reviewCards,
  sessionActivities,
  studySessions,
  users,
} from '../../apps/api/src/db/schema.js';
import { enrollInDefaultCourse } from './course-start.js';

const db = createDb(env.TEST_DATABASE_URL);
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
      displayName: 'Spaced review E2E learner',
      timezone: 'UTC',
      startDate: '2026-01-01',
      prefs: { scheduleMinutes: 60 },
    })
    .returning();
  if (!user) throw new Error('Could not create spaced review learner');
  userId = user.id;
  await enrollInDefaultCourse(db, userId);
  await db.insert(courseEnrollments).values({
    userId,
    courseId: 'fixture-switching-course',
    status: 'active',
    startMethod: 'beginning',
  });
  await db
    .update(users)
    .set({ activeCourseId: 'fixture-switching-course' })
    .where(eq(users.id, userId));
});

test.afterAll(async () => {
  await db.$client.end();
});

async function insertReviewCards() {
  for (const card of [
    {
      conceptId: 'supervised-learning',
      dimension: 'conceptual',
      dueAt: '2026-01-01T00:00:00.000Z',
      reps: 0,
      lapses: 0,
    },
    {
      conceptId: 'supervised-learning',
      dimension: 'math',
      dueAt: '2026-01-01T20:00:00.000Z',
      reps: 1,
      lapses: 0,
    },
    {
      conceptId: 'vectors',
      dimension: 'math',
      dueAt: '2026-01-03T12:00:00.000Z',
      reps: 2,
      lapses: 1,
    },
    {
      conceptId: 'linear-models',
      dimension: 'transfer',
      dueAt: '2026-01-04T12:00:00.000Z',
      reps: 1,
      lapses: 0,
    },
    {
      conceptId: 'loss-functions',
      dimension: 'conceptual',
      dueAt: '2026-01-20T12:00:00.000Z',
      reps: 1,
      lapses: 0,
    },
  ]) {
    const fsrs = newReviewCard(new Date('2026-01-01T12:00:00.000Z'));
    await db.insert(reviewCards).values({
      userId,
      conceptId: card.conceptId,
      dimension: card.dimension,
      fsrs,
      dueAt: new Date(card.dueAt),
      reps: card.reps,
      lapses: card.lapses,
    });
  }
}

function correctAnswerForExercise(
  content: Awaited<ReturnType<typeof loadContent>>,
  exerciseId: string,
): unknown {
  const indexed = content.exercisesById.get(exerciseId);
  if (!indexed) throw new Error(`Missing exercise ${exerciseId}`);
  const exercise = isTemplate(indexed) ? instantiateExercise(indexed, 0).exercise : indexed;
  if (exercise.type === 'mc') {
    const correct = exercise.options.filter((option) => option.correct).map((option) => option.id);
    return exercise.multi ? correct : correct[0];
  }
  if ('answer' in exercise) return exercise.answer;
  if ('accept' in exercise) return exercise.accept[0];
  if (exercise.type === 'explain') {
    return {
      text: exercise.exemplar,
      metCriteria: exercise.rubric.map(({ id }) => id),
    };
  }
  throw new Error(`No test answer for ${exercise.id}`);
}

test('Reviews page shows due and upcoming topics at desktop and mobile widths', async ({
  page,
}) => {
  await insertReviewCards();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/reviews');
  await expect(page.getByRole('heading', { name: 'Reviews' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Due now · 1' })).toBeVisible();
  await expect(page.getByText('Supervised learning').first()).toBeVisible();
  await expect(page.getByText('Concept', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Maths', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: /Later · 1/ })).toBeVisible();
  await expect(page.getByText(/recall|reviewed/i)).toHaveCount(0);
  await expect(
    page.getByRole('group', { name: 'Upcoming reviews for the next seven days' }),
  ).toHaveCount(0);
  await expect(page.locator('#reviews-2026-01-03').getByRole('button')).toHaveAttribute(
    'aria-expanded',
    'false',
  );

  const saturday = page.locator('#reviews-2026-01-03').getByRole('button');
  await saturday.click();
  await expect(page.getByRole('heading', { name: /Fixture course/ }).first()).toBeVisible();
  await page.goto('/reviews');
  await page.locator('#reviews-2026-01-04').getByRole('button').click();
  await expect(page.getByRole('heading', { name: /Fixture course/ }).first()).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/reviews');
  await expect(page.getByRole('heading', { name: 'Due now · 1' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await expect(
    page.getByRole('group', { name: 'Upcoming reviews for the next seven days' }),
  ).toHaveCount(0);

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Home' })).toBeAttached();

  for (const viewport of [
    { width: 1440, height: 900, name: 'desktop' },
    { width: 390, height: 844, name: 'mobile' },
  ]) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto('/courses/fixture-course');
    await expect(page.getByRole('heading', { name: 'Fixture course' })).toBeVisible();
    await page.waitForTimeout(200);
    await page.goto('/reviews');
    let release!: () => void;
    const delayed = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/api/courses/fixture-course', async (route) => {
      await delayed;
      await route.continue();
    });
    const courseNavigation = page.goto('/courses/fixture-course', {
      waitUntil: 'domcontentloaded',
    });
    await expect(page.getByTestId('route-skeleton')).toBeVisible();
    release();
    await courseNavigation;
    await page.unroute('**/api/courses/fixture-course');
  }
});

test('Reviews page notes only due topics omitted from today’s plan', async ({ page }) => {
  await insertReviewCards();
  let plannedReviews = 0;
  await page.route('**/api/today', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        dueReviews: plannedReviews,
        sessionKind: 'weekday',
        activeSessionId: null,
      }),
    }),
  );

  await page.goto('/reviews');
  await expect(page.getByText("Today's plan covers 0 of these. The rest stay due.")).toBeVisible();

  plannedReviews = 1;
  await page.reload();
  await expect(
    page.getByText(/Today's plan covers \d+ of these\. The rest stay due\./),
  ).toHaveCount(0);
});

test('mixed reviews show their topics on Home and beside each session question', async ({
  page,
}, testInfo) => {
  await db
    .update(users)
    .set({ prefs: { scheduleMinutes: 180 } })
    .where(eq(users.id, userId));
  for (const conceptId of ['vectors', 'linear-models']) {
    await db.insert(reviewCards).values({
      userId,
      conceptId,
      dimension: 'math',
      fsrs: newReviewCard(new Date('2026-01-01T12:00:00.000Z')),
      dueAt: new Date('2026-01-01T00:00:00.000Z'),
      reps: 1,
      lapses: 0,
    });
  }

  for (const viewport of [
    { width: 1440, height: 900, name: 'desktop' },
    { width: 390, height: 844, name: 'mobile' },
  ]) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Mixed review' })).toBeVisible();
    await expect(page.getByText(/(?:Vectors, Linear models|Linear models, Vectors)/)).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath(`home-${viewport.name}.png`),
      fullPage: true,
    });
  }

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('button', { name: 'Start learning' }).click();
  await expect(page.getByRole('heading', { name: 'Mixed review' })).toBeVisible();
  await expect(page.getByText(/^From:/)).toBeVisible();
  const sessionId = new URL(page.url()).pathname.split('/').at(-1);
  if (!sessionId) throw new Error('Could not get the session ID');
  const activities = await db
    .select()
    .from(sessionActivities)
    .where(eq(sessionActivities.sessionId, sessionId));
  const reviewActivity = activities.find((activity) => activity.kind === 'review');
  if (!reviewActivity) throw new Error('Could not find the mixed review activity');
  const exerciseIds = reviewActivity.exerciseIds;
  const content = await loadContent('tests/fixtures/content');
  const remainingAnswers = exerciseIds.slice(0, -1).map((exerciseId) => ({
    exerciseId,
    answer: correctAnswerForExercise(content, exerciseId),
  }));
  const lastExercise = content.exercisesById.get(exerciseIds.at(-1) ?? '');
  const lastTopicTitle = lastExercise
    ? content.conceptsById.get(lastExercise.concept)?.title
    : undefined;
  if (!lastTopicTitle) throw new Error('Could not find the last review topic');
  const answerStatuses = await page.evaluate(
    async ({ activityId, answers }) => {
      const statuses: number[] = [];
      for (const { exerciseId, answer } of answers) {
        const response = await fetch('/api/attempts', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ exerciseId, activityId, answer, mode: 'review' }),
        });
        statuses.push(response.status);
      }
      return statuses;
    },
    { activityId: reviewActivity.id, answers: remainingAnswers },
  );
  expect(answerStatuses).toEqual(remainingAnswers.map(() => 200));
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Mixed review' })).toBeVisible();
  await expect(page.getByText(`From: ${lastTopicTitle}`)).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('session-desktop.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: testInfo.outputPath('session-mobile.png'),
    fullPage: true,
  });
});

test('Reviews labels topics due tomorrow as Tomorrow', async ({ page }) => {
  const fsrs = newReviewCard(new Date('2026-01-01T12:00:00.000Z'));
  await db.insert(reviewCards).values({
    userId,
    conceptId: 'derivatives',
    dimension: 'math',
    fsrs,
    dueAt: new Date('2026-01-02T12:00:00.000Z'),
    reps: 0,
    lapses: 0,
  });

  await page.goto('/reviews');

  await expect(page.getByRole('button', { name: 'Tomorrow · 1', exact: true })).toBeVisible();
});

test('a card due later today appears in Due now', async ({ page }) => {
  for (const card of [
    {
      conceptId: 'supervised-learning',
      dimension: 'math',
      dueAt: '2026-01-01T20:00:00.000Z',
    },
    {
      conceptId: 'derivatives',
      dimension: 'math',
      dueAt: '2026-01-02T12:00:00.000Z',
    },
  ]) {
    await db.insert(reviewCards).values({
      userId,
      conceptId: card.conceptId,
      dimension: card.dimension,
      fsrs: newReviewCard(new Date('2026-01-01T12:00:00.000Z')),
      dueAt: new Date(card.dueAt),
      reps: 0,
      lapses: 0,
    });
  }

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/reviews');

  await expect(page.getByText('Due now · 1')).toBeVisible();
  const comingUp = page
    .locator('[data-slot="card"]')
    .filter({ has: page.getByRole('heading', { name: 'Coming up', exact: true }) });
  const groups = comingUp.getByRole('button');
  await expect(groups).toHaveCount(1);
  await expect(groups.nth(0)).toHaveAccessibleName('Tomorrow · 1');
  await page.screenshot({
    path: 'test-results/sidebar-polish-reviews.png',
    animations: 'disabled',
    fullPage: true,
  });
});

test('Reviews empty state explains how topics return', async ({ page }) => {
  await page.goto('/reviews');
  await expect(page.getByText('No reviews yet. Topics you finish come back here.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start reviews' })).toHaveCount(0);
});

test('Start reviews starts a session and navigates to it', async ({ page }) => {
  await insertReviewCards();
  await page.goto('/reviews');
  await page.getByRole('button', { name: 'Start reviews' }).click();
  await expect(page).toHaveURL(/\/session\/[^/]+$/);
});

test('Continue reviews resumes the active session without starting another', async ({ page }) => {
  const [session] = await db
    .insert(studySessions)
    .values({
      userId,
      kind: 'weekday',
      plannedMinutes: 10,
      startedAt: new Date('2026-01-01T12:00:00.000Z'),
      status: 'active',
    })
    .returning();
  if (!session) throw new Error('Could not create active review session');
  await db.insert(sessionActivities).values({
    sessionId: session.id,
    idx: 0,
    kind: 'review',
    conceptId: 'supervised-learning',
    exerciseIds: ['sl-explain-setup'],
    plannedMinutes: 5,
    status: 'in_progress',
  });
  const fsrs = newReviewCard(new Date('2026-01-01T12:00:00.000Z'));
  await db.insert(reviewCards).values({
    userId,
    conceptId: 'supervised-learning',
    dimension: 'conceptual',
    fsrs,
    dueAt: new Date('2026-01-01T00:00:00.000Z'),
    reps: 0,
    lapses: 0,
  });

  const continueLink = page.getByRole('link', { name: 'Continue reviews' });
  await page.goto('/');
  await page.getByRole('link', { name: 'Reviews', exact: true }).click();
  await expect(continueLink).toHaveAttribute('href', `/session/${session.id}`);
  await continueLink.click();
  await expect(page).toHaveURL(`/session/${session.id}`);

  const sessions = await db
    .select({ id: studySessions.id })
    .from(studySessions)
    .where(eq(studySessions.userId, userId));
  expect(sessions).toEqual([{ id: session.id }]);
});

test('review session header shows its label without an activity count', async ({ page }) => {
  const [session] = await db
    .insert(studySessions)
    .values({
      userId,
      kind: 'weekday',
      plannedMinutes: 10,
      startedAt: new Date('2026-01-01T12:00:00.000Z'),
      status: 'active',
    })
    .returning();
  if (!session) throw new Error('Could not create review session');
  await db.insert(sessionActivities).values({
    sessionId: session.id,
    idx: 0,
    kind: 'review',
    conceptId: 'supervised-learning',
    exerciseIds: ['sl-explain-setup'],
    plannedMinutes: 5,
    status: 'in_progress',
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/session/${session.id}`);
  await expect(page.getByRole('heading', { name: 'Supervised learning' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Review' })).toBeVisible();
  await expect(page.getByText(/Activity \d+ of \d+ today/)).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
