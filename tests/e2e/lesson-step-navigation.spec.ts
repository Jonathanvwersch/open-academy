import { expect, test } from '@playwright/test';
import { env } from '../../apps/api/src/config.js';
import { createDb } from '../../apps/api/src/db/client.js';
import {
  lessonProblems,
  lessonRuns,
  sessionActivities,
  studySessions,
  users,
} from '../../apps/api/src/db/schema.js';
import { enrollInDefaultCourse } from './course-start.js';

const db = createDb(env.TEST_DATABASE_URL);
let userId = '';

test.beforeEach(async () => {
  await db.delete(users);
  const [user] = await db
    .insert(users)
    .values({
      displayName: 'Lesson step navigation learner',
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

async function createLessonSession({
  stepsPassed,
  explainDone = false,
  explainActive = false,
}: {
  stepsPassed: boolean;
  explainDone?: boolean;
  explainActive?: boolean;
}) {
  const [session] = await db
    .insert(studySessions)
    .values({
      userId,
      status: 'active',
      plannedMinutes: 30,
      startedAt: new Date('2026-01-01T12:00:00Z'),
    })
    .returning();
  if (!session) throw new Error('Could not create session');
  await db.insert(sessionActivities).values({
    sessionId: session.id,
    idx: 0,
    kind: 'learn',
    conceptId: 'vectors',
    exerciseIds: ['vectors-fixture-final'],
    status: 'in_progress',
    plannedMinutes: 30,
    progress: explainDone
      ? {
          lessonRunnerContinued: true,
          finalQuestionContinued: true,
          completedExerciseIds: ['vectors-fixture-final'],
        }
      : explainActive
        ? { lessonRunnerContinued: true, finalQuestionContinued: true }
        : {},
  });
  const [run] = await db
    .insert(lessonRuns)
    .values({ userId, conceptId: 'vectors', status: stepsPassed ? 'quiz' : 'in_progress' })
    .returning();
  if (!run) throw new Error('Could not create run');
  if (stepsPassed) {
    await db.insert(lessonProblems).values(
      [
        {
          point: 'vectors-fixture-1',
          exercises: ['vectors-fixture-1-basics', 'vectors-fixture-practice-1'],
        },
        {
          point: 'vectors-fixture-2',
          exercises: ['vectors-fixture-2-basics', 'vectors-fixture-practice-4'],
        },
      ].flatMap(({ point, exercises }, pointIndex) =>
        exercises.map((exerciseId, index) => ({
          runId: run.id,
          knowledgePointId: point,
          exerciseId,
          round: 1,
          position: index + 1,
          correct: 1,
          answeredAt: new Date(`2026-01-01T12:00:0${pointIndex * 2 + index}Z`),
        })),
      ),
    );
  }
  if (!stepsPassed) {
    await db.insert(lessonProblems).values({
      runId: run.id,
      knowledgePointId: 'vectors-fixture-1',
      exerciseId: 'vectors-fixture-1-basics',
      round: 1,
      position: 1,
    });
  }
  return session.id;
}

test('completed lesson steps can be revisited during Explain it without losing the draft or changing progress', async ({
  page,
}) => {
  const sessionId = await createLessonSession({ stepsPassed: true });
  await page.goto(`/session/${sessionId}`);
  await expect(page.getByTestId('lesson-steps-complete')).toBeVisible();
  await expect(page.getByTestId('lesson-explain-chip')).toHaveAttribute(
    'aria-label',
    'Explain it, current',
  );
  await expect(page.getByTestId('lesson-quiz-chip')).toHaveAttribute(
    'aria-label',
    'Lesson quiz, upcoming',
  );
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByTestId('explain-memory-note')).toHaveCount(0);
  const draft = 'My explanation draft should survive a look at the earlier steps.';
  await page.getByLabel('Your answer').fill(draft);
  const changes: string[] = [];
  page.on('request', (request) => {
    if (request.method() !== 'GET' && request.url().includes('/api/')) changes.push(request.url());
  });
  await page.getByRole('button', { name: 'Step 1 of 2, passed' }).click();
  await expect(page.getByTestId('explain-step-recap')).toBeVisible();
  await expect(page.getByTestId('lesson-step-content')).toContainText(
    'A vector is an ordered list of coordinates',
  );
  await expect(page.getByRole('button', { name: 'Submit answer', exact: true })).toHaveCount(0);
  await page.screenshot({
    path: 'test-results/screenshots/lesson-step-navigation/recap-desktop.png',
  });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.getByRole('button', { name: 'Step 2 of 2, passed' }).click();
  await expect(page.getByTestId('lesson-step-content')).toContainText(
    'Vector operations combine coordinates',
  );
  await page.screenshot({
    path: 'test-results/screenshots/lesson-step-navigation/recap-mobile.png',
  });
  await page.getByRole('button', { name: 'Explain it', exact: true }).click();
  await expect(page.getByLabel('Your answer')).toHaveValue(draft);
  await expect(page.getByLabel('Your answer')).toBeEditable();
  await expect(page.getByTestId('lesson-quiz-chip')).toHaveAttribute(
    'aria-label',
    'Lesson quiz, upcoming',
  );
  await page.getByRole('button', { name: 'Step 1 of 2, passed' }).click();
  await page.getByRole('button', { name: 'Back to Explain it', exact: true }).click();
  await expect(page.getByLabel('Your answer')).toHaveValue(draft);
  expect(changes).toEqual([]);
});

test('lesson step tabs are restored from URL and invalid steps fall back', async ({ page }) => {
  const sessionId = await createLessonSession({ stepsPassed: true, explainActive: true });
  await page.goto(`/session/${sessionId}?step=explain`);
  await expect(page.getByTestId('lesson-explain-chip')).toHaveAttribute(
    'aria-label',
    'Explain it, current',
  );
  await page.getByRole('button', { name: 'Step 1 of 2, passed' }).click();
  await expect(page).toHaveURL(/step=1/);
  await page.reload();
  await expect(page.getByTestId('lesson-step-content')).toContainText(
    'A vector is an ordered list of coordinates',
  );
  await page.goBack();
  await expect(page).toHaveURL(/step=explain/);
  await page.goForward();
  await expect(page).toHaveURL(/step=1/);
  await page.goto(`/session/${sessionId}?step=99`);
  await expect(page).not.toHaveURL(/step=99/);
  await expect(page).toHaveURL(/step=explain/);
});

test('future steps stay unavailable and an active quiz cannot open lesson recaps', async ({
  page,
}) => {
  const sessionId = await createLessonSession({ stepsPassed: false });
  await page.goto(`/session/${sessionId}`);
  await expect(page.getByTestId('lesson-problem')).toBeVisible();
  await expect(page.getByTestId('lesson-step-chip').nth(1).locator('button')).toHaveCount(0);
  await expect(page.getByTestId('lesson-quiz-chip')).toHaveAttribute(
    'aria-label',
    'Lesson quiz, upcoming',
  );
  await db.delete(studySessions);
  await db.delete(lessonRuns);
  const quizSessionId = await createLessonSession({ stepsPassed: true, explainDone: true });
  await page.goto(`/session/${quizSessionId}`);
  await page.getByRole('button', { name: 'Start quiz', exact: true }).click();
  await expect(page.getByTestId('lesson-quiz-question')).toBeVisible();
  await expect(page.getByTestId('lesson-step-chip').locator('button')).toHaveCount(0);
  await expect(page.getByTestId('explain-step-recap')).toHaveCount(0);
});

test('a lesson can open directly on its Explain-it stage', async ({ page }) => {
  const sessionId = await createLessonSession({ stepsPassed: true });
  await page.goto(`/session/${sessionId}?step=explain`);

  await expect(page.getByTestId('lesson-steps-complete')).toBeVisible();
  await expect(page.getByTestId('lesson-explain-chip')).toHaveAttribute(
    'aria-label',
    'Explain it, current',
  );
  await expect(page).toHaveURL(/step=explain/);
});
