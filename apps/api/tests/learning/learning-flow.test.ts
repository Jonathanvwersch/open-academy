import { and, eq } from 'drizzle-orm';
import { Rating } from 'ts-fsrs';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createApp } from '../../src/app.js';
import { env } from '../../src/config.js';
import { loadContent } from '../../src/content/load.js';
import { instantiateExercise, isTemplate } from '../../src/content/templates.js';
import type { ContentIndex } from '../../src/content/types.js';
import { createDb } from '../../src/db/client.js';
import {
  attempts,
  courseEnrollments,
  hintEvents,
  lessonQuizItems,
  lessonRuns,
  masteryEvents,
  remediationFlags,
  reviewCards,
  reviewLogs,
  sessionActivities,
  studySessions,
  tutorMessages,
  users,
  xpEvents,
} from '../../src/db/schema.js';
import { FakeProvider } from '../../src/features/tutor/provider.js';
import { answerOptionsFor } from '../../src/learning/answer-options.js';
import { newReviewCard, scheduleInitialReview, scheduleReview } from '../../src/learning/fsrs.js';
import { calculateCredit } from '../../src/learning/mastery.js';

const db = createDb(env.TEST_DATABASE_URL);
const userId = '00000000-0000-4000-8000-000000000001';
const now = '2026-01-01T12:00:00.000Z';
let app: ReturnType<typeof createApp>;
let noTutorApp: ReturnType<typeof createApp>;
let content: ContentIndex;

beforeAll(async () => {
  content = await loadContent('tests/fixtures/content');
  app = createApp({ db, content, tutorProvider: new FakeProvider() });
  noTutorApp = createApp({ db, content, tutorProvider: null });
  await db.delete(users);
  await db
    .insert(users)
    .values({
      id: userId,
      displayName: 'Test learner',
      timezone: 'UTC',
      startDate: '2026-01-01',
      prefs: { scheduleMinutes: 60 },
    })
    .onConflictDoUpdate({
      target: users.id,
      set: { displayName: 'Test learner', startDate: '2026-01-01', prefs: { scheduleMinutes: 60 } },
    });
});

afterAll(async () => {
  await db.delete(users).where(eq(users.id, userId));
  await db.$client.end();
});

async function resetLearner(timezone = 'UTC') {
  await db.delete(users).where(eq(users.id, userId));
  await db.insert(users).values({
    id: userId,
    displayName: 'Test learner',
    timezone,
    startDate: '2026-01-01',
    prefs: { scheduleMinutes: 60 },
  });
}

async function enrollDefaultCourse() {
  await db.insert(courseEnrollments).values({
    userId,
    courseId: 'fixture-course',
    status: 'active',
    startMethod: 'beginning',
  });
}

async function createReviewActivity(conceptId: string, exerciseId: string) {
  const [session] = await db
    .insert(studySessions)
    .values({
      userId,
      kind: 'weekday',
      plannedMinutes: 15,
      startedAt: new Date(now),
      status: 'active',
    })
    .returning();
  if (!session) throw new Error('Could not create a review session');
  const [activity] = await db
    .insert(sessionActivities)
    .values({
      sessionId: session.id,
      idx: 0,
      kind: 'review',
      conceptId,
      exerciseIds: [exerciseId],
      plannedMinutes: 5,
      status: 'in_progress',
    })
    .returning();
  if (!activity) throw new Error('Could not create a review activity');
  return activity;
}

async function answerReviewIncorrectly(exerciseId: string, activityId: string) {
  return app.request('/api/attempts', {
    method: 'POST',
    headers: headersAt(now),
    body: JSON.stringify({
      exerciseId,
      activityId,
      answer: 'w+eta*g',
      mode: 'review',
    }),
  });
}

async function createSessionWithPreviousFinalAttempt(attempt: {
  attemptNo: number;
  correct: number;
  feedback: Record<string, unknown>;
}) {
  await resetLearner();
  const finalExerciseId = 'vectors-fixture-final';
  const finalExercise = content.exercisesById.get(finalExerciseId);
  if (!finalExercise) throw new Error('Missing vectors final exercise');
  const [previousSession] = await db
    .insert(studySessions)
    .values({
      userId,
      kind: 'weekday',
      plannedMinutes: 15,
      startedAt: new Date(now),
      endedAt: new Date(now),
      status: 'completed',
    })
    .returning();
  if (!previousSession) throw new Error('Could not create previous final-question session');
  const [previousActivity] = await db
    .insert(sessionActivities)
    .values({
      sessionId: previousSession.id,
      idx: 0,
      kind: 'learn',
      conceptId: 'vectors',
      exerciseIds: [finalExerciseId],
      plannedMinutes: 15,
      status: 'completed',
    })
    .returning();
  if (!previousActivity) throw new Error('Could not create previous final-question activity');
  await db.insert(attempts).values({
    userId,
    sessionId: previousSession.id,
    activityId: previousActivity.id,
    exerciseId: finalExerciseId,
    exerciseVersion: finalExercise.contentVersion,
    conceptId: 'vectors',
    dimension: 'conceptual',
    mode: 'practice',
    answer: { text: 'A vector magnitude is its length.' },
    correct: attempt.correct,
    credit: attempt.correct,
    attemptNo: attempt.attemptNo,
    gradedBy: 'test',
    feedback: attempt.feedback,
    createdAt: new Date(now),
  });

  const response = await app.request('/api/sessions', {
    method: 'POST',
    headers: headersAt(now),
    body: JSON.stringify({ budgetMinutes: 60, focusConceptId: 'vectors' }),
  });
  expect(response.status).toBe(201);
  const session = await response.json();
  const activity = session.activities.find(
    (candidate: { kind: string; conceptId: string }) =>
      candidate.kind === 'learn' && candidate.conceptId === 'vectors',
  );
  if (!activity) throw new Error('Could not find the new vectors learn activity');
  return activity;
}

test('session creation prefills a finalized lesson final question', async () => {
  const activity = await createSessionWithPreviousFinalAttempt({
    attemptNo: 2,
    correct: 1,
    feedback: {},
  });

  expect(activity.progress).toEqual({
    completedExerciseIds: ['vectors-fixture-final'],
    outcomes: { 'vectors-fixture-final': 'correct' },
  });
});

test('session creation leaves a retry-pending lesson final question unprefilled', async () => {
  const activity = await createSessionWithPreviousFinalAttempt({
    attemptNo: 1,
    correct: 0.6,
    feedback: { followUp: true },
  });

  expect(activity.progress).toEqual({});
});

test('attempts rejects empty answers before creating an attempt', async () => {
  await resetLearner();
  const activity = await createReviewActivity('vectors', 'vectors-magnitude');
  const response = await app.request('/api/attempts', {
    method: 'POST',
    headers: headersAt(now),
    body: JSON.stringify({
      exerciseId: 'vectors-magnitude',
      activityId: activity.id,
      answer: ' \t ',
      mode: 'review',
    }),
  });

  expect(response.status).toBe(422);
  expect(await response.json()).toMatchObject({ error: 'Write an answer first.' });
  expect(await db.select().from(attempts).where(eq(attempts.userId, userId))).toHaveLength(0);
});

async function createReviewCard(
  conceptId: string,
  dimension: string,
  dueAt: Date,
  fsrs = newReviewCard(new Date(now)),
) {
  const [card] = await db
    .insert(reviewCards)
    .values({
      userId,
      conceptId,
      dimension,
      fsrs,
      dueAt,
      reps: fsrs.reps,
      lapses: fsrs.lapses,
    })
    .returning();
  if (!card) throw new Error(`Could not create a review card for ${conceptId}/${dimension}`);
  return card;
}

async function createPrerequisiteReviewCards(weakDueAt: Date) {
  const future = new Date('2026-02-01T12:00:00.000Z');
  const oldReview = new Date('2025-12-01T12:00:00.000Z');
  const recentReview = new Date('2025-12-31T12:00:00.000Z');
  const reviewFsrs = (lastReview: Date, stability: number) => ({
    ...scheduleReview(newReviewCard(lastReview), lastReview, Rating.Good, 'UTC', false).card,
    stability,
    due: future,
  });
  const current = await createReviewCard(
    'gradient-descent',
    'math',
    new Date('2025-12-31T00:00:00.000Z'),
  );
  const weakest = await createReviewCard('gradients', 'math', weakDueAt, reviewFsrs(oldReview, 1));
  const stronger = await createReviewCard(
    'loss-functions',
    'math',
    future,
    reviewFsrs(recentReview, 10),
  );
  return { current, weakest, stronger, future };
}

async function submitReviewActivityAgain(activityId: string) {
  const response = await answerReviewIncorrectly('gradient-descent-step', activityId);
  expect(response.status).toBe(200);
  expect((await response.json()).correct).toBe(0);
}

function headersAt(now: string) {
  return { 'content-type': 'application/json', 'X-Now': now };
}

function correctAnswer(exerciseId: string, seed: number | null): unknown {
  const indexed = content.exercisesById.get(exerciseId);
  if (!indexed) throw new Error(`Missing fixture exercise ${exerciseId}`);
  const exercise = isTemplate(indexed) ? instantiateExercise(indexed, seed ?? 0).exercise : indexed;
  if (exercise.type === 'mc') {
    const correct = exercise.options.filter((option) => option.correct).map((option) => option.id);
    return exercise.multi ? correct : correct[0];
  }
  if ('answer' in exercise) return exercise.answer;
  if ('accept' in exercise) return exercise.accept[0];
  throw new Error(`No test answer for ${exercise.id}`);
}

async function startLessonRun(conceptId: string, activityId: string, now: string) {
  const response = await app.request(`/api/lessons/${conceptId}/run`, {
    method: 'POST',
    headers: headersAt(now),
    body: JSON.stringify({ activityId }),
  });
  expect(response.status).toBe(200);
  return (await response.json()).run;
}

async function answerLessonProblem(
  conceptId: string,
  activityId: string,
  pending: { id: string; exerciseId: string; seed: number | null },
  now: string,
) {
  return app.request(`/api/lessons/${conceptId}/run/answer`, {
    method: 'POST',
    headers: headersAt(now),
    body: JSON.stringify({
      problemId: pending.id,
      activityId,
      answer: correctAnswer(pending.exerciseId, pending.seed),
    }),
  });
}

async function passLessonRun(conceptId: string, activityId: string, now: string) {
  let run = await startLessonRun(conceptId, activityId, now);
  for (let count = 0; count < 20 && run.status === 'in_progress'; count += 1) {
    if (!run.pending) run = await startLessonRun(conceptId, activityId, now);
    const pending = run.pending as
      | { id: string; exerciseId: string; seed: number | null }
      | undefined;
    if (!pending) throw new Error('Lesson runner did not provide a pending problem');
    const response = await answerLessonProblem(conceptId, activityId, pending, now);
    expect(response.status).toBe(200);
    run = (await response.json()).state;
  }
  expect(run.status).toBe('quiz');
  const quizStart = await app.request(`/api/lessons/${conceptId}/quiz/start`, {
    method: 'POST',
    headers: headersAt(now),
    body: JSON.stringify({ activityId }),
  });
  expect(quizStart.status).toBe(200);
  const quiz = (await quizStart.json()).run.quiz;
  const items = await db
    .select()
    .from(lessonQuizItems)
    .where(eq(lessonQuizItems.quizAttemptId, quiz.current.attemptId));
  for (const item of items) {
    const response = await app.request(`/api/lessons/${conceptId}/quiz/answer`, {
      method: 'POST',
      headers: headersAt(now),
      body: JSON.stringify({
        activityId,
        itemId: item.id,
        answer: correctAnswer(item.exerciseId, item.seed),
      }),
    });
    expect(response.status).toBe(200);
  }
  const submitted = await app.request(`/api/lessons/${conceptId}/quiz/submit`, {
    method: 'POST',
    headers: headersAt(now),
    body: JSON.stringify({ activityId }),
  });
  expect(submitted.status).toBe(200);
}

async function createLearnActivity(now: string) {
  const [session] = await db
    .insert(studySessions)
    .values({
      userId,
      kind: 'weekday',
      plannedMinutes: 30,
      startedAt: new Date(now),
      status: 'active',
    })
    .returning();
  if (!session) throw new Error('Could not create a lesson-run session');
  const [activity] = await db
    .insert(sessionActivities)
    .values({
      sessionId: session.id,
      idx: 0,
      kind: 'learn',
      conceptId: 'vectors',
      exerciseIds: ['vectors-fixture-final'],
      plannedMinutes: 15,
      status: 'in_progress',
    })
    .returning();
  if (!activity) throw new Error('Could not create a lesson-run activity');
  return { session, activity };
}

test('attempts update mastery and create a review card used by Today', async () => {
  await resetLearner();
  await enrollDefaultCourse();
  const headers = { 'content-type': 'application/json', 'X-Now': now };
  const sessionResponse = await app.request('/api/sessions', {
    method: 'POST',
    headers,
    body: JSON.stringify({ budgetMinutes: 60 }),
  });
  expect(sessionResponse.status).toBe(201);
  const session = await sessionResponse.json();
  const activity = session.activities.find((item: { kind: string }) => item.kind === 'learn');
  expect(activity).toBeDefined();
  const exerciseId = activity.exerciseIds[0] as string;
  expect(exerciseId).toBe('vectors-fixture-final');

  const first = await app.request('/api/attempts', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      exerciseId,
      activityId: activity.id,
      answer: { text: 'I am not sure yet.' },
      mode: 'practice',
    }),
  });
  expect(first.status).toBe(200);
  expect(await first.json()).toMatchObject({ retryAllowed: true });

  const gradedApp = createApp({
    db,
    content,
    tutorProvider: new FakeProvider(undefined, {
      criteria: [{ id: 'length', judgement: 'met', evidence: 'magnitude is length' }],
      feedback_md: 'Good explanation.',
    }),
  });
  const second = await gradedApp.request('/api/attempts', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      exerciseId,
      activityId: activity.id,
      answer: { text: 'A vector magnitude is its length.' },
      mode: 'practice',
    }),
  });
  expect(second.status).toBe(200);
  const result = await second.json();
  expect(result.credit, `${exerciseId}: ${JSON.stringify(result)}`).toBeGreaterThanOrEqual(0.3);

  const today = await app.request('/api/today', {
    headers: { 'X-Now': '2026-01-15T12:00:00.000Z' },
  });
  expect(today.status).toBe(200);
  const payload = await today.json();
  expect(payload.plan.activities.some((item: { kind: string }) => item.kind === 'review')).toBe(
    true,
  );
});

test('practice answers expose selected options and reveal correct ids only after retries end', async () => {
  await resetLearner();
  const [session] = await db
    .insert(studySessions)
    .values({
      userId,
      kind: 'weekday',
      plannedMinutes: 10,
      startedAt: new Date(now),
      status: 'active',
    })
    .returning();
  if (!session) throw new Error('Could not create a practice session');
  const exerciseId = 'linear-algebra-fixture-1-basics';
  const [activity] = await db
    .insert(sessionActivities)
    .values({
      sessionId: session.id,
      idx: 0,
      kind: 'practice',
      conceptId: 'linear-algebra',
      exerciseIds: [exerciseId],
      plannedMinutes: 5,
      status: 'in_progress',
    })
    .returning();
  if (!activity) throw new Error('Could not create a practice activity');
  const exercise = content.exercisesById.get(exerciseId);
  if (exercise?.type !== 'mc') throw new Error('Expected an MC fixture');
  const correctId = exercise.options.find((option) => option.correct)?.id;
  const wrongIds = exercise.options.filter((option) => !option.correct).map((option) => option.id);
  if (!correctId || wrongIds.length < 2) throw new Error('Expected multiple MC options');
  const submit = (answer: string) =>
    app.request('/api/attempts', {
      method: 'POST',
      headers: headersAt(now),
      body: JSON.stringify({ exerciseId, activityId: activity.id, answer, mode: 'practice' }),
    });

  const first = await submit(wrongIds[0] ?? '');
  const firstResult = await first.json();
  expect(firstResult).toMatchObject({
    retryAllowed: true,
    answerOptions: { selected: [wrongIds[0]] },
  });
  expect(firstResult).not.toHaveProperty('solution');
  expect(firstResult.answerOptions).not.toHaveProperty('correct');

  const final = await submit(wrongIds[1] ?? '');
  const finalResult = await final.json();
  expect(finalResult).toMatchObject({
    retryAllowed: false,
    answerOptions: { selected: [wrongIds[1]], correct: [correctId] },
  });

  const sessionResponse = await app.request(`/api/sessions/${session.id}`, {
    headers: headersAt(now),
  });
  const payload = await sessionResponse.json();
  expect(payload.activities[0].lastAttempt.answerOptions).toEqual(finalResult.answerOptions);
});

test('a correct practice answer returns its solution when no retry is pending', async () => {
  await resetLearner();
  const exercise = content.exercisesById.get('vectors-magnitude');
  if (exercise?.type !== 'numeric' || !('answer' in exercise) || !exercise.solution) {
    throw new Error('Expected a numeric practice exercise with a solution');
  }

  const response = await app.request('/api/attempts', {
    method: 'POST',
    headers: headersAt(now),
    body: JSON.stringify({
      exerciseId: exercise.id,
      answer: exercise.answer,
      mode: 'practice',
    }),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    correct: 1,
    retryAllowed: false,
    solution: exercise.solution,
  });
});

test('repeated failures no longer insert remediation flags', async () => {
  await resetLearner();
  for (const exerciseId of ['vectors-magnitude', 'vectors-component-sum']) {
    const response = await app.request('/api/attempts', {
      method: 'POST',
      headers: headersAt(now),
      body: JSON.stringify({ exerciseId, answer: 0, mode: 'practice' }),
    });
    expect(response.status).toBe(200);
    expect((await response.json()).correct).toBe(0);
  }
  expect(
    await db.select().from(remediationFlags).where(eq(remediationFlags.userId, userId)),
  ).toHaveLength(0);
});

test('a review activity schedules its card once after all three answers', async () => {
  await resetLearner();
  const exercises = (content.exercisesByConcept.get('vectors') ?? [])
    .filter(
      (exercise) =>
        exercise.dimension === 'math' &&
        ['review', 'core', 'practice', 'transfer', 'basics'].includes(exercise.role) &&
        !isTemplate(exercise),
    )
    .slice(0, 3);
  expect(exercises).toHaveLength(3);
  const card = newReviewCard(new Date(now));
  const [session] = await db
    .insert(studySessions)
    .values({
      userId,
      kind: 'weekday',
      plannedMinutes: 15,
      startedAt: new Date(now),
      status: 'active',
    })
    .returning();
  if (!session) throw new Error('Could not create a review session');
  const [activity] = await db
    .insert(sessionActivities)
    .values({
      sessionId: session.id,
      idx: 0,
      kind: 'review',
      conceptId: 'vectors',
      exerciseIds: exercises.map((exercise) => exercise.id),
      plannedMinutes: 9,
      status: 'in_progress',
    })
    .returning();
  if (!activity) throw new Error('Could not create a review activity');
  const [storedCard] = await db
    .insert(reviewCards)
    .values({
      userId,
      conceptId: 'vectors',
      dimension: 'math',
      fsrs: card,
      dueAt: new Date('2026-01-01T00:00:00.000Z'),
      reps: card.reps,
      lapses: card.lapses,
    })
    .returning();
  if (!storedCard) throw new Error('Could not create a review card');

  let finalAttemptId = '';
  for (let index = 0; index < exercises.length; index += 1) {
    const exercise = exercises[index];
    if (!exercise) throw new Error('Missing review exercise');
    const response = await app.request('/api/attempts', {
      method: 'POST',
      headers: headersAt(now),
      body: JSON.stringify({
        exerciseId: exercise.id,
        activityId: activity.id,
        answer: correctAnswer(exercise.id, null),
        mode: 'review',
      }),
    });
    expect(response.status).toBe(200);
    const result = await response.json();
    finalAttemptId = result.attemptId;
    expect(
      await db.select().from(reviewLogs).where(eq(reviewLogs.cardId, storedCard.id)),
    ).toHaveLength(index === exercises.length - 1 ? 1 : 0);
  }
  const finalAttempt = exercises[exercises.length - 1];
  if (!finalAttempt) throw new Error('Missing final review exercise');
  const replay = await app.request('/api/attempts', {
    method: 'POST',
    headers: headersAt(now),
    body: JSON.stringify({
      exerciseId: finalAttempt.id,
      activityId: activity.id,
      answer: correctAnswer(finalAttempt.id, null),
      mode: 'review',
    }),
  });
  expect(replay.status).toBe(409);
  const logs = await db.select().from(reviewLogs).where(eq(reviewLogs.cardId, storedCard.id));
  expect(logs).toHaveLength(1);
  expect(logs[0]?.rating).toBe(String(Rating.Good));
  expect(logs[0]?.attemptId).toBe(finalAttemptId);
});

test('two consecutive Again review activities pull the weakest hard-prerequisite card due now', async () => {
  await resetLearner();
  const { current, weakest, stronger, future } = await createPrerequisiteReviewCards(
    new Date('2026-02-01T12:00:00.000Z'),
  );
  const firstActivity = await createReviewActivity('gradient-descent', 'gradient-descent-step');
  const secondActivity = await createReviewActivity('gradient-descent', 'gradient-descent-step');

  await submitReviewActivityAgain(firstActivity.id);
  await submitReviewActivityAgain(secondActivity.id);

  const logs = await db.select().from(reviewLogs).where(eq(reviewLogs.cardId, current.id));
  expect(logs).toHaveLength(2);
  expect(logs.map((log) => log.rating)).toEqual([String(Rating.Again), String(Rating.Again)]);
  const [rescheduled] = await db.select().from(reviewCards).where(eq(reviewCards.id, weakest.id));
  const [unchanged] = await db.select().from(reviewCards).where(eq(reviewCards.id, stronger.id));
  if (!rescheduled || !unchanged) throw new Error('Expected prerequisite review cards');
  expect(rescheduled.dueAt.toISOString()).toBe(now);
  expect(new Date((rescheduled.fsrs as { due: string }).due).toISOString()).toBe(now);
  expect(unchanged.dueAt).toEqual(future);
  expect(new Date((unchanged.fsrs as { due: string }).due)).toEqual(future);
});

test('one Again review activity does not pull a prerequisite card due', async () => {
  await resetLearner();
  const { weakest, stronger, future } = await createPrerequisiteReviewCards(
    new Date('2026-02-01T12:00:00.000Z'),
  );
  const activity = await createReviewActivity('gradient-descent', 'gradient-descent-step');

  await submitReviewActivityAgain(activity.id);

  const [weakestAfter] = await db.select().from(reviewCards).where(eq(reviewCards.id, weakest.id));
  const [strongerAfter] = await db
    .select()
    .from(reviewCards)
    .where(eq(reviewCards.id, stronger.id));
  if (!weakestAfter || !strongerAfter) throw new Error('Expected prerequisite review cards');
  expect(weakestAfter.dueAt).toEqual(future);
  expect(new Date((weakestAfter.fsrs as { due: string }).due)).toEqual(future);
  expect(strongerAfter.dueAt).toEqual(future);
});

test('a weakest prerequisite card that is already due remains unchanged', async () => {
  await resetLearner();
  const dueAt = new Date('2025-12-31T12:00:00.000Z');
  const { weakest, stronger, future } = await createPrerequisiteReviewCards(dueAt);
  const activity1 = await createReviewActivity('gradient-descent', 'gradient-descent-step');
  const activity2 = await createReviewActivity('gradient-descent', 'gradient-descent-step');

  await submitReviewActivityAgain(activity1.id);
  await submitReviewActivityAgain(activity2.id);

  const [weakestAfter] = await db.select().from(reviewCards).where(eq(reviewCards.id, weakest.id));
  const [strongerAfter] = await db
    .select()
    .from(reviewCards)
    .where(eq(reviewCards.id, stronger.id));
  if (!weakestAfter || !strongerAfter) throw new Error('Expected prerequisite review cards');
  expect(weakestAfter.dueAt).toEqual(dueAt);
  expect(new Date((weakestAfter.fsrs as { due: string }).due)).toEqual(future);
  expect(strongerAfter.dueAt).toEqual(future);
});

test('/api/reviews returns the local upcoming schedule and skips stub topics', async () => {
  await resetLearner();
  const dueCard = newReviewCard(new Date(now));
  await db.insert(reviewCards).values({
    userId,
    conceptId: 'vectors',
    dimension: 'math',
    fsrs: dueCard,
    dueAt: new Date('2026-01-01T00:00:00.000Z'),
    reps: dueCard.reps,
    lapses: dueCard.lapses,
  });
  const otherConcept = content.concepts.find(
    (concept) => concept.id !== 'vectors' && concept.status !== 'stub',
  );
  if (!otherConcept) throw new Error('Expected another authored concept for review topics');
  const laterTodayConcept = content.concepts.find(
    (concept) =>
      concept.id !== 'vectors' && concept.id !== otherConcept.id && concept.status !== 'stub',
  );
  if (!laterTodayConcept) throw new Error('Expected a third authored concept for review topics');
  const secondVectorsCard = newReviewCard(new Date(now));
  await db.insert(reviewCards).values({
    userId,
    conceptId: 'vectors',
    dimension: 'conceptual',
    fsrs: secondVectorsCard,
    dueAt: new Date('2026-01-01T00:00:00.000Z'),
    reps: secondVectorsCard.reps,
    lapses: secondVectorsCard.lapses,
  });
  const futureCard = newReviewCard(new Date(now));
  await db.insert(reviewCards).values({
    userId,
    conceptId: otherConcept.id,
    dimension: 'conceptual',
    fsrs: futureCard,
    dueAt: new Date('2026-01-03T12:00:00.000Z'),
    reps: 2,
    lapses: 1,
  });
  const laterTodayCard = newReviewCard(new Date(now));
  await db.insert(reviewCards).values({
    userId,
    conceptId: laterTodayConcept.id,
    dimension: 'implementation',
    fsrs: laterTodayCard,
    dueAt: new Date('2026-01-01T20:00:00.000Z'),
    reps: 1,
    lapses: 0,
  });
  const stub = content.concepts.find((concept) => concept.status === 'stub');
  if (stub) {
    const stubCard = newReviewCard(new Date(now));
    await db.insert(reviewCards).values({
      userId,
      conceptId: stub.id,
      dimension: 'conceptual',
      fsrs: stubCard,
      dueAt: new Date('2026-01-01T00:00:00.000Z'),
      reps: 0,
      lapses: 0,
    });
  }

  const response = await app.request('/api/reviews', { headers: headersAt(now) });
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.dueNow).toBe(1);
  expect(body.upcoming).toHaveLength(7);
  expect(body.upcoming.map((day: { date: string }) => day.date)).toEqual([
    '2026-01-02',
    '2026-01-03',
    '2026-01-04',
    '2026-01-05',
    '2026-01-06',
    '2026-01-07',
    '2026-01-08',
  ]);
  expect(body.upcoming[1]).toEqual({ date: '2026-01-03', count: 1 });
  expect(body.topics).toHaveLength(3);
  expect(body.topics[0]).toMatchObject({
    conceptId: 'vectors',
    title: expect.any(String),
    courseId: expect.any(String),
    courseTitle: expect.any(String),
    kinds: ['conceptual', 'math'],
    dueAt: '2026-01-01T00:00:00.000Z',
    due: true,
    dueInDays: 0,
  });
  expect(body.topics[1]).toMatchObject({ due: false, dueInDays: 0 });
  expect(body.topics[2]).toMatchObject({ due: false, dueInDays: 2 });
  expect(body.topics[0]).not.toHaveProperty('recall');
  expect(body.topics[0]).not.toHaveProperty('reps');
});

test('debug answer option ids identify the selected and correct line and fix', () => {
  const exercise = content.exercisesById.get('linear-algebra-debug');
  if (exercise?.type !== 'debug') throw new Error('Expected a debug fixture');
  expect(answerOptionsFor(exercise, { line: 1, fixId: 'concatenate' }, false)).toEqual({
    selected: ['line:1', 'fix:concatenate'],
  });
  expect(answerOptionsFor(exercise, { line: 3, fixId: 'dot-product' }, true)).toEqual({
    selected: ['line:3', 'fix:dot-product'],
    correct: ['line:3', 'fix:dot-product'],
  });
});

test('unscoped hints lower credit and restart after the previous attempt', async () => {
  const exerciseId = 'linear-algebra-code-complete';
  const hint = await app.request('/api/hints', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Now': '2026-01-02T12:00:00.000Z' },
    body: JSON.stringify({ exerciseId }),
  });
  expect(hint.status).toBe(200);
  expect((await hint.json()).text).toContain('operation that sums pairwise products');

  const firstAttempt = await app.request('/api/attempts', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Now': '2026-01-02T12:01:00.000Z' },
    body: JSON.stringify({ exerciseId, answer: '@', mode: 'practice' }),
  });
  expect(firstAttempt.status).toBe(200);
  expect(await firstAttempt.json()).toMatchObject({ hintsUsed: 1, credit: 0.7 });

  const nextHint = await app.request('/api/hints', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Now': '2026-01-02T12:02:00.000Z' },
    body: JSON.stringify({ exerciseId }),
  });
  expect(nextHint.status).toBe(200);
  expect(await nextHint.json()).toMatchObject({ level: 1 });
});

test('session practice counts only tutor messages newer than the previous attempt', async () => {
  await resetLearner();
  const exercise = content.exercisesById.get('vectors-magnitude');
  if (exercise?.type !== 'numeric' || !('answer' in exercise)) {
    throw new Error('Expected a numeric vector exercise');
  }
  const createPracticeActivity = async () => {
    const [session] = await db
      .insert(studySessions)
      .values({
        userId,
        kind: 'weekday',
        plannedMinutes: 15,
        startedAt: new Date(now),
        status: 'active',
      })
      .returning();
    if (!session) throw new Error('Could not create a practice session');
    const [activity] = await db
      .insert(sessionActivities)
      .values({
        sessionId: session.id,
        idx: 0,
        kind: 'practice',
        conceptId: 'vectors',
        exerciseIds: [exercise.id],
        plannedMinutes: 5,
        status: 'in_progress',
      })
      .returning();
    if (!activity) throw new Error('Could not create a practice activity');
    return { session, activity };
  };
  const addTutorMessage = async (activityId: string, createdAt: string) => {
    await db.insert(tutorMessages).values({
      userId,
      activityId,
      exerciseId: exercise.id,
      role: 'user',
      content: 'Can you help me think this through?',
      createdAt: new Date(createdAt),
    });
  };
  const addPreviousAttempt = async (activityId: string, sessionId: string, createdAt: string) => {
    await db.insert(attempts).values({
      userId,
      sessionId,
      activityId,
      exerciseId: exercise.id,
      exerciseVersion: exercise.contentVersion,
      conceptId: exercise.concept,
      dimension: exercise.dimension,
      mode: 'practice',
      answer: exercise.answer,
      correct: 0,
      credit: 0,
      hintsUsed: 0,
      attemptNo: 1,
      gradedBy: 'deterministic',
      feedback: {},
      createdAt: new Date(createdAt),
    });
  };
  const answer = async (activityId: string, at: string) =>
    app.request('/api/attempts', {
      method: 'POST',
      headers: headersAt(at),
      body: JSON.stringify({
        exerciseId: exercise.id,
        activityId,
        answer: exercise.answer,
        mode: 'practice',
      }),
    });

  const first = await createPracticeActivity();
  await addTutorMessage(first.activity.id, '2026-01-01T12:00:00.001Z');
  const firstResponse = await answer(first.activity.id, '2026-01-01T12:00:01.000Z');
  expect(firstResponse.status).toBe(200);
  expect(await firstResponse.json()).toMatchObject({ hintsUsed: 1 });

  const stale = await createPracticeActivity();
  await addTutorMessage(stale.activity.id, '2026-01-01T12:00:00.001Z');
  await addPreviousAttempt(stale.activity.id, stale.session.id, '2026-01-01T12:00:00.002Z');
  const staleResponse = await answer(stale.activity.id, '2026-01-01T12:00:01.000Z');
  expect(staleResponse.status).toBe(200);
  expect(await staleResponse.json()).toMatchObject({ hintsUsed: 0 });

  const recent = await createPracticeActivity();
  await addPreviousAttempt(recent.activity.id, recent.session.id, '2026-01-01T12:00:00.001Z');
  await addTutorMessage(recent.activity.id, '2026-01-01T12:00:00.002Z');
  const recentResponse = await answer(recent.activity.id, '2026-01-01T12:00:01.000Z');
  expect(recentResponse.status).toBe(200);
  const recentBody = await recentResponse.json();
  expect(recentBody.hintsUsed).toBeGreaterThanOrEqual(1);
  const [recentAttempt] = await db
    .select()
    .from(attempts)
    .where(eq(attempts.id, recentBody.attemptId));
  expect(recentAttempt?.hintsUsed).toBeGreaterThanOrEqual(1);
});

test('tutor hints without authored hints reduce credit; explicit solution reveal is final', async () => {
  const fixture = await loadContent('tests/fixtures/content');
  const exercise = fixture.exercisesById.get('vectors-magnitude');
  if (exercise?.type !== 'numeric' || !('answer' in exercise)) {
    throw new Error('Missing hint-free numeric item');
  }
  const appExercise = content.exercisesById.get(exercise.id);
  if (appExercise?.type !== 'numeric' || !('answer' in appExercise)) {
    throw new Error('Missing app numeric item');
  }
  content.exercisesById.set(exercise.id, { ...appExercise, hints: [] });

  const unavailable = await app.request('/api/hints', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Now': '2026-01-03T12:00:00.000Z' },
    body: JSON.stringify({ exerciseId: exercise.id }),
  });
  expect(await unavailable.json()).toMatchObject({ level: 1 });

  const unassisted = await app.request('/api/attempts', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Now': '2026-01-03T12:01:00.000Z' },
    body: JSON.stringify({ exerciseId: exercise.id, answer: exercise.answer, mode: 'practice' }),
  });
  expect(await unassisted.json()).toMatchObject({ hintsUsed: 1, credit: 0.7 });

  const solution = await app.request('/api/hints', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Now': '2026-01-04T12:00:00.000Z' },
    body: JSON.stringify({ exerciseId: exercise.id, revealSolution: true }),
  });
  expect(await solution.json()).toMatchObject({ level: 5, revealedSolution: true });
  const assisted = await app.request('/api/attempts', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Now': '2026-01-04T12:01:00.000Z' },
    body: JSON.stringify({ exerciseId: exercise.id, answer: exercise.answer, mode: 'practice' }),
  });
  expect(await assisted.json()).toMatchObject({ hintsUsed: 5, credit: 0.1 });
});

test('null tutor keeps authored hints, disables chat, and reports tutor availability', async () => {
  await db.delete(hintEvents).where(eq(hintEvents.userId, userId));
  const today = await noTutorApp.request('/api/today');
  expect(await today.json()).toMatchObject({ tutorEnabled: false });

  const exercise = content.exercisesById.get('linear-algebra-code-complete');
  if (!exercise) throw new Error('Missing authored-hint exercise');
  const hint = await noTutorApp.request('/api/hints', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Now': '2026-02-01T12:00:00.000Z' },
    body: JSON.stringify({ exerciseId: exercise.id }),
  });
  const hintBody = await hint.json();
  expect(hintBody).toMatchObject({
    level: 1,
    text: exercise.hints[0],
    hasMore: exercise.hints.length > 1,
  });

  const chat = await noTutorApp.request('/api/tutor/threads', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question: 'Can you explain this?' }),
  });
  expect(chat.status).toBe(503);
});

test('partial explain answers get one follow-up before the exemplar and activity completion', async () => {
  await resetLearner();
  const exercise = content.exercisesById.get('sl-explain-setup');
  if (exercise?.type !== 'explain') throw new Error('Missing explain exercise');
  const judgement = {
    criteria: [
      { id: 'r1', judgement: 'met' as const, evidence: 'inputs and target' },
      { id: 'r2', judgement: 'partial' as const, evidence: 'loss' },
      { id: 'r3', judgement: 'missing' as const, evidence: null },
    ],
    feedback_md: 'Good start.',
  };
  const partialApp = createApp({
    db,
    content,
    tutorProvider: new FakeProvider(undefined, judgement),
  });
  const completeApp = createApp({
    db,
    content,
    tutorProvider: new FakeProvider(undefined, {
      criteria: exercise.rubric.map(({ id }) => ({
        id,
        judgement: 'met' as const,
        evidence: 'all criteria met',
      })),
      feedback_md: 'Complete explanation.',
    }),
  });
  const [session] = await db
    .insert(studySessions)
    .values({ userId, plannedMinutes: 15, status: 'active', kind: 'weekday' })
    .returning();
  if (!session) throw new Error('Could not create a session fixture');
  const [activity] = await db
    .insert(sessionActivities)
    .values({
      sessionId: session.id,
      idx: 0,
      kind: 'practice',
      conceptId: exercise.concept,
      exerciseIds: [exercise.id],
      plannedMinutes: 5,
      status: 'in_progress',
    })
    .returning();
  if (!activity) throw new Error('Could not create an activity fixture');
  const [nextActivity] = await db
    .insert(sessionActivities)
    .values({
      sessionId: session.id,
      idx: 1,
      kind: 'practice',
      conceptId: exercise.concept,
      exerciseIds: [exercise.id],
      plannedMinutes: 5,
      status: 'planned',
    })
    .returning();
  if (!nextActivity) throw new Error('Could not create the next activity fixture');

  const firstResponse = await partialApp.request('/api/attempts', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Now': now },
    body: JSON.stringify({
      exerciseId: exercise.id,
      activityId: activity.id,
      answer: { text: 'Inputs, target, model, loss and data.' },
      mode: 'practice',
    }),
  });
  expect(firstResponse.status).toBe(200);
  const firstBody = await firstResponse.json();
  expect(firstBody).toMatchObject({
    correct: 0.75,
    graded_by: 'llm',
    feedback: 'Good start.',
    retryAllowed: true,
    followUp: true,
    credit: 0,
    rubric: [
      { id: 'r1', judgement: 'met' },
      { id: 'r2', judgement: 'partial' },
      { id: 'r3', judgement: 'missing' },
    ],
  });
  expect(firstBody).not.toHaveProperty('exemplar');
  expect(firstBody).not.toHaveProperty('solution');
  expect(firstBody.mastery.credit).toBe(0);

  const reloaded = await partialApp.request(`/api/sessions/${session.id}`);
  const sessionBody = await reloaded.json();
  expect(sessionBody.activities[0].lastAttempt).toMatchObject({
    exerciseId: exercise.id,
    followUp: true,
    retryAllowed: true,
    yourAnswer: 'Inputs, target, model, loss and data.',
    rubric: firstBody.rubric,
  });
  expect(sessionBody.activities[0].lastAttempt).not.toHaveProperty('exemplar');
  expect(sessionBody.activities[0].lastAttempt).not.toHaveProperty('solution');
  const activityStates = await db
    .select({ id: sessionActivities.id, status: sessionActivities.status })
    .from(sessionActivities)
    .where(eq(sessionActivities.sessionId, session.id))
    .orderBy(sessionActivities.idx);
  expect(activityStates.map((item) => item.status)).toEqual(['in_progress', 'planned']);

  const finalResponse = await completeApp.request('/api/attempts', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Now': now },
    body: JSON.stringify({
      exerciseId: exercise.id,
      activityId: activity.id,
      answer: { text: 'Inputs, target, model, loss and data.' },
      mode: 'practice',
    }),
  });
  expect(finalResponse.status).toBe(200);
  const finalBody = await finalResponse.json();
  expect(finalBody).toMatchObject({
    correct: 1,
    attemptNo: 2,
    retryAllowed: false,
    exemplar: exercise.exemplar,
    credit: 0.5,
  });
  expect(finalBody).not.toHaveProperty('followUp');
  expect(finalBody).not.toHaveProperty('solution');
  expect(firstBody.credit + finalBody.credit).toBe(
    calculateCredit({ correct: 1, hintsUsed: 0, attemptNo: 1, gradedBy: 'llm' }),
  );
  const completedStates = await db
    .select({ id: sessionActivities.id, status: sessionActivities.status })
    .from(sessionActivities)
    .where(eq(sessionActivities.sessionId, session.id))
    .orderBy(sessionActivities.idx);
  expect(completedStates.map((item) => item.status)).toEqual(['completed', 'in_progress']);

  const activityXp = await db
    .select()
    .from(xpEvents)
    .where(eq(xpEvents.sourceKey, `activity:${activity.id}`));
  expect(activityXp).toHaveLength(1);
  expect(activityXp[0]?.amount).toBe(4);

  const thirdResponse = await completeApp.request('/api/attempts', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Now': now },
    body: JSON.stringify({
      exerciseId: exercise.id,
      activityId: activity.id,
      answer: { text: 'A further explanation.' },
      mode: 'practice',
    }),
  });
  expect(thirdResponse.status).toBe(409);
  expect(await thirdResponse.json()).toMatchObject({ error: 'No retries remain.' });
});

test('review mode partial explain answers get one retry before card rating and completion', async () => {
  await resetLearner();
  const exercise = content.exercisesById.get('sl-explain-setup');
  if (exercise?.type !== 'explain') throw new Error('Missing explain exercise');
  const partialApp = createApp({
    db,
    content,
    tutorProvider: new FakeProvider(undefined, {
      criteria: [
        { id: 'r1', judgement: 'met', evidence: 'inputs and target' },
        { id: 'r2', judgement: 'partial', evidence: 'loss' },
        { id: 'r3', judgement: 'missing', evidence: null },
      ],
      feedback_md: 'Good start.',
    }),
  });
  const [session] = await db
    .insert(studySessions)
    .values({ userId, plannedMinutes: 15, status: 'active', kind: 'weekday' })
    .returning();
  if (!session) throw new Error('Could not create a session fixture');
  const [activity] = await db
    .insert(sessionActivities)
    .values({
      sessionId: session.id,
      idx: 0,
      kind: 'review',
      conceptId: exercise.concept,
      exerciseIds: [exercise.id],
      plannedMinutes: 5,
      status: 'in_progress',
    })
    .returning();
  if (!activity) throw new Error('Could not create a review activity fixture');
  const card = await createReviewCard(exercise.concept, exercise.dimension, new Date(now));

  const response = await partialApp.request('/api/attempts', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Now': now },
    body: JSON.stringify({
      exerciseId: exercise.id,
      activityId: activity.id,
      answer: { text: 'A partial explanation.' },
      mode: 'review',
    }),
  });
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body).toMatchObject({
    correct: 0.75,
    graded_by: 'llm',
    feedback: 'Good start.',
    retryAllowed: true,
    followUp: true,
    activityCompleted: false,
  });
  expect(body).not.toHaveProperty('exemplar');
  expect(body).not.toHaveProperty('solution');
  expect(await db.select().from(reviewLogs).where(eq(reviewLogs.cardId, card.id))).toHaveLength(0);
  const cardBeforeRetry = await db.select().from(reviewCards).where(eq(reviewCards.id, card.id));
  expect(cardBeforeRetry[0]?.dueAt).toEqual(card.dueAt);
  expect(cardBeforeRetry[0]?.reps).toBe(card.reps);
  const activityBeforeRetry = await db
    .select()
    .from(sessionActivities)
    .where(eq(sessionActivities.id, activity.id));
  expect(activityBeforeRetry[0]?.status).toBe('in_progress');
  expect(activityBeforeRetry[0]?.progress).toEqual(activity.progress);
  const replay = await partialApp.request(`/api/sessions/${session.id}`);
  const replayBody = await replay.json();
  expect(replayBody.activities[0].lastAttempt).toMatchObject({
    followUp: true,
    retryAllowed: true,
    yourAnswer: 'A partial explanation.',
    rubric: body.rubric,
  });
  const [storedAttempt] = await db
    .select()
    .from(attempts)
    .where(eq(attempts.id, body.attemptId))
    .limit(1);
  if (!storedAttempt) throw new Error('Could not load the stored explain attempt');
  const storedFeedback = storedAttempt.feedback as Record<string, unknown>;
  const storedRubric = storedFeedback.rubric as Array<Record<string, unknown>>;
  expect(storedRubric).toEqual(body.rubric);
  const legacyRubric = storedRubric.map(({ required: _required, ...item }) => item);
  await db
    .update(attempts)
    .set({ feedback: { ...storedFeedback, rubric: legacyRubric } })
    .where(eq(attempts.id, body.attemptId));
  const legacyReplay = await partialApp.request(`/api/sessions/${session.id}`);
  const legacyReplayBody = await legacyReplay.json();
  expect(legacyReplayBody.activities[0].lastAttempt.rubric).toEqual(legacyRubric);
  const secondResponse = await partialApp.request('/api/attempts', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Now': now },
    body: JSON.stringify({
      exerciseId: exercise.id,
      activityId: activity.id,
      answer: { text: 'A second explanation.' },
      mode: 'review',
    }),
  });
  expect(secondResponse.status).toBe(200);
  const secondBody = await secondResponse.json();
  expect(secondBody).toMatchObject({
    correct: 0.75,
    attemptNo: 2,
    retryAllowed: false,
    exemplar: exercise.exemplar,
    activityCompleted: true,
  });
  expect(secondBody).not.toHaveProperty('followUp');
  const logs = await db.select().from(reviewLogs).where(eq(reviewLogs.cardId, card.id));
  expect(logs).toHaveLength(1);
  expect(logs[0]?.attemptId).toBe(secondBody.attemptId);
  const cardAfterRetry = await db.select().from(reviewCards).where(eq(reviewCards.id, card.id));
  expect(cardAfterRetry[0]?.reps).toBeGreaterThan(card.reps);
  const completedActivity = await db
    .select({ status: sessionActivities.status })
    .from(sessionActivities)
    .where(eq(sessionActivities.id, activity.id));
  expect(completedActivity[0]?.status).toBe('completed');
});

test('a missing optional explain point keeps a review answer correct and rates the card', async () => {
  await resetLearner();
  const authoredContent = await loadContent('content');
  const exercise = authoredContent.exercisesById.get('gd-explain-lr');
  if (exercise?.type !== 'explain') throw new Error('Missing gradient-descent explain exercise');
  const [session] = await db
    .insert(studySessions)
    .values({ userId, plannedMinutes: 15, status: 'active', kind: 'weekday' })
    .returning();
  if (!session) throw new Error('Could not create a session fixture');
  const [activity] = await db
    .insert(sessionActivities)
    .values({
      sessionId: session.id,
      idx: 0,
      kind: 'review',
      conceptId: exercise.concept,
      exerciseIds: [exercise.id],
      plannedMinutes: 5,
      status: 'in_progress',
    })
    .returning();
  if (!activity) throw new Error('Could not create a review activity fixture');
  const card = await createReviewCard(exercise.concept, exercise.dimension, new Date(now));
  const optionalMissingApp = createApp({
    db,
    content: authoredContent,
    tutorProvider: new FakeProvider(undefined, {
      criteria: exercise.rubric.map((criterion) => ({
        id: criterion.id,
        judgement: criterion.required ? 'met' : 'missing',
        evidence: criterion.required ? 'Addressed.' : null,
      })),
      feedback_md: 'Correct.',
    }),
  });

  const response = await optionalMissingApp.request('/api/attempts', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Now': now },
    body: JSON.stringify({
      exerciseId: exercise.id,
      activityId: activity.id,
      answer: { text: 'The learning rate controls gradient step size.' },
      mode: 'review',
    }),
  });
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body).toMatchObject({
    correct: 1,
    feedback: 'Correct.',
    retryAllowed: false,
    activityCompleted: true,
    rubric: [
      { id: 'r1', required: true },
      { id: 'r2', required: true },
      { id: 'r3', required: true },
      { id: 'r4', required: false },
    ],
  });
  const replay = await optionalMissingApp.request(`/api/sessions/${session.id}`, {
    headers: headersAt(now),
  });
  expect(replay.status).toBe(200);
  expect((await replay.json()).activities[0].lastAttempt).toMatchObject({
    rubric: [
      { id: 'r1', required: true },
      { id: 'r2', required: true },
      { id: 'r3', required: true },
      { id: 'r4', required: false },
    ],
  });
  const logs = await db.select().from(reviewLogs).where(eq(reviewLogs.cardId, card.id));
  expect(logs).toHaveLength(1);
  expect(Number(logs[0]?.rating)).toBeGreaterThanOrEqual(Rating.Good);
});

test('no-tutor explain flow returns model answer before the capped self-check result', async () => {
  const exercise = content.exercisesById.get('sl-explain-setup');
  if (exercise?.type !== 'explain') throw new Error('Missing explain exercise');
  const headers = { 'content-type': 'application/json', 'X-Now': now };
  const first = await noTutorApp.request('/api/attempts', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      exerciseId: exercise.id,
      answer: { text: 'A model maps inputs to a target.' },
      mode: 'practice',
    }),
  });
  expect(first.status).toBe(200);
  const firstBody = await first.json();
  expect(firstBody).toMatchObject({
    status: 'self_check_required',
    exemplar: exercise.exemplar,
    yourAnswer: 'A model maps inputs to a target.',
  });
  expect(firstBody).not.toHaveProperty('solution');

  const second = await noTutorApp.request('/api/attempts', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      exerciseId: exercise.id,
      answer: { text: 'A model maps inputs to a target.', metCriteria: ['r1', 'r2', 'r3'] },
      mode: 'practice',
    }),
  });
  expect(second.status).toBe(200);
  const body = await second.json();
  expect(body).toMatchObject({
    status: 'graded',
    graded_by: 'self',
    exemplar: exercise.exemplar,
  });
  expect(body).not.toHaveProperty('solution');
  expect(body.credit).toBeLessThanOrEqual(0.5);
});

test('opening a lesson review does not create session or attempt rows', async () => {
  const expectedLesson = content.lessonsByConcept.get('vectors');
  if (!expectedLesson) throw new Error('Missing vectors lesson');
  const beforeAttempts = await db.select().from(attempts).where(eq(attempts.userId, userId));
  const beforeSessions = await db
    .select()
    .from(studySessions)
    .where(eq(studySessions.userId, userId));
  const beforeActivities = await db.select().from(sessionActivities);
  const beforeRuns = await db.select().from(lessonRuns).where(eq(lessonRuns.userId, userId));
  const beforeXp = await db.select().from(xpEvents).where(eq(xpEvents.userId, userId));
  const beforeMasteryEvents = await db
    .select()
    .from(masteryEvents)
    .where(eq(masteryEvents.userId, userId));
  const response = await app.request('/api/lessons/vectors/review');
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body).toMatchObject({
    conceptTitle: 'Vectors',
    lesson: { blocks: expect.any(Array) },
  });
  expect(body.lesson.blocks).toHaveLength(expectedLesson.blocks.length);
  const afterAttempts = await db.select().from(attempts).where(eq(attempts.userId, userId));
  const afterSessions = await db
    .select()
    .from(studySessions)
    .where(eq(studySessions.userId, userId));
  const afterActivities = await db.select().from(sessionActivities);
  const afterRuns = await db.select().from(lessonRuns).where(eq(lessonRuns.userId, userId));
  const afterXp = await db.select().from(xpEvents).where(eq(xpEvents.userId, userId));
  const afterMasteryEvents = await db
    .select()
    .from(masteryEvents)
    .where(eq(masteryEvents.userId, userId));
  expect(afterAttempts).toHaveLength(beforeAttempts.length);
  expect(afterSessions).toHaveLength(beforeSessions.length);
  expect(afterActivities).toHaveLength(beforeActivities.length);
  expect(afterRuns).toHaveLength(beforeRuns.length);
  expect(afterXp).toHaveLength(beforeXp.length);
  expect(afterMasteryEvents).toHaveLength(beforeMasteryEvents.length);
});

test('lesson-runner schedules one due review per concept, then reschedules it', async () => {
  await resetLearner('America/Los_Angeles');
  const dayOne = '2026-01-01T12:00:00.000Z';
  const { activity } = await createLearnActivity(dayOne);
  await passLessonRun('vectors', activity.id, dayOne);

  const cards = await db.select().from(reviewCards).where(eq(reviewCards.userId, userId));
  expect(cards.length).toBeGreaterThan(0);
  const latestDueAt = Math.max(...cards.map((card) => card.dueAt.getTime()));
  const reviewNow = new Date(
    Math.max(new Date('2026-01-12T12:00:00.000Z').getTime(), latestDueAt + 60_000),
  );
  const todayResponse = await app.request('/api/today', {
    headers: headersAt(reviewNow.toISOString()),
  });
  expect(todayResponse.status).toBe(200);
  const today = await todayResponse.json();
  const dueCards = cards.filter((card) => card.dueAt <= reviewNow);
  const reviewActivities = today.plan.activities.filter(
    (activity: { kind: string }) => activity.kind === 'review',
  );
  const plannedCardKeys = reviewActivities.map(
    (activity: { conceptId: string; exerciseIds: string[] }) => {
      const exercise = content.exercisesById.get(activity.exerciseIds[0] ?? '');
      return `${activity.conceptId}/${exercise?.dimension}`;
    },
  );
  expect(reviewActivities).toHaveLength(1);
  expect(
    dueCards.some((card) => plannedCardKeys.includes(`${card.conceptId}/${card.dimension}`)),
  ).toBe(true);

  const reviewActivity = reviewActivities[0];
  if (!reviewActivity) throw new Error('No due review activity was planned');
  const exerciseId = reviewActivity.exerciseIds[0] as string;
  const exercise = content.exercisesById.get(exerciseId);
  if (!exercise) throw new Error(`Missing review exercise ${exerciseId}`);
  const card = dueCards.find(
    (item) => item.conceptId === exercise.concept && item.dimension === exercise.dimension,
  );
  if (!card) throw new Error('Planned review did not match a due card');
  const answerResponse = await app.request('/api/attempts', {
    method: 'POST',
    headers: headersAt(reviewNow.toISOString()),
    body: JSON.stringify({
      exerciseId,
      answer: correctAnswer(exerciseId, null),
      mode: 'review',
    }),
  });
  expect(answerResponse.status).toBe(200);
  expect((await answerResponse.json()).correct).toBeGreaterThan(0);

  const [rescheduled] = await db.select().from(reviewCards).where(eq(reviewCards.id, card.id));
  expect(rescheduled?.dueAt.getTime()).toBeGreaterThanOrEqual(reviewNow.getTime() + 86_400_000);
  const logs = await db.select().from(reviewLogs).where(eq(reviewLogs.cardId, card.id));
  expect(logs).toHaveLength(2);

  const laterToday = new Date(reviewNow.getTime() + 2 * 60 * 60_000);
  const laterResponse = await app.request('/api/today', {
    headers: headersAt(laterToday.toISOString()),
  });
  const later = await laterResponse.json();
  expect(
    later.plan.activities.some(
      (activity: { kind: string; conceptId?: string; exerciseIds: string[] }) => {
        if (activity.kind !== 'review' || activity.conceptId !== card.conceptId) return false;
        return activity.exerciseIds.some(
          (id) => content.exercisesById.get(id)?.dimension === card.dimension,
        );
      },
    ),
  ).toBe(false);
});

test('stale sessions are hidden for today, abandoned by new sessions, and keep lesson progress', async () => {
  await resetLearner('America/Los_Angeles');
  await enrollDefaultCourse();
  const dayOne = '2026-01-02T07:30:00.000Z';
  const sessionResponse = await app.request('/api/sessions', {
    method: 'POST',
    headers: headersAt(dayOne),
    body: JSON.stringify({ budgetMinutes: 60, focusConceptId: 'vectors' }),
  });
  expect(sessionResponse.status).toBe(201);
  const oldSession = await sessionResponse.json();
  const sameDayToday = await app.request('/api/today', {
    headers: headersAt(dayOne),
  });
  expect((await sameDayToday.json()).activeSessionId).toBe(oldSession.id);
  const learnActivity = oldSession.activities.find(
    (activity: { kind: string; conceptId?: string }) =>
      activity.kind === 'learn' && activity.conceptId === 'vectors',
  );
  expect(learnActivity).toBeDefined();

  let run = await startLessonRun('vectors', learnActivity.id, dayOne);
  const pending = run.pending as
    | { id: string; exerciseId: string; seed: number | null }
    | undefined;
  if (!pending) throw new Error('Expected a pending lesson problem');
  const firstAnswer = await answerLessonProblem('vectors', learnActivity.id, pending, dayOne);
  expect(firstAnswer.status).toBe(200);
  run = (await firstAnswer.json()).state;
  expect(run.status).toBe('in_progress');
  const [lessonRun] = await db
    .select()
    .from(lessonRuns)
    .where(and(eq(lessonRuns.userId, userId), eq(lessonRuns.conceptId, 'vectors')));
  expect(lessonRun?.status).toBe('in_progress');

  const dueAt = new Date('2026-01-02T08:00:00.000Z');
  const [existingCard] = await db
    .select()
    .from(reviewCards)
    .where(
      and(
        eq(reviewCards.userId, userId),
        eq(reviewCards.conceptId, 'vectors'),
        eq(reviewCards.dimension, 'math'),
      ),
    );
  if (existingCard) {
    await db.update(reviewCards).set({ dueAt }).where(eq(reviewCards.id, existingCard.id));
  } else {
    const scheduled = scheduleInitialReview(
      newReviewCard(new Date(dayOne)),
      new Date(dayOne),
      'again',
      'America/Los_Angeles',
      false,
    );
    await db.insert(reviewCards).values({
      userId,
      conceptId: 'vectors',
      dimension: 'math',
      fsrs: scheduled.card,
      dueAt,
      lastReviewAt: new Date(dayOne),
      reps: scheduled.card.reps,
      lapses: scheduled.card.lapses,
    });
  }

  const dayTwo = '2026-01-02T08:30:00.000Z';
  const todayResponse = await app.request('/api/today', { headers: headersAt(dayTwo) });
  const today = await todayResponse.json();
  expect(today.activeSessionId).toBeNull();
  expect(
    today.plan.activities.some(
      (activity: { kind: string; conceptId?: string }) =>
        activity.kind === 'review' && activity.conceptId === 'vectors',
    ),
  ).toBe(true);
  expect(
    today.plan.activities.some(
      (activity: { kind: string; conceptId?: string }) =>
        activity.kind === 'learn' && activity.conceptId === 'vectors',
    ),
  ).toBe(true);

  const learnResponse = await app.request('/api/learn', { headers: headersAt(dayTwo) });
  const learn = await learnResponse.json();
  expect(learn.activeSessionId).toBeNull();
  expect(
    learn.tasks.some(
      (task: { activityKind: string; conceptId?: string }) =>
        task.activityKind === 'review' && task.conceptId === 'vectors',
    ),
  ).toBe(true);
  expect(
    learn.tasks.some(
      (task: { activityKind: string; conceptId?: string }) =>
        task.activityKind === 'learn' && task.conceptId === 'vectors',
    ),
  ).toBe(true);
  const progressResponse = await app.request('/api/progress', {
    headers: headersAt(dayTwo),
  });
  expect((await progressResponse.json()).hours).toBe(0);

  const activeResponse = await app.request('/api/sessions/active', {
    headers: headersAt(dayTwo),
  });
  expect(await activeResponse.json()).toBeNull();
  const oldSessionResponse = await app.request(`/api/sessions/${oldSession.id}`, {
    headers: headersAt(dayTwo),
  });
  expect(oldSessionResponse.status).toBe(200);
  expect((await oldSessionResponse.json()).status).toBe('active');

  const newSessionResponse = await app.request('/api/sessions', {
    method: 'POST',
    headers: headersAt(dayTwo),
    body: JSON.stringify({ budgetMinutes: 60 }),
  });
  expect(newSessionResponse.status).toBe(201);
  const newSession = await newSessionResponse.json();
  expect(
    newSession.activities.some(
      (activity: { kind: string; conceptId?: string }) =>
        activity.kind === 'learn' && activity.conceptId === 'vectors',
    ),
  ).toBe(true);
  expect(
    newSession.activities.some(
      (activity: { kind: string; conceptId?: string }) =>
        activity.kind === 'review' && activity.conceptId === 'vectors',
    ),
  ).toBe(true);
  const [abandoned] = await db
    .select()
    .from(studySessions)
    .where(eq(studySessions.id, oldSession.id));
  expect(abandoned?.status).toBe('abandoned');
  expect(abandoned?.endedAt?.toISOString()).toBe(dayTwo);
  const oldUrlAfterAbandon = await app.request(`/api/sessions/${oldSession.id}`, {
    headers: headersAt(dayTwo),
  });
  expect(oldUrlAfterAbandon.status).toBe(200);
  expect((await oldUrlAfterAbandon.json()).status).toBe('abandoned');

  const activeAfterStart = await app.request('/api/sessions/active', {
    headers: headersAt(dayTwo),
  });
  expect((await activeAfterStart.json()).id).toBe(newSession.id);
});
