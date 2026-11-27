import { setTimeout as delay } from 'node:timers/promises';
import { instantiateExercise, isTemplate } from '@open-academy/engine/course/templates';
import type { ContentIndex } from '@open-academy/engine/course/types';
import { EngineLearnerRepository } from '@open-academy/engine/engine/repository';
import { buildEncompassingIndex } from '@open-academy/engine/graph/encompassing';
import { answerOptionsFor } from '@open-academy/engine/lessons/answer-options';
import {
  isDueToday,
  newReviewCard,
  scheduleInitialReview,
  scheduleReview,
} from '@open-academy/engine/memory/fsrs';
import { calculateCredit } from '@open-academy/engine/memory/mastery';
import {
  applyImplicitRepetitions,
  type ImplicitRepetitionTraceEvent,
  setImplicitRepetitionTrace,
} from '@open-academy/engine/memory/mastery-service';
import { dueTopicsCoveredBy, type SchedulerState } from '@open-academy/engine/planner/scheduler';
import { and, asc, eq } from 'drizzle-orm';
import { type Card, Rating, State } from 'ts-fsrs';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { env } from '../../src/config.js';
import { loadContent } from '../../src/content/load.js';
import { createDb } from '../../src/db/client.js';
import { drizzleLearnerStore } from '../../src/db/learner-store.js';
import {
  attempts,
  courseEnrollments,
  diagnosticRuns,
  hintEvents,
  lessonQuizItems,
  lessonRuns,
  masteryEvents,
  placementGrants,
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
import { fsrsFuzzEnabled } from '../../src/learning/fsrs-fuzz.js';

const db = createDb(env.TEST_DATABASE_URL);
const userId = '00000000-0000-4000-8000-000000000001';
const now = '2026-01-01T12:00:00.000Z';
let app: ReturnType<typeof createApp>;
let noTutorApp: ReturnType<typeof createApp>;
let content: ContentIndex;
let fullContent: ContentIndex;

beforeAll(async () => {
  content = await loadContent('tests/fixtures/content');
  fullContent = await loadContent('content');
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

function contentWithRecallExercises() {
  const lesson = content.lessonsByConcept.get('vectors');
  const knowledgePoint = lesson?.knowledge_points?.[0]?.id;
  if (!knowledgePoint) throw new Error('Missing vectors knowledge-point fixture');
  const source = content.exercisesByConcept
    .get('vectors')
    ?.find((exercise) => exercise.type === 'mc' && !exercise.lesson_only && !isTemplate(exercise));
  if (!source) throw new Error('Missing vectors MC recall fixture');
  const recallExercises = [
    {
      ...source,
      id: 'vectors-recall-conceptual-fixture',
      dimension: 'conceptual' as const,
      role: 'recall' as const,
      knowledge_point: knowledgePoint,
    },
    {
      ...source,
      id: 'vectors-recall-math-fixture',
      dimension: 'math' as const,
      role: 'recall' as const,
      knowledge_point: knowledgePoint,
    },
  ];
  const exercisesByConcept = new Map(content.exercisesByConcept).set('vectors', [
    ...(content.exercisesByConcept.get('vectors') ?? []),
    ...recallExercises,
  ]);
  const exercisesById = new Map(content.exercisesById);
  const exercisesByDimension = new Map(content.exercisesByDimension);
  for (const exercise of recallExercises) {
    exercisesById.set(exercise.id, exercise);
    exercisesByDimension.set(exercise.dimension, [
      ...(exercisesByDimension.get(exercise.dimension) ?? []),
      exercise,
    ]);
  }
  const exercisesByRole = new Map(content.exercisesByRole).set('recall', [
    ...(content.exercisesByRole.get('recall') ?? []),
    ...recallExercises,
  ]);
  return {
    index: {
      ...content,
      exercises: [...content.exercises, ...recallExercises],
      exercisesByConcept,
      exercisesByDimension,
      exercisesById,
      exercisesByRole,
    },
    recallExercises,
  };
}

async function createReviewActivity(conceptId: string | null, exerciseIds: string | string[]) {
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
      exerciseIds: Array.isArray(exerciseIds) ? exerciseIds : [exerciseIds],
      plannedMinutes: 5,
      status: 'in_progress',
    })
    .returning();
  if (!activity) throw new Error('Could not create a review activity');
  return activity;
}

async function createReviewActivityInSession(
  sessionId: string,
  idx: number,
  conceptId: string | null,
  exerciseIds: string[],
  status: 'planned' | 'in_progress' | 'completed',
  plannedMinutes = 5,
) {
  const [activity] = await db
    .insert(sessionActivities)
    .values({
      sessionId,
      idx,
      kind: 'review',
      conceptId,
      exerciseIds,
      plannedMinutes,
      status,
    })
    .returning();
  if (!activity) throw new Error('Could not create a review activity in the session');
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

async function submitReviewExercise(exerciseId: string, activityId: string, answer: unknown) {
  const response = await app.request('/api/attempts', {
    method: 'POST',
    headers: headersAt(now),
    body: JSON.stringify({
      exerciseId,
      activityId,
      answer,
      mode: 'review',
    }),
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<{ activityCompleted?: boolean; correct?: number }>;
}

async function submitIncorrectReviewExercise(exerciseId: string, activityId: string) {
  const exercise = content.exercisesById.get(exerciseId);
  if (exercise?.type !== 'mc') {
    throw new Error(
      `Expected a multiple-choice exercise for deterministic wrong answer: ${exerciseId}`,
    );
  }
  const answer = exercise.multi
    ? exercise.options.filter((option) => !option.correct).map((option) => option.id)
    : exercise.options.find((option) => !option.correct)?.id;
  if (answer === undefined || (Array.isArray(answer) && answer.length === 0)) {
    throw new Error(`No incorrect answer is available for ${exerciseId}`);
  }
  const result = await submitReviewExercise(exerciseId, activityId, answer);
  expect(result.correct).toBe(0);
  return result;
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
  await db.insert(lessonRuns).values({
    userId,
    conceptId: 'vectors',
    status: 'completed',
    startedAt: new Date('2026-01-01T11:00:00.000Z'),
  });
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

test('session creation does not block on a concurrent user foreign-key check', async () => {
  await resetLearner();
  await enrollDefaultCourse();
  let request: Promise<Response> | Response | undefined;
  const timeout = new AbortController();
  const status = await db.transaction(async (tx) => {
    await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('key share');
    request = app.request('/api/sessions', {
      method: 'POST',
      headers: headersAt(now),
      body: JSON.stringify({ budgetMinutes: 60, focusConceptId: 'vectors' }),
    });
    try {
      return await Promise.race([
        Promise.resolve(request).then((response) => response.status),
        delay(2_000, 'blocked', { signal: timeout.signal }),
      ]);
    } finally {
      timeout.abort();
    }
  });
  await request;
  expect(status).toBe(201);
});

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

function planCoversDueConcept(
  activities: Array<{ kind: string; conceptId?: string | null }>,
  cards: Array<{ conceptId: string; dimension: string; dueAt: Date; fsrs: unknown }>,
  conceptId: string,
  now: Date,
  timezone: string,
) {
  const state: SchedulerState = {
    timezone,
    activeCourseId: null,
    studyCourseIds: [],
    recentLearnMinutesByConcept: {},
    mastery: [],
    cards: cards.map((card) => ({
      conceptId: card.conceptId,
      dimension: card.dimension as SchedulerState['cards'][number]['dimension'],
      dueAt: card.dueAt.toISOString(),
      fsrs: card.fsrs as Card,
    })),
    reviewedTodayConceptIds: [],
    recentAttempts: [],
    exerciseLastSeen: new Map(),
    remediationFlags: [],
    projectProgress: [],
    completedPaperIds: [],
    startDate: now.toISOString().slice(0, 10),
  };
  return activities.some(
    (activity) =>
      activity.kind === 'learn' &&
      activity.conceptId &&
      dueTopicsCoveredBy(activity.conceptId, state, content, now).has(conceptId),
  );
}

function learnedReviewFsrs(dueAt: Date, reviewedAt = new Date('2025-12-01T12:00:00.000Z')) {
  return {
    ...scheduleReview(newReviewCard(reviewedAt), reviewedAt, Rating.Good, 'UTC', false).card,
    state: State.Review,
    stability: 12,
    difficulty: 5,
    last_review: reviewedAt,
    due: dueAt,
  };
}

async function createPrerequisiteReviewCards(weakDueAt: Date, includeAlreadyDueConceptual = false) {
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
  const alreadyDueConceptual = includeAlreadyDueConceptual
    ? await createReviewCard(
        'gradients',
        'conceptual',
        new Date('2026-01-01T00:00:00.000Z'),
        reviewFsrs(recentReview, 10),
      )
    : undefined;
  if (alreadyDueConceptual) {
    await db
      .update(reviewCards)
      .set({ lastReviewAt: recentReview })
      .where(eq(reviewCards.id, alreadyDueConceptual.id));
  }
  return { current, weakest, stronger, alreadyDueConceptual, future };
}

async function createDoubleAgainVectorCards() {
  const oldReview = new Date('2025-12-01T12:00:00.000Z');
  const future = new Date('2026-02-01T12:00:00.000Z');
  const reviewFsrs = (stability: number, dueAt: Date) => ({
    ...scheduleReview(newReviewCard(oldReview), oldReview, Rating.Good, 'UTC', false).card,
    stability,
    due: dueAt,
  });
  const dependent = await createReviewCard(
    'derivatives',
    'conceptual',
    new Date('2025-12-31T00:00:00.000Z'),
  );
  const math = await createReviewCard(
    'vectors',
    'math',
    new Date('2026-01-01T00:00:00.000Z'),
    reviewFsrs(10, new Date('2026-01-01T00:00:00.000Z')),
  );
  const conceptual = await createReviewCard('vectors', 'conceptual', future, reviewFsrs(1, future));
  await db.update(reviewCards).set({ lastReviewAt: oldReview }).where(eq(reviewCards.id, math.id));
  await db
    .update(reviewCards)
    .set({ lastReviewAt: oldReview })
    .where(eq(reviewCards.id, conceptual.id));
  return { dependent, math, conceptual, future };
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
  if (exercise.type === 'explain') {
    return {
      text: exercise.exemplar,
      metCriteria: exercise.rubric.map(({ id }) => id),
    };
  }
  throw new Error(`No test answer for ${exercise.id}`);
}

function vectorMathExerciseIds() {
  return (content.exercisesByConcept.get('vectors') ?? [])
    .filter(
      (exercise) => exercise.dimension === 'math' && !isTemplate(exercise) && !exercise.lesson_only,
    )
    .map((exercise) => exercise.id);
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

test('Today compresses a due review when same-day learning covers its topic', async () => {
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
  const cards = await db.select().from(reviewCards).where(eq(reviewCards.userId, userId));
  expect(
    payload.plan.activities.some(
      (item: { kind: string; conceptId?: string }) =>
        item.kind === 'review' && item.conceptId === 'vectors',
    ),
  ).toBe(false);
  expect(
    planCoversDueConcept(
      payload.plan.activities,
      cards.filter((card) => card.conceptId === 'vectors'),
      'vectors',
      new Date('2026-01-15T12:00:00.000Z'),
      'UTC',
    ),
  ).toBe(true);
});

test('focus mode only counts coverage from lessons kept in the session', async () => {
  const courses = fullContent.courses.map((course) =>
    course.id === 'maths-for-ml'
      ? {
          ...course,
          units: course.units.map((unit, index) => ({
            ...unit,
            concepts: index === 0 ? ['vectors', 'dot-product', 'derivatives'] : [],
          })),
        }
      : course,
  );
  const focusContent: ContentIndex = {
    ...fullContent,
    courses,
    coursesById: new Map(courses.map((course) => [course.id, course])),
  };
  const focusApp = createApp({
    db,
    content: focusContent,
    tutorProvider: new FakeProvider(),
  });
  const seedFocusScenario = async (dotProductInProgress = false) => {
    await resetLearner();
    await db.insert(courseEnrollments).values({
      userId,
      courseId: 'maths-for-ml',
      status: 'active',
      startMethod: 'beginning',
    });
    const completedPrerequisites = new Set<string>();
    const addHardPrerequisites = (conceptId: string) => {
      for (const prerequisite of focusContent.conceptsById.get(conceptId)?.prereqs ?? []) {
        if (prerequisite.strength !== 'hard' || completedPrerequisites.has(prerequisite.id)) {
          continue;
        }
        completedPrerequisites.add(prerequisite.id);
        addHardPrerequisites(prerequisite.id);
      }
    };
    addHardPrerequisites('dot-product');
    addHardPrerequisites('derivatives');
    for (const concept of focusContent.concepts) {
      if (concept.id !== 'dot-product' && concept.id !== 'derivatives') {
        completedPrerequisites.add(concept.id);
      }
    }
    if (completedPrerequisites.size > 0) {
      await db.insert(lessonRuns).values(
        [...completedPrerequisites].map((conceptId) => ({
          userId,
          conceptId,
          status: 'completed' as const,
          startedAt: new Date(now),
        })),
      );
    }
    if (dotProductInProgress) {
      await db.insert(lessonRuns).values({
        userId,
        conceptId: 'dot-product',
        status: 'in_progress',
        startedAt: new Date(now),
      });
    }
    const dueAt = new Date('2025-12-31T00:00:00.000Z');
    await createReviewCard('vectors', 'math', dueAt, learnedReviewFsrs(dueAt));
  };
  const hasVectorsReview = (activities: Array<{ kind: string; exerciseIds: string[] }>) =>
    activities.some(
      (activity) =>
        activity.kind === 'review' &&
        activity.exerciseIds.some(
          (exerciseId) => focusContent.exercisesById.get(exerciseId)?.concept === 'vectors',
        ),
    );

  await seedFocusScenario();
  const unfocusedResponse = await focusApp.request('/api/sessions', {
    method: 'POST',
    headers: headersAt(now),
    body: JSON.stringify({ budgetMinutes: 240 }),
  });
  expect(unfocusedResponse.status).toBe(201);
  const unfocusedSession = await unfocusedResponse.json();
  expect(
    unfocusedSession.activities.some(
      (activity: { kind: string; conceptId?: string }) =>
        activity.kind === 'learn' && activity.conceptId === 'dot-product',
    ),
  ).toBe(true);
  expect(hasVectorsReview(unfocusedSession.activities)).toBe(false);

  await seedFocusScenario();
  const focusedResponse = await focusApp.request('/api/sessions', {
    method: 'POST',
    headers: headersAt(now),
    body: JSON.stringify({ budgetMinutes: 240, focusConceptId: 'derivatives' }),
  });
  expect(focusedResponse.status).toBe(201);
  const focusedSession = await focusedResponse.json();
  expect(
    focusedSession.activities.some(
      (activity: { kind: string; conceptId?: string }) =>
        activity.kind === 'learn' && activity.conceptId === 'derivatives',
    ),
  ).toBe(true);
  expect(
    focusedSession.activities.some(
      (activity: { kind: string; conceptId?: string }) =>
        activity.kind === 'learn' && activity.conceptId === 'dot-product',
    ),
  ).toBe(false);
  expect(hasVectorsReview(focusedSession.activities)).toBe(true);

  await seedFocusScenario(true);
  const inProgressFocusResponse = await focusApp.request('/api/sessions', {
    method: 'POST',
    headers: headersAt(now),
    body: JSON.stringify({ budgetMinutes: 240, focusConceptId: 'derivatives' }),
  });
  expect(inProgressFocusResponse.status).toBe(201);
  const inProgressFocusSession = await inProgressFocusResponse.json();
  expect(
    inProgressFocusSession.activities.some(
      (activity: { kind: string; conceptId?: string }) =>
        activity.kind === 'learn' && activity.conceptId === 'dot-product',
    ),
  ).toBe(true);
  expect(hasVectorsReview(inProgressFocusSession.activities)).toBe(false);
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

  const activeSession = await app.request(`/api/sessions/${session.id}`, {
    headers: headersAt(now),
  });
  expect((await activeSession.json()).current).toEqual({
    activityId: activity.id,
    openableIds: [activity.id],
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

test('review answers include the lesson step for re-reading', async () => {
  await resetLearner();
  const { index, recallExercises } = contentWithRecallExercises();
  const exercise = recallExercises[0];
  if (exercise?.type !== 'mc') throw new Error('Missing recall exercise');
  const lesson = index.lessonsByConcept.get('vectors');
  const point = lesson?.knowledge_points?.find(
    (candidate) => candidate.id === exercise.knowledge_point,
  );
  if (!point) throw new Error('Missing recall knowledge point');
  const activity = await createReviewActivity('vectors', exercise.id);
  const wrongOption = exercise.options.find((option) => !option.correct);
  if (!wrongOption) throw new Error('Missing incorrect recall option');
  const recallApp = createApp({ db, content: index, tutorProvider: new FakeProvider() });
  const response = await recallApp.request('/api/attempts', {
    method: 'POST',
    headers: headersAt(now),
    body: JSON.stringify({
      exerciseId: exercise.id,
      activityId: activity.id,
      answer: wrongOption.id,
      mode: 'review',
    }),
  });
  expect(response.status).toBe(200);
  expect((await response.json()).step).toEqual({
    conceptId: 'vectors',
    pointId: point.id,
    title: point.title,
  });
});

test('completing a review resolves open remediation flags for its topics', async () => {
  await resetLearner();
  const exercise = content.exercisesByConcept
    .get('vectors')
    ?.find(
      (candidate) =>
        candidate.type === 'mc' &&
        !candidate.multi &&
        !candidate.lesson_only &&
        !isTemplate(candidate),
    );
  if (!exercise) throw new Error('Missing vectors review exercise');
  if (exercise.type !== 'mc') throw new Error('Expected a multiple-choice vectors exercise');
  const wrongOption = exercise.options.find((option) => !option.correct);
  if (!wrongOption) throw new Error('Missing incorrect vectors option');
  await db.insert(remediationFlags).values({
    userId,
    conceptId: 'gradient-descent',
    targetPrereqId: 'vectors',
  });
  const activity = await createReviewActivity('vectors', exercise.id);
  const response = await submitReviewExercise(exercise.id, activity.id, wrongOption.id);
  expect(response).toMatchObject({ activityCompleted: true, correct: 0 });
  const flags = await db.select().from(remediationFlags).where(eq(remediationFlags.userId, userId));
  expect(flags).toHaveLength(1);
  expect(flags[0]).toMatchObject({ status: 'resolved', targetPrereqId: 'vectors' });
  expect(flags[0]?.resolvedAt).toBeInstanceOf(Date);
});

test('a mixed review keeps the follow-up flag it opened', async () => {
  await resetLearner();
  const reviewable = (conceptId: string) => {
    const exercise = content.exercisesByConcept
      .get(conceptId)
      ?.find(
        (candidate) =>
          candidate.type === 'mc' &&
          !candidate.multi &&
          !candidate.lesson_only &&
          !isTemplate(candidate),
      );
    if (exercise?.type !== 'mc') throw new Error(`Missing ${conceptId} review exercise`);
    return exercise;
  };
  const prerequisite = reviewable('vectors');
  const dependent = reviewable('derivatives');
  const [run] = await db
    .insert(diagnosticRuns)
    .values({ userId, kind: 'placement', status: 'completed', state: {}, startedAt: new Date(now) })
    .returning();
  if (!run) throw new Error('Could not create a placement run');
  await db.insert(placementGrants).values({
    userId,
    runId: run.id,
    conceptId: 'vectors',
    origin: 'inferred',
    state: 'conditional',
    reason: 'inferred_only',
    createdAt: new Date(now),
    updatedAt: new Date(now),
  });
  const activity = await createReviewActivity(null, [prerequisite.id, dependent.id]);
  await db.insert(hintEvents).values({
    userId,
    activityId: activity.id,
    exerciseId: prerequisite.id,
    level: 1,
    text: 'Hint',
    createdAt: new Date(Date.parse(now) - 1000),
  });
  const correctOption = prerequisite.options.find((option) => option.correct);
  expect(await submitReviewExercise(prerequisite.id, activity.id, correctOption?.id)).toMatchObject(
    { correct: 1 },
  );
  const wrongOption = dependent.options.find((option) => !option.correct);
  if (!wrongOption) throw new Error('Missing incorrect derivatives option');
  expect(await submitReviewExercise(dependent.id, activity.id, wrongOption.id)).toMatchObject({
    activityCompleted: true,
    correct: 0,
  });
  const flags = await db.select().from(remediationFlags).where(eq(remediationFlags.userId, userId));
  expect(flags).toEqual([
    expect.objectContaining({
      status: 'open',
      conceptId: 'derivatives',
      targetPrereqId: 'vectors',
    }),
  ]);
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

test('a Good review activity credits hard prerequisites but not soft prerequisites', async () => {
  await resetLearner();
  const exercises = (content.exercisesByConcept.get('linear-models') ?? [])
    .filter(
      (exercise) =>
        exercise.dimension === 'math' && exercise.type === 'numeric' && !isTemplate(exercise),
    )
    .slice(0, 3);
  expect(exercises).toHaveLength(3);
  const dueAt = new Date('2025-12-31T12:00:00.000Z');
  const reviewedAt = new Date('2025-12-01T12:00:00.000Z');
  const fsrsForDue = () => ({
    ...scheduleReview(newReviewCard(reviewedAt), reviewedAt, Rating.Good, 'UTC', false).card,
    state: State.Review,
    stability: 12,
    difficulty: 5,
    due: dueAt,
    reps: 6,
    lapses: 2,
  });
  const hardCards = await Promise.all(
    ['math', 'conceptual'].map((dimension) =>
      createReviewCard('vectors', dimension, dueAt, fsrsForDue()),
    ),
  );
  const softCard = await createReviewCard('supervised-learning', 'math', dueAt, fsrsForDue());
  const currentCard = await createReviewCard('linear-models', 'math', dueAt, fsrsForDue());
  const activity = await createReviewActivity(
    'linear-models',
    exercises.map((exercise) => exercise.id),
  );

  for (const exercise of exercises) {
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
  }

  const [currentLog] = await db
    .select()
    .from(reviewLogs)
    .where(eq(reviewLogs.cardId, currentCard.id));
  expect(currentLog?.rating).toBe(String(Rating.Good));
  for (const prerequisiteCard of hardCards) {
    const [updated] = await db
      .select()
      .from(reviewCards)
      .where(eq(reviewCards.id, prerequisiteCard.id));
    if (!updated) throw new Error('Expected a credited hard-prerequisite card');
    expect(updated.dueAt.getTime()).toBeGreaterThan(dueAt.getTime());
    expect(new Date((updated.fsrs as { due: string }).due)).toEqual(updated.dueAt);
    expect(updated.lastReviewAt).toEqual(prerequisiteCard.lastReviewAt);
    expect(updated.reps).toBe(prerequisiteCard.reps);
    expect(updated.lapses).toBe(prerequisiteCard.lapses);
    expect(
      await db.select().from(reviewLogs).where(eq(reviewLogs.cardId, prerequisiteCard.id)),
    ).toHaveLength(0);
  }
  const [unchangedSoftCard] = await db
    .select()
    .from(reviewCards)
    .where(eq(reviewCards.id, softCard.id));
  if (!unchangedSoftCard) throw new Error('Expected the soft-prerequisite card');
  expect(unchangedSoftCard.dueAt).toEqual(softCard.dueAt);
  expect(unchangedSoftCard.lastReviewAt).toEqual(softCard.lastReviewAt);
  expect(unchangedSoftCard.reps).toBe(softCard.reps);
  expect(unchangedSoftCard.lapses).toBe(softCard.lapses);
  expect(await db.select().from(reviewLogs).where(eq(reviewLogs.cardId, softCard.id))).toHaveLength(
    0,
  );
});

test('a Good review moves a two-hop ancestor by its inferred weight', async () => {
  await resetLearner();
  const path = content.concepts.flatMap((leaf) => {
    const exercise = content.exercisesByConcept
      .get(leaf.id)
      ?.find((candidate) => !candidate.lesson_only && !isTemplate(candidate));
    if (!exercise) return [];
    return leaf.prereqs
      .filter((prereq) => prereq.strength === 'hard')
      .flatMap((prereq) => {
        const middle = content.conceptsById.get(prereq.id);
        return (
          middle?.prereqs
            .filter((ancestor) => ancestor.strength === 'hard')
            .map((ancestor) => ({ leaf, ancestorId: ancestor.id, exercise })) ?? []
        );
      });
  })[0];
  if (!path) throw new Error('Expected a two-hop hard-prerequisite fixture');
  const weight = buildEncompassingIndex(content).weight(path.leaf.id, path.ancestorId);
  expect(weight).toBe(0.25);
  const dueAt = new Date('2026-01-01T00:00:00.000Z');
  const ancestor = await createReviewCard(
    path.ancestorId,
    path.exercise.dimension,
    dueAt,
    learnedReviewFsrs(dueAt),
  );
  await createReviewCard(path.leaf.id, path.exercise.dimension, dueAt);
  const activity = await createReviewActivity(path.leaf.id, path.exercise.id);
  const response = await app.request('/api/attempts', {
    method: 'POST',
    headers: headersAt(now),
    body: JSON.stringify({
      exerciseId: path.exercise.id,
      activityId: activity.id,
      answer: correctAnswer(path.exercise.id, null),
      mode: 'review',
    }),
  });
  expect(response.status).toBe(200);
  const [updated] = await db.select().from(reviewCards).where(eq(reviewCards.id, ancestor.id));
  if (!updated) throw new Error('Expected the ancestor review card');
  const full = scheduleReview(ancestor.fsrs as Card, new Date(now), Rating.Good, 'UTC', false).card;
  const expectedDue = new Date(dueAt.getTime() + weight * (full.due.getTime() - dueAt.getTime()));
  expect(updated.dueAt).toEqual(expectedDue);
  expect(updated.lastReviewAt).toBeNull();
  expect(updated.reps).toBe(ancestor.reps);
  expect(updated.lapses).toBe(ancestor.lapses);
});

test('Again credit interpolates a full-weight descendant without changing an unrelated topic', async () => {
  await resetLearner();
  const edge = content.concepts.flatMap((descendant) => {
    const exercise = content.exercisesByConcept
      .get(descendant.id)
      ?.find(
        (candidate) => candidate.type === 'mc' && !candidate.lesson_only && !isTemplate(candidate),
      );
    return exercise
      ? descendant.prereqs
          .filter((prereq) => prereq.strength === 'hard')
          .map((prereq) => ({ descendant, parentId: prereq.id, exercise }))
      : [];
  })[0];
  if (!edge) throw new Error('Expected a hard-prerequisite MC fixture');
  if (edge.exercise.type !== 'mc') throw new Error('Expected a multiple-choice exercise');
  const concepts = content.concepts.map((concept) =>
    concept.id === edge.descendant.id
      ? { ...concept, encompassings: [{ id: edge.parentId, weight: 1 }] }
      : concept,
  );
  const index: ContentIndex = {
    ...content,
    concepts,
    conceptsById: new Map(concepts.map((concept) => [concept.id, concept])),
  };
  const encompassing = buildEncompassingIndex(index);
  expect(encompassing.weight(edge.descendant.id, edge.parentId)).toBe(1);
  const customApp = createApp({ db, content: index, tutorProvider: new FakeProvider() });
  const future = new Date('2026-01-11T12:00:00.000Z');
  const descendantCard = await createReviewCard(
    edge.descendant.id,
    edge.exercise.dimension,
    future,
    learnedReviewFsrs(future),
  );
  const unrelated = concepts.find(
    (concept) =>
      concept.id !== edge.parentId &&
      concept.id !== edge.descendant.id &&
      encompassing.weight(concept.id, edge.parentId) === 0,
  );
  if (!unrelated) throw new Error('Expected an unrelated topic');
  const unrelatedCard = await createReviewCard(
    unrelated.id,
    edge.exercise.dimension,
    future,
    learnedReviewFsrs(future),
  );
  await createReviewCard(edge.parentId, edge.exercise.dimension, new Date(now));
  const activity = await createReviewActivity(edge.parentId, edge.exercise.id);
  const wrongOption = edge.exercise.options.find((option) => !option.correct)?.id;
  if (wrongOption === undefined) throw new Error('Expected a wrong option');
  const response = await customApp.request('/api/attempts', {
    method: 'POST',
    headers: headersAt(now),
    body: JSON.stringify({
      exerciseId: edge.exercise.id,
      activityId: activity.id,
      answer: wrongOption,
      mode: 'review',
    }),
  });
  expect(response.status).toBe(200);
  const [updatedDescendant, unchangedUnrelated] = await Promise.all([
    db
      .select()
      .from(reviewCards)
      .where(eq(reviewCards.id, descendantCard.id))
      .then((rows) => rows[0]),
    db
      .select()
      .from(reviewCards)
      .where(eq(reviewCards.id, unrelatedCard.id))
      .then((rows) => rows[0]),
  ]);
  if (!updatedDescendant || !unchangedUnrelated) throw new Error('Expected seeded cards');
  const weight = encompassing.weight(edge.descendant.id, edge.parentId);
  const againDue = scheduleReview(
    descendantCard.fsrs as Card,
    new Date(now),
    Rating.Again,
    'UTC',
    false,
  ).card.due;
  const expectedDue = new Date(
    descendantCard.dueAt.getTime() + weight * (againDue.getTime() - descendantCard.dueAt.getTime()),
  );
  expect(updatedDescendant.dueAt).toEqual(expectedDue);
  expect(unchangedUnrelated.dueAt).toEqual(unrelatedCard.dueAt);
});

test('a wrong recall plus two correct problems rates its due card Hard without logging a non-due card', async () => {
  await resetLearner();
  const { index, recallExercises } = contentWithRecallExercises();
  const recallApp = createApp({ db, content: index, tutorProvider: new FakeProvider() });
  const recall = recallExercises.find((exercise) => exercise.dimension === 'math');
  if (recall?.type !== 'mc') throw new Error('Expected a math MC recall exercise');
  const problems = vectorMathExerciseIds()
    .slice(0, 2)
    .map((exerciseId) => content.exercisesById.get(exerciseId))
    .filter((exercise) => exercise !== undefined);
  expect(problems).toHaveLength(2);

  const dueAt = new Date('2025-12-31T12:00:00.000Z');
  const dueCard = await createReviewCard('vectors', 'math', dueAt, {
    ...newReviewCard(new Date(now)),
    due: dueAt,
  });
  const futureAt = new Date('2026-02-01T12:00:00.000Z');
  const nonDueCard = await createReviewCard('vectors', 'conceptual', futureAt, {
    ...newReviewCard(new Date(now)),
    due: futureAt,
  });
  const activity = await createReviewActivity('vectors', [
    recall.id,
    ...problems.map((exercise) => exercise.id),
  ]);
  const incorrectOptions = recall.options
    .filter((option) => !option.correct)
    .map((option) => option.id);
  const incorrectAnswer = recall.multi ? incorrectOptions : incorrectOptions[0];
  if (
    incorrectAnswer === undefined ||
    (Array.isArray(incorrectAnswer) && !incorrectAnswer.length)
  ) {
    throw new Error('Missing incorrect recall answer');
  }
  const wrongResponse = await recallApp.request('/api/attempts', {
    method: 'POST',
    headers: headersAt(now),
    body: JSON.stringify({
      exerciseId: recall.id,
      activityId: activity.id,
      answer: incorrectAnswer,
      mode: 'review',
    }),
  });
  expect(wrongResponse.status).toBe(200);
  expect(await wrongResponse.json()).toMatchObject({ correct: 0, activityCompleted: false });
  expect(await db.select().from(reviewLogs).where(eq(reviewLogs.cardId, dueCard.id))).toHaveLength(
    0,
  );

  let completion: { activityCompleted?: boolean } | undefined;
  for (const exercise of problems) {
    const response = await recallApp.request('/api/attempts', {
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
    completion = await response.json();
  }
  expect(completion?.activityCompleted).toBe(true);

  const [dueLog] = await db.select().from(reviewLogs).where(eq(reviewLogs.cardId, dueCard.id));
  expect(dueLog?.rating).toBe(String(Rating.Hard));
  expect(
    await db.select().from(reviewLogs).where(eq(reviewLogs.cardId, nonDueCard.id)),
  ).toHaveLength(0);

  const state = await new EngineLearnerRepository(
    drizzleLearnerStore(db),
    userId,
    undefined,
    undefined,
    fsrsFuzzEnabled(),
  ).schedulerState(new Date(now), index);
  expect(state.recallAttempts).toContainEqual(
    expect.objectContaining({ exerciseId: recall.id, correct: 0 }),
  );
});

test('a wrong recall and a wrong problem rate its due card Again without logging a non-due card', async () => {
  await resetLearner();
  const { index, recallExercises } = contentWithRecallExercises();
  const recallApp = createApp({ db, content: index, tutorProvider: new FakeProvider() });
  const recall = recallExercises.find((exercise) => exercise.dimension === 'math');
  if (recall?.type !== 'mc') throw new Error('Expected a math MC recall exercise');
  const problemId = vectorMathExerciseIds()[0];
  const problem = problemId ? content.exercisesById.get(problemId) : undefined;
  if (problem?.type !== 'numeric') throw new Error('Expected a math numeric problem');

  const dueAt = new Date('2025-12-31T12:00:00.000Z');
  const dueCard = await createReviewCard('vectors', 'math', dueAt, {
    ...newReviewCard(new Date(now)),
    due: dueAt,
  });
  const futureAt = new Date('2026-02-01T12:00:00.000Z');
  const nonDueCard = await createReviewCard('vectors', 'conceptual', futureAt, {
    ...newReviewCard(new Date(now)),
    due: futureAt,
  });
  const activity = await createReviewActivity('vectors', [recall.id, problem.id]);
  const incorrectOptions = recall.options
    .filter((option) => !option.correct)
    .map((option) => option.id);
  const incorrectAnswer = recall.multi ? incorrectOptions : incorrectOptions[0];
  if (
    incorrectAnswer === undefined ||
    (Array.isArray(incorrectAnswer) && !incorrectAnswer.length)
  ) {
    throw new Error('Missing incorrect recall answer');
  }

  const wrongRecallResponse = await recallApp.request('/api/attempts', {
    method: 'POST',
    headers: headersAt(now),
    body: JSON.stringify({
      exerciseId: recall.id,
      activityId: activity.id,
      answer: incorrectAnswer,
      mode: 'review',
    }),
  });
  expect(wrongRecallResponse.status).toBe(200);
  expect(await wrongRecallResponse.json()).toMatchObject({ correct: 0, activityCompleted: false });

  const wrongProblemResponse = await recallApp.request('/api/attempts', {
    method: 'POST',
    headers: headersAt(now),
    body: JSON.stringify({
      exerciseId: problem.id,
      activityId: activity.id,
      answer: 'not-a-number',
      mode: 'review',
    }),
  });
  expect(wrongProblemResponse.status).toBe(200);
  expect(await wrongProblemResponse.json()).toMatchObject({ correct: 0, activityCompleted: true });

  const [dueLog] = await db.select().from(reviewLogs).where(eq(reviewLogs.cardId, dueCard.id));
  expect(dueLog?.rating).toBe(String(Rating.Again));
  expect(
    await db.select().from(reviewLogs).where(eq(reviewLogs.cardId, nonDueCard.id)),
  ).toHaveLength(0);
});

test('a Hard review activity credits hard prerequisites', async () => {
  await resetLearner();
  const exercises = (content.exercisesByConcept.get('linear-models') ?? [])
    .filter(
      (exercise) =>
        exercise.dimension === 'math' && exercise.type === 'numeric' && !isTemplate(exercise),
    )
    .slice(0, 3);
  expect(exercises).toHaveLength(3);
  const dueAt = new Date('2025-12-31T12:00:00.000Z');
  const reviewedAt = new Date('2025-12-01T12:00:00.000Z');
  const fsrs = {
    ...scheduleReview(newReviewCard(reviewedAt), reviewedAt, Rating.Good, 'UTC', false).card,
    state: State.Review,
    stability: 12,
    difficulty: 5,
    due: dueAt,
    reps: 6,
    lapses: 2,
  };
  const prerequisiteCard = await createReviewCard('vectors', 'math', dueAt, fsrs);
  const currentCard = await createReviewCard('linear-models', 'math', dueAt, fsrs);
  const activity = await createReviewActivity(
    'linear-models',
    exercises.map((exercise) => exercise.id),
  );

  for (const [index, exercise] of exercises.entries()) {
    const answer = index === 2 ? 'not-a-number' : correctAnswer(exercise.id, null);
    const response = await app.request('/api/attempts', {
      method: 'POST',
      headers: headersAt(now),
      body: JSON.stringify({
        exerciseId: exercise.id,
        activityId: activity.id,
        answer,
        mode: 'review',
      }),
    });
    expect(response.status).toBe(200);
  }

  const [currentLog] = await db
    .select()
    .from(reviewLogs)
    .where(eq(reviewLogs.cardId, currentCard.id));
  expect(currentLog?.rating).toBe(String(Rating.Hard));
  const [updated] = await db
    .select()
    .from(reviewCards)
    .where(eq(reviewCards.id, prerequisiteCard.id));
  if (!updated) throw new Error('Expected the hard-prerequisite card');
  expect(updated.dueAt.getTime()).toBeGreaterThan(prerequisiteCard.dueAt.getTime());
  expect(updated.lastReviewAt).toEqual(prerequisiteCard.lastReviewAt);
  expect(updated.reps).toBe(prerequisiteCard.reps);
  expect(updated.lapses).toBe(prerequisiteCard.lapses);
  expect(
    await db.select().from(reviewLogs).where(eq(reviewLogs.cardId, prerequisiteCard.id)),
  ).toHaveLength(0);
});

test('two consecutive Again review activities pull the weakest hard-prerequisite card due now', async () => {
  await resetLearner();
  const { current, weakest, stronger, future } = await createPrerequisiteReviewCards(
    new Date('2026-02-01T12:00:00.000Z'),
  );
  const firstActivity = await createReviewActivity('gradient-descent', 'gradient-descent-step');
  const secondActivity = await createReviewActivity('gradient-descent', 'gradient-descent-step');
  const [laterPlannedActivity] = await db
    .insert(sessionActivities)
    .values({
      sessionId: secondActivity.sessionId,
      idx: secondActivity.idx + 1,
      kind: 'review',
      conceptId: 'linear-models',
      exerciseIds: ['linear-models-slope'],
      plannedMinutes: 5,
      status: 'planned',
      reason: secondActivity.reason,
    })
    .returning();
  if (!laterPlannedActivity) throw new Error('Expected a later planned activity');

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
  const activitiesAfterAgain = await db
    .select()
    .from(sessionActivities)
    .where(eq(sessionActivities.sessionId, secondActivity.sessionId))
    .orderBy(asc(sessionActivities.idx));
  expect(activitiesAfterAgain.map((item) => item.idx)).toEqual([
    secondActivity.idx,
    secondActivity.idx + 1,
    secondActivity.idx + 2,
  ]);
  const prerequisiteActivity = activitiesAfterAgain[1];
  if (!prerequisiteActivity) throw new Error('Expected an inserted prerequisite review');
  const shiftedActivity = activitiesAfterAgain[2];
  expect(prerequisiteActivity.kind).toBe('review');
  expect(prerequisiteActivity.status).toBe('in_progress');
  expect(shiftedActivity?.id).toBe(laterPlannedActivity.id);
  expect(shiftedActivity?.status).toBe('planned');
  expect(
    prerequisiteActivity.exerciseIds.some(
      (exerciseId) => content.exercisesById.get(exerciseId)?.concept === weakest.conceptId,
    ),
  ).toBe(true);
});

test('double Again skips a suspended prerequisite card and pulls the next weakest one due', async () => {
  await resetLearner();
  const { weakest, stronger, future } = await createPrerequisiteReviewCards(
    new Date('2026-02-01T12:00:00.000Z'),
  );
  const suspendedAt = new Date('2026-01-31T12:00:00.000Z');
  await db.update(reviewCards).set({ suspendedAt }).where(eq(reviewCards.id, weakest.id));
  const firstActivity = await createReviewActivity('gradient-descent', 'gradient-descent-step');
  const secondActivity = await createReviewActivity('gradient-descent', 'gradient-descent-step');

  await submitReviewActivityAgain(firstActivity.id);
  await submitReviewActivityAgain(secondActivity.id);

  const [suspended] = await db.select().from(reviewCards).where(eq(reviewCards.id, weakest.id));
  const [pulled] = await db.select().from(reviewCards).where(eq(reviewCards.id, stronger.id));
  expect(suspended?.dueAt).toEqual(weakest.dueAt);
  expect(pulled?.dueAt.toISOString()).toBe(now);
  expect(pulled?.dueAt).not.toEqual(future);
});

test('double Again inserts before a skipped session activity', async () => {
  await resetLearner();
  await createPrerequisiteReviewCards(new Date('2026-02-01T12:00:00.000Z'));
  const firstActivity = await createReviewActivity('gradient-descent', 'gradient-descent-step');
  const secondActivity = await createReviewActivity('gradient-descent', 'gradient-descent-step');
  const [skippedActivity] = await db
    .insert(sessionActivities)
    .values({
      sessionId: secondActivity.sessionId,
      idx: secondActivity.idx + 1,
      kind: 'review',
      conceptId: 'linear-models',
      exerciseIds: ['linear-models-slope'],
      plannedMinutes: 5,
      status: 'skipped',
      reason: secondActivity.reason,
    })
    .returning();
  if (!skippedActivity) throw new Error('Expected a skipped activity');

  await submitReviewActivityAgain(firstActivity.id);
  await submitReviewActivityAgain(secondActivity.id);

  const activities = await db
    .select()
    .from(sessionActivities)
    .where(eq(sessionActivities.sessionId, secondActivity.sessionId))
    .orderBy(asc(sessionActivities.idx));
  expect(activities.map((item) => item.idx)).toEqual([
    secondActivity.idx,
    secondActivity.idx + 1,
    secondActivity.idx + 2,
  ]);
  expect(activities[0]?.id).toBe(secondActivity.id);
  expect(activities[1]?.status).toBe('in_progress');
  expect(activities[2]?.id).toBe(skippedActivity.id);
  expect(activities[2]?.status).toBe('skipped');
});

test('double Again inserts one prerequisite review for all due dimensions and replanning does not duplicate it', async () => {
  await resetLearner();
  const { weakest, alreadyDueConceptual } = await createPrerequisiteReviewCards(
    new Date('2026-02-01T12:00:00.000Z'),
    true,
  );
  if (!alreadyDueConceptual) throw new Error('Expected a due conceptual prerequisite card');
  expect(isDueToday(alreadyDueConceptual.dueAt, new Date(now), 'UTC')).toBe(true);
  const firstActivity = await createReviewActivity('gradient-descent', 'gradient-descent-step');
  const secondActivity = await createReviewActivity('gradient-descent', 'gradient-descent-step');

  await submitReviewActivityAgain(firstActivity.id);
  await submitReviewActivityAgain(secondActivity.id);

  const activitiesAfterAgain = await db
    .select()
    .from(sessionActivities)
    .where(eq(sessionActivities.sessionId, secondActivity.sessionId))
    .orderBy(asc(sessionActivities.idx));
  const isGradientsReview = (activity: (typeof activitiesAfterAgain)[number]) =>
    activity.kind === 'review' &&
    activity.exerciseIds.some(
      (exerciseId) => content.exercisesById.get(exerciseId)?.concept === weakest.conceptId,
    );
  const prerequisiteActivities = activitiesAfterAgain.filter(isGradientsReview);
  expect(prerequisiteActivities).toHaveLength(1);
  const insertedActivity = prerequisiteActivities[0];
  if (!insertedActivity) throw new Error('Expected a prerequisite review activity');
  const dimensions = new Set(
    insertedActivity.exerciseIds.flatMap((exerciseId) => {
      const exercise = content.exercisesById.get(exerciseId);
      return exercise?.concept === weakest.conceptId ? [exercise.dimension] : [];
    }),
  );
  expect(dimensions.has('math')).toBe(true);
  expect(dimensions.has('conceptual')).toBe(true);

  const replanResponse = await app.request(`/api/sessions/${secondActivity.sessionId}/replan`, {
    method: 'POST',
    headers: headersAt(now),
    body: JSON.stringify({ remainingBudgetMinutes: 600 }),
  });
  expect(replanResponse.status).toBe(200);
  const activitiesAfterReplan = await db
    .select()
    .from(sessionActivities)
    .where(eq(sessionActivities.sessionId, secondActivity.sessionId))
    .orderBy(asc(sessionActivities.idx));
  const prerequisiteActivitiesAfterReplan = activitiesAfterReplan.filter(isGradientsReview);
  expect(prerequisiteActivitiesAfterReplan).toHaveLength(1);
  expect(prerequisiteActivitiesAfterReplan[0]?.id).toBe(insertedActivity.id);
});

test('double Again extends a planned mixed review with a newly due prerequisite dimension', async () => {
  await resetLearner();
  const { math, conceptual } = await createDoubleAgainVectorCards();
  const [vectorMathId] = vectorMathExerciseIds();
  if (!vectorMathId) throw new Error('Expected a vector math exercise');
  const firstAgainActivity = await createReviewActivity(
    'derivatives',
    'derivatives-fixture-1-basics',
  );
  await submitIncorrectReviewExercise('derivatives-fixture-1-basics', firstAgainActivity.id);

  const triggerActivity = await createReviewActivity('derivatives', 'derivatives-fixture-1-basics');
  const plannedActivity = await createReviewActivityInSession(
    triggerActivity.sessionId,
    triggerActivity.idx + 1,
    null,
    [vectorMathId, 'loss-functions-mse', 'switching-topic-fixture-review'],
    'planned',
    15,
  );
  const originalExerciseIds = [...plannedActivity.exerciseIds];
  const originalPlannedMinutes = plannedActivity.plannedMinutes;

  const paceRatio = 1.3;
  const originalSchedulerState = EngineLearnerRepository.prototype.schedulerState;
  const schedulerStateSpy = vi
    .spyOn(EngineLearnerRepository.prototype, 'schedulerState')
    .mockImplementation(async function (this: EngineLearnerRepository, now, contentIndex, loaded) {
      const state = await originalSchedulerState.call(this, now, contentIndex, loaded);
      return { ...state, actualEstimateRatio: paceRatio };
    });
  let triggerResult: { activityCompleted?: boolean } | undefined;
  try {
    triggerResult = await submitIncorrectReviewExercise(
      'derivatives-fixture-1-basics',
      triggerActivity.id,
    );
  } finally {
    schedulerStateSpy.mockRestore();
  }
  expect(triggerResult.activityCompleted).toBe(true);

  const [updatedPlannedActivity] = await db
    .select()
    .from(sessionActivities)
    .where(eq(sessionActivities.id, plannedActivity.id));
  if (!updatedPlannedActivity) throw new Error('Expected the mixed review activity to be extended');
  const [dueConceptual] = await db
    .select()
    .from(reviewCards)
    .where(eq(reviewCards.id, conceptual.id));
  if (!dueConceptual) throw new Error('Expected the conceptual vector review card');
  expect(dueConceptual.dueAt.getTime()).toBe(new Date(now).getTime());
  const additions = updatedPlannedActivity.exerciseIds.filter(
    (exerciseId) => !originalExerciseIds.includes(exerciseId),
  );
  expect(additions.length).toBeGreaterThan(0);
  expect(
    additions.every((exerciseId) => {
      const exercise = content.exercisesById.get(exerciseId);
      return exercise?.concept === 'vectors' && exercise.dimension === 'conceptual';
    }),
  ).toBe(true);
  const addedBaseMinutes = additions.reduce(
    (total, exerciseId) => total + (content.exercisesById.get(exerciseId)?.est_minutes ?? 0),
    0,
  );
  expect(addedBaseMinutes).toBeGreaterThan(0);
  const expectedAddedMinutes = Math.ceil(addedBaseMinutes * paceRatio);
  expect(expectedAddedMinutes).toBeGreaterThan(addedBaseMinutes);
  expect(updatedPlannedActivity.plannedMinutes).toBe(originalPlannedMinutes + expectedAddedMinutes);
  const activitiesWithVectors = await db
    .select()
    .from(sessionActivities)
    .where(eq(sessionActivities.sessionId, triggerActivity.sessionId));
  expect(
    activitiesWithVectors.filter(
      (item) =>
        item.kind === 'review' &&
        item.exerciseIds.some(
          (exerciseId) => content.exercisesById.get(exerciseId)?.concept === 'vectors',
        ),
    ),
  ).toHaveLength(1);

  let completion: { activityCompleted?: boolean } | undefined;
  for (const exerciseId of updatedPlannedActivity.exerciseIds) {
    completion = await submitReviewExercise(
      exerciseId,
      updatedPlannedActivity.id,
      correctAnswer(exerciseId, null),
    );
  }
  expect(completion?.activityCompleted).toBe(true);
  expect(await db.select().from(reviewLogs).where(eq(reviewLogs.cardId, math.id))).toHaveLength(1);
  expect(
    await db.select().from(reviewLogs).where(eq(reviewLogs.cardId, conceptual.id)),
  ).toHaveLength(1);
});

test('double Again appends prerequisite exercises to an in-progress mixed review without completing it early', async () => {
  await resetLearner();
  const { math, conceptual } = await createDoubleAgainVectorCards();
  const [firstMathId, secondMathId] = vectorMathExerciseIds();
  if (!firstMathId || !secondMathId) throw new Error('Expected two vector math exercises');
  const firstAgainActivity = await createReviewActivity(
    'derivatives',
    'derivatives-fixture-1-basics',
  );
  await submitIncorrectReviewExercise('derivatives-fixture-1-basics', firstAgainActivity.id);

  const originalExerciseIds = [firstMathId, 'derivatives-fixture-1-basics', secondMathId];
  const activeActivity = await createReviewActivity(null, originalExerciseIds);
  const firstMathResult = await submitReviewExercise(
    firstMathId,
    activeActivity.id,
    correctAnswer(firstMathId, null),
  );
  expect(firstMathResult.activityCompleted).toBe(false);

  const triggerResult = await submitIncorrectReviewExercise(
    'derivatives-fixture-1-basics',
    activeActivity.id,
  );
  expect(triggerResult.activityCompleted).toBe(false);
  const [extendedActivity] = await db
    .select()
    .from(sessionActivities)
    .where(eq(sessionActivities.id, activeActivity.id));
  if (!extendedActivity) throw new Error('Expected the in-progress activity to be extended');
  expect(extendedActivity.exerciseIds.slice(0, originalExerciseIds.length)).toEqual(
    originalExerciseIds,
  );
  const additions = extendedActivity.exerciseIds.slice(originalExerciseIds.length);
  expect(additions.length).toBeGreaterThan(0);
  expect(
    additions.every((exerciseId) => {
      const exercise = content.exercisesById.get(exerciseId);
      return exercise?.concept === 'vectors' && exercise.dimension === 'conceptual';
    }),
  ).toBe(true);
  expect(extendedActivity.plannedMinutes).toBe(
    activeActivity.plannedMinutes +
      additions.reduce(
        (total, exerciseId) => total + (content.exercisesById.get(exerciseId)?.est_minutes ?? 0),
        0,
      ),
  );
  const [dueConceptual] = await db
    .select()
    .from(reviewCards)
    .where(eq(reviewCards.id, conceptual.id));
  if (!dueConceptual) throw new Error('Expected the conceptual vector review card');
  expect(dueConceptual.dueAt.getTime()).toBe(new Date(now).getTime());

  let completion: { activityCompleted?: boolean } | undefined;
  for (const exerciseId of originalExerciseIds) {
    if (exerciseId === firstMathId || exerciseId === 'derivatives-fixture-1-basics') continue;
    completion = await submitReviewExercise(
      exerciseId,
      activeActivity.id,
      correctAnswer(exerciseId, null),
    );
  }
  expect(completion?.activityCompleted).toBe(false);
  for (const exerciseId of additions) {
    completion = await submitReviewExercise(
      exerciseId,
      activeActivity.id,
      correctAnswer(exerciseId, null),
    );
  }
  expect(completion?.activityCompleted).toBe(true);
  expect(await db.select().from(reviewLogs).where(eq(reviewLogs.cardId, math.id))).toHaveLength(1);
  expect(
    await db.select().from(reviewLogs).where(eq(reviewLogs.cardId, conceptual.id)),
  ).toHaveLength(1);
});

test('double Again does not extend or add a prerequisite review already completed today', async () => {
  await resetLearner();
  const { conceptual, future } = await createDoubleAgainVectorCards();
  const firstAgainActivity = await createReviewActivity(
    'derivatives',
    'derivatives-fixture-1-basics',
  );
  await submitIncorrectReviewExercise('derivatives-fixture-1-basics', firstAgainActivity.id);

  const vectorActivity = await createReviewActivity('vectors', 'vectors-magnitude');
  const triggerActivity = await createReviewActivityInSession(
    vectorActivity.sessionId,
    vectorActivity.idx + 1,
    'derivatives',
    ['derivatives-fixture-1-basics'],
    'planned',
  );
  const vectorResult = await submitReviewExercise(
    'vectors-magnitude',
    vectorActivity.id,
    correctAnswer('vectors-magnitude', null),
  );
  expect(vectorResult.activityCompleted).toBe(true);

  await submitIncorrectReviewExercise('derivatives-fixture-1-basics', triggerActivity.id);

  const [unchangedConceptual] = await db
    .select()
    .from(reviewCards)
    .where(eq(reviewCards.id, conceptual.id));
  if (!unchangedConceptual) throw new Error('Expected the conceptual vector review card');
  expect(unchangedConceptual.dueAt.getTime()).toBe(future.getTime());
  const activities = await db
    .select()
    .from(sessionActivities)
    .where(eq(sessionActivities.sessionId, vectorActivity.sessionId));
  expect(
    activities.filter(
      (item) =>
        item.kind === 'review' &&
        item.exerciseIds.some(
          (exerciseId) => content.exercisesById.get(exerciseId)?.concept === 'vectors',
        ),
    ),
  ).toHaveLength(1);
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
  expect(body.dueNow).toBe(2);
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
  expect(body.topics[1]).toMatchObject({ due: true, dueInDays: 0 });
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

test('asking the tutor never lowers session practice credit', async () => {
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

  const { activity } = await createPracticeActivity();
  await addTutorMessage(activity.id, '2026-01-01T12:00:00.001Z');
  const response = await answer(activity.id, '2026-01-01T12:00:01.000Z');
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body).toMatchObject({ hintsUsed: 0, credit: 1 });
  const [saved] = await db.select().from(attempts).where(eq(attempts.id, body.attemptId));
  expect(saved).toMatchObject({ hintsUsed: 0, credit: 1 });
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

test('a follow-up on the final review exercise applies implicit credit once at final grading', async () => {
  await resetLearner();
  const exercise = content.exercisesById.get('derivatives-explain');
  if (exercise?.type !== 'explain') throw new Error('Missing derivatives explain exercise');
  const dueAt = new Date('2025-12-31T00:00:00.000Z');
  const currentCard = await createReviewCard(
    exercise.concept,
    exercise.dimension,
    dueAt,
    learnedReviewFsrs(dueAt),
  );
  const prerequisiteCard = await createReviewCard(
    'vectors',
    'conceptual',
    dueAt,
    learnedReviewFsrs(dueAt),
  );
  const [session] = await db
    .insert(studySessions)
    .values({ userId, plannedMinutes: 15, status: 'active', kind: 'weekday' })
    .returning();
  if (!session) throw new Error('Could not create a review session fixture');
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
  const partialApp = createApp({
    db,
    content,
    tutorProvider: new FakeProvider(undefined, {
      criteria: [
        { id: 'local-rate', judgement: 'partial', evidence: 'Mentions change.' },
        { id: 'tangent-slope', judgement: 'missing', evidence: null },
      ],
      feedback_md: 'Add the tangent-slope connection.',
    }),
  });
  const completeApp = createApp({
    db,
    content,
    tutorProvider: new FakeProvider(undefined, {
      criteria: exercise.rubric.map(({ id }) => ({
        id,
        judgement: 'met' as const,
        evidence: 'Both criteria are addressed.',
      })),
      feedback_md: 'Complete explanation.',
    }),
  });
  const submit = (targetApp: ReturnType<typeof createApp>, answer: string) =>
    targetApp.request('/api/attempts', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Now': now },
      body: JSON.stringify({
        exerciseId: exercise.id,
        activityId: activity.id,
        answer: { text: answer },
        mode: 'review',
      }),
    });

  const followUpResponse = await submit(partialApp, 'A change occurs at the point.');
  expect(followUpResponse.status).toBe(200);
  expect(await followUpResponse.json()).toMatchObject({
    followUp: true,
    retryAllowed: true,
    activityCompleted: false,
  });
  const [prerequisiteAfterFollowUp] = await db
    .select()
    .from(reviewCards)
    .where(eq(reviewCards.id, prerequisiteCard.id));
  expect(prerequisiteAfterFollowUp?.dueAt).toEqual(dueAt);
  expect(
    await db.select().from(reviewLogs).where(eq(reviewLogs.cardId, currentCard.id)),
  ).toHaveLength(0);

  const finalResponse = await submit(completeApp, 'It is the tangent slope.');
  expect(finalResponse.status).toBe(200);
  expect(await finalResponse.json()).toMatchObject({
    attemptNo: 2,
    retryAllowed: false,
    activityCompleted: true,
  });
  const [prerequisiteAfterFinal] = await db
    .select()
    .from(reviewCards)
    .where(eq(reviewCards.id, prerequisiteCard.id));
  if (!prerequisiteAfterFinal) throw new Error('Could not reload the prerequisite review card');
  expect(prerequisiteAfterFinal.dueAt.getTime()).toBeGreaterThan(dueAt.getTime());
  const implicitCreditDueAt = prerequisiteAfterFinal.dueAt;
  expect(
    await db.select().from(reviewLogs).where(eq(reviewLogs.cardId, currentCard.id)),
  ).toHaveLength(1);
  expect(
    await db.select().from(reviewLogs).where(eq(reviewLogs.cardId, prerequisiteCard.id)),
  ).toHaveLength(0);

  const replay = await submit(completeApp, 'A replay after completion.');
  expect(replay.status).toBe(409);
  const [prerequisiteAfterReplay] = await db
    .select()
    .from(reviewCards)
    .where(eq(reviewCards.id, prerequisiteCard.id));
  expect(prerequisiteAfterReplay?.dueAt).toEqual(implicitCreditDueAt);
  expect(
    await db.select().from(reviewLogs).where(eq(reviewLogs.cardId, currentCard.id)),
  ).toHaveLength(1);
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
  const exercise = authoredContent.exercisesById.get('sgm-explain-training');
  if (exercise?.type !== 'explain') throw new Error('Missing minibatch explain exercise');
  expect(exercise.rubric.some(({ required }) => required === true)).toBe(true);
  expect(exercise.rubric.some(({ required }) => required === false)).toBe(true);
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
      { id: 'average', required: true },
      { id: 'epoch', required: true },
      { id: 'tradeoff', required: true },
      { id: 'larger-batches', required: false },
    ],
  });
  const replay = await optionalMissingApp.request(`/api/sessions/${session.id}`, {
    headers: headersAt(now),
  });
  expect(replay.status).toBe(200);
  expect((await replay.json()).activities[0].lastAttempt).toMatchObject({
    rubric: [
      { id: 'average', required: true },
      { id: 'epoch', required: true },
      { id: 'tradeoff', required: true },
      { id: 'larger-batches', required: false },
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

test('lesson-runner compresses covered reviews and reschedules an uncovered due review', async () => {
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
  expect(
    today.plan.activities.some(
      (activity: { kind: string; conceptId?: string }) =>
        activity.kind === 'review' && activity.conceptId === 'vectors',
    ),
  ).toBe(false);
  expect(
    planCoversDueConcept(
      today.plan.activities,
      cards.filter((card) => card.conceptId === 'vectors'),
      'vectors',
      reviewNow,
      'America/Los_Angeles',
    ),
  ).toBe(true);
  await createReviewCard('switching-topic', 'math', reviewNow, learnedReviewFsrs(reviewNow));
  const sessionResponse = await app.request('/api/sessions', {
    method: 'POST',
    headers: headersAt(reviewNow.toISOString()),
    body: JSON.stringify({ budgetMinutes: 600 }),
  });
  expect(sessionResponse.status).toBe(201);
  const session = await sessionResponse.json();
  const allCards = await db.select().from(reviewCards).where(eq(reviewCards.userId, userId));
  const dueCards = allCards.filter((card) =>
    isDueToday(card.dueAt, reviewNow, 'America/Los_Angeles'),
  );
  const reviewActivities = session.activities.filter(
    (activity: { kind: string }) => activity.kind === 'review',
  );
  expect(reviewActivities[0]?.conceptId).toBe('switching-topic');
  const plannedCardKeys = reviewActivities.flatMap((activity: { exerciseIds: string[] }) =>
    activity.exerciseIds.flatMap((exerciseId) => {
      const exercise = content.exercisesById.get(exerciseId);
      return exercise ? [`${exercise.concept}/${exercise.dimension}`] : [];
    }),
  );
  expect(reviewActivities).toHaveLength(1);
  expect(
    dueCards.some((card) => plannedCardKeys.includes(`${card.conceptId}/${card.dimension}`)),
  ).toBe(true);

  const card = dueCards.find(
    (item) =>
      item.conceptId === 'switching-topic' &&
      plannedCardKeys.includes(`${item.conceptId}/${item.dimension}`),
  );
  if (!card) throw new Error('Planned review did not match a due card');
  const reviewActivity = reviewActivities.find((activity: { exerciseIds: string[] }) =>
    activity.exerciseIds.some((exerciseId) => {
      const exercise = content.exercisesById.get(exerciseId);
      return exercise?.concept === card.conceptId && exercise.dimension === card.dimension;
    }),
  );
  if (!reviewActivity) throw new Error('No due review activity was planned');
  for (const exerciseId of reviewActivity.exerciseIds) {
    const exercise = content.exercisesById.get(exerciseId);
    if (exercise?.concept !== card.conceptId || exercise.dimension !== card.dimension) continue;
    const answerResponse = await app.request('/api/attempts', {
      method: 'POST',
      headers: headersAt(reviewNow.toISOString()),
      body: JSON.stringify({
        exerciseId,
        activityId: reviewActivity.id,
        answer: correctAnswer(exerciseId, null),
        mode: 'review',
      }),
    });
    expect(answerResponse.status).toBe(200);
    expect((await answerResponse.json()).correct).toBeGreaterThan(0);
  }

  const [rescheduled] = await db.select().from(reviewCards).where(eq(reviewCards.id, card.id));
  expect(rescheduled?.dueAt.getTime()).toBeGreaterThanOrEqual(reviewNow.getTime() + 86_400_000);
  const logs = await db.select().from(reviewLogs).where(eq(reviewLogs.cardId, card.id));
  expect(logs).toHaveLength(1);

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

test('session details keep all mixed review topics when only one topic remains', async () => {
  await resetLearner();
  await enrollDefaultCourse();
  await db
    .update(users)
    .set({ prefs: { scheduleMinutes: 180 } })
    .where(eq(users.id, userId));
  const originalDueAt = new Date('2025-12-31T00:00:00.000Z');
  for (const conceptId of ['vectors', 'linear-models']) {
    await db.insert(reviewCards).values({
      userId,
      conceptId,
      dimension: 'math',
      fsrs: newReviewCard(new Date(now)),
      dueAt: originalDueAt,
      reps: 1,
      lapses: 0,
    });
  }

  const sessionResponse = await app.request('/api/sessions', {
    method: 'POST',
    headers: headersAt(now),
    body: JSON.stringify({ budgetMinutes: 180 }),
  });
  expect(sessionResponse.status).toBe(201);
  const session = (await sessionResponse.json()) as {
    id: string;
    activities: Array<{ id: string; kind: string; exerciseIds: string[] }>;
  };
  const activity = session.activities.find((item) => item.kind === 'review');
  if (!activity) throw new Error('Could not find a mixed review activity');
  const exerciseConcepts = activity.exerciseIds.map(
    (exerciseId) => content.exercisesById.get(exerciseId)?.concept,
  );
  expect(
    new Set(exerciseConcepts.filter((concept): concept is string => Boolean(concept))).size,
  ).toBeGreaterThanOrEqual(2);
  const lastExerciseId = activity.exerciseIds.at(-1);
  if (!lastExerciseId) throw new Error('The mixed review has no questions');
  const lastConceptId = content.exercisesById.get(lastExerciseId)?.concept;
  if (!lastConceptId) throw new Error(`Missing content for ${lastExerciseId}`);

  for (const exerciseId of activity.exerciseIds.slice(0, -1)) {
    const response = await app.request('/api/attempts', {
      method: 'POST',
      headers: headersAt(now),
      body: JSON.stringify({
        exerciseId,
        activityId: activity.id,
        answer: correctAnswer(exerciseId, null),
        mode: 'review',
      }),
    });
    expect(response.status).toBe(200);
  }

  const sessionDetailsResponse = await app.request(`/api/sessions/${session.id}`, {
    headers: headersAt(now),
  });
  expect(sessionDetailsResponse.status).toBe(200);
  const sessionDetails = (await sessionDetailsResponse.json()) as {
    activities: Array<{
      id: string;
      reviewTopics?: Array<{ conceptId: string; title: string }>;
      allReviewTopics?: Array<{ conceptId: string; title: string }>;
    }>;
  };
  const updatedActivity = sessionDetails.activities.find((item) => item.id === activity.id);
  expect(updatedActivity?.reviewTopics).toHaveLength(1);
  expect(updatedActivity?.reviewTopics?.map((topic) => topic.conceptId)).toEqual([lastConceptId]);
  expect(updatedActivity?.allReviewTopics?.map((topic) => topic.conceptId)).toEqual(
    expect.arrayContaining(['vectors', 'linear-models']),
  );
  expect(updatedActivity?.allReviewTopics).toHaveLength(2);
});

test('mixed review rates and logs each topic after its own questions are answered', async () => {
  await resetLearner();
  const topicExercises = (conceptId: string) =>
    (content.exercisesByConcept.get(conceptId) ?? [])
      .filter((exercise) => exercise.dimension === 'math' && !isTemplate(exercise))
      .slice(0, 2);
  const topicAExercises = topicExercises('vectors');
  const topicBExercises = topicExercises('linear-models');
  expect(topicAExercises).toHaveLength(2);
  expect(topicBExercises).toHaveLength(2);
  const originalDueAt = new Date('2025-12-31T00:00:00.000Z');
  for (const conceptId of ['vectors', 'linear-models']) {
    await db.insert(reviewCards).values({
      userId,
      conceptId,
      dimension: 'math',
      fsrs: newReviewCard(new Date(now)),
      dueAt: originalDueAt,
      reps: 1,
      lapses: 0,
    });
  }
  const activity = await createReviewActivity(null, [
    ...topicAExercises.map((exercise) => exercise.id),
    ...topicBExercises.map((exercise) => exercise.id),
  ]);
  const cards = await db.select().from(reviewCards).where(eq(reviewCards.userId, userId));
  const cardA = cards.find((card) => card.conceptId === 'vectors');
  const cardB = cards.find((card) => card.conceptId === 'linear-models');
  if (!cardA || !cardB) throw new Error('Mixed review cards were not created');

  for (const exercise of topicAExercises) {
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
  }
  const [ratedA, waitingB] = await Promise.all([
    db.select().from(reviewCards).where(eq(reviewCards.id, cardA.id)),
    db.select().from(reviewCards).where(eq(reviewCards.id, cardB.id)),
  ]);
  expect(ratedA[0]?.dueAt.getTime()).toBeGreaterThan(originalDueAt.getTime());
  expect(waitingB[0]?.dueAt.getTime()).toBe(originalDueAt.getTime());
  expect(await db.select().from(reviewLogs).where(eq(reviewLogs.cardId, cardA.id))).toHaveLength(1);
  expect(await db.select().from(reviewLogs).where(eq(reviewLogs.cardId, cardB.id))).toHaveLength(0);

  for (const exercise of topicBExercises) {
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
  }
  const [ratedB] = await db.select().from(reviewCards).where(eq(reviewCards.id, cardB.id));
  expect(ratedB?.dueAt.getTime()).toBeGreaterThan(originalDueAt.getTime());
  expect(await db.select().from(reviewLogs).where(eq(reviewLogs.cardId, cardA.id))).toHaveLength(1);
  expect(await db.select().from(reviewLogs).where(eq(reviewLogs.cardId, cardB.id))).toHaveLength(1);
});

test('a multi-dimension review rates each card after its matching exercises are answered', async () => {
  await resetLearner();
  const dimensionExercises = (dimension: string) =>
    (content.exercisesByConcept.get('vectors') ?? [])
      .filter(
        (exercise) =>
          exercise.dimension === dimension &&
          !exercise.lesson_only &&
          !isTemplate(exercise) &&
          (exercise.type === 'mc' || 'answer' in exercise || 'accept' in exercise),
      )
      .slice(0, 2);
  const mathExercises = dimensionExercises('math');
  const conceptualExercises = dimensionExercises('conceptual');
  expect(mathExercises).toHaveLength(2);
  expect(conceptualExercises).toHaveLength(2);
  const exerciseIds = [...mathExercises, ...conceptualExercises].map(({ id }) => id);
  const dimensions = exerciseIds.map(
    (exerciseId) => content.exercisesById.get(exerciseId)?.dimension,
  );
  expect(new Set(dimensions)).toEqual(new Set(['math', 'conceptual']));

  const originalDueAt = new Date('2025-12-31T00:00:00.000Z');
  const mathCard = await createReviewCard('vectors', 'math', originalDueAt);
  const conceptualCard = await createReviewCard('vectors', 'conceptual', originalDueAt);
  const activity = await createReviewActivity('vectors', exerciseIds);

  for (const exercise of mathExercises) {
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
  }

  const [ratedMath, waitingConceptual] = await Promise.all([
    db.select().from(reviewCards).where(eq(reviewCards.id, mathCard.id)),
    db.select().from(reviewCards).where(eq(reviewCards.id, conceptualCard.id)),
  ]);
  expect(ratedMath[0]?.dueAt.getTime()).toBeGreaterThan(originalDueAt.getTime());
  expect(waitingConceptual[0]?.dueAt.getTime()).toBe(originalDueAt.getTime());
  expect(await db.select().from(reviewLogs).where(eq(reviewLogs.cardId, mathCard.id))).toHaveLength(
    1,
  );
  expect(
    await db.select().from(reviewLogs).where(eq(reviewLogs.cardId, conceptualCard.id)),
  ).toHaveLength(0);

  for (const exercise of conceptualExercises) {
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
  }

  const [ratedConceptual] = await db
    .select()
    .from(reviewCards)
    .where(eq(reviewCards.id, conceptualCard.id));
  expect(ratedConceptual?.dueAt.getTime()).toBeGreaterThan(originalDueAt.getTime());
  expect(await db.select().from(reviewLogs).where(eq(reviewLogs.cardId, mathCard.id))).toHaveLength(
    1,
  );
  expect(
    await db.select().from(reviewLogs).where(eq(reviewLogs.cardId, conceptualCard.id)),
  ).toHaveLength(1);
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
  expect((await progressResponse.json()).studyTimeHours).toBe(0);

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

test('concurrent implicit credits do not overwrite a newer target-card update', async () => {
  await resetLearner();
  const dueAt = new Date('2025-12-31T00:00:00.000Z');
  await createReviewCard('vectors', 'math', dueAt, learnedReviewFsrs(dueAt));
  const concepts = content.concepts.map((concept) =>
    concept.id === 'linear-models'
      ? { ...concept, encompassings: [{ id: 'vectors', weight: 0.2 }] }
      : concept.id === 'supervised-learning'
        ? { ...concept, encompassings: [{ id: 'vectors', weight: 0.8 }] }
        : concept,
  );
  const index = {
    ...content,
    concepts,
    conceptsById: new Map(concepts.map((concept) => [concept.id, concept])),
  };
  let readCount = 0;
  let resolveReads!: () => void;
  const bothReads = new Promise<void>((resolve) => {
    resolveReads = resolve;
  });
  let updateCount = 0;
  let resolveFirstUpdate!: () => void;
  const firstUpdate = new Promise<void>((resolve) => {
    resolveFirstUpdate = resolve;
  });
  const wrapQuery = (builder: object, kind: 'read' | 'write'): object =>
    new Proxy(builder, {
      get(target, property, receiver) {
        const method = Reflect.get(target, property, receiver);
        if (typeof method !== 'function') return method;
        if (kind === 'read' && property === 'orderBy') {
          return async (...args: unknown[]) => {
            const result = await Reflect.apply(method, target, args);
            readCount += 1;
            if (readCount === 2) resolveReads();
            await bothReads;
            return result;
          };
        }
        if (kind === 'write' && property === 'returning') {
          return async (...args: unknown[]) => {
            const order = ++updateCount;
            if (order === 2) await firstUpdate;
            const result = await Reflect.apply(method, target, args);
            if (order === 1) resolveFirstUpdate();
            return result;
          };
        }
        if (
          (kind === 'read' && (property === 'from' || property === 'where')) ||
          (kind === 'write' && (property === 'set' || property === 'where'))
        ) {
          return (...args: unknown[]) => wrapQuery(Reflect.apply(method, target, args), kind);
        }
        return method.bind(target);
      },
    });
  const racedDb = new Proxy(db, {
    get(target, property, receiver) {
      const method = Reflect.get(target, property, receiver);
      if (property === 'select' || property === 'update') {
        return (...args: unknown[]) =>
          wrapQuery(Reflect.apply(method, target, args), property === 'select' ? 'read' : 'write');
      }
      return method;
    },
  }) as typeof db;
  const events: ImplicitRepetitionTraceEvent[] = [];
  setImplicitRepetitionTrace((event) => events.push(event));
  try {
    await Promise.all([
      applyImplicitRepetitions(drizzleLearnerStore(racedDb), {
        learnerId: userId,
        conceptId: 'linear-models',
        rating: Rating.Good,
        index,
        now: new Date(now),
        timeZone: 'UTC',
        enableFuzz: fsrsFuzzEnabled(),
      }),
      applyImplicitRepetitions(drizzleLearnerStore(racedDb), {
        learnerId: userId,
        conceptId: 'supervised-learning',
        rating: Rating.Good,
        index,
        now: new Date(now),
        timeZone: 'UTC',
        enableFuzz: fsrsFuzzEnabled(),
      }),
    ]);
  } finally {
    setImplicitRepetitionTrace(undefined);
  }
  expect(events).toHaveLength(2);
  expect(events[0]?.after.fsrs).not.toEqual(events[1]?.after.fsrs);
  const [card] = await db
    .select()
    .from(reviewCards)
    .where(
      and(
        eq(reviewCards.userId, userId),
        eq(reviewCards.conceptId, 'vectors'),
        eq(reviewCards.dimension, 'math'),
      ),
    );
  expect(card?.fsrs).toEqual({
    ...events[0]?.after.fsrs,
    due: events[0]?.after.fsrs.due.toISOString(),
  });
});
