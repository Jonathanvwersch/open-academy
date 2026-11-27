import { orderCourseIdsBySubject } from '@academy/aesop/course/course-order';
import { subjectForCourse } from '@academy/aesop/course/index';
import type { ContentIndex } from '@academy/aesop/course/types';
import { EngineLearnerRepository } from '@academy/aesop/engine/repository';
import { courseFoundationIds, createPrerequisiteChecker } from '@academy/aesop/graph/prerequisites';
import { newReviewCard } from '@academy/aesop/memory/fsrs';
import type { MasteryRecord } from '@academy/aesop/memory/types';
import { answerFor } from '@academy/aesop/simulator/support';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { createApp } from '../../src/app.js';
import { env } from '../../src/config.js';
import { loadContent } from '../../src/content/load.js';
import { createDb } from '../../src/db/client.js';
import { drizzleLearnerStore } from '../../src/db/learner-store.js';
import {
  attempts,
  courseEnrollments,
  diagnosticRuns,
  lessonProblems,
  lessonQuizAttempts,
  lessonQuizItems,
  lessonRuns,
  mastery,
  masteryEvents,
  paperProgress,
  projectProgress,
  quizItems,
  remediationFlags,
  reviewCards,
  reviewLogs,
  sessionActivities,
  studySessions,
  users,
  xpEvents,
} from '../../src/db/schema.js';
import { fsrsFuzzEnabled } from '../../src/learning/fsrs-fuzz.js';
import { hardPrerequisiteAncestors, withStubConcept } from '../content-test-utils.js';

const db = createDb(env.TEST_DATABASE_URL);
const userId = '00000000-0000-4000-8000-000000000092';
let app: ReturnType<typeof createApp>;
let content: ContentIndex;

const repositoryFor = (learnerId = userId) =>
  new EngineLearnerRepository(
    drizzleLearnerStore(db),
    learnerId,
    undefined,
    undefined,
    fsrsFuzzEnabled(),
  );

beforeAll(async () => {
  content = await loadContent();
  app = createApp({ db, content, tutorProvider: null });
});

beforeEach(async () => {
  await db.delete(users);
  await db.insert(users).values({
    id: userId,
    displayName: 'Learn course API learner',
    timezone: 'UTC',
    startDate: '2026-01-01',
    prefs: { scheduleMinutes: 60 },
  });
});

afterAll(async () => {
  await db.delete(users).where(eq(users.id, userId));
  await db.$client.end();
});

async function rowCounts() {
  const sessions = await db.select().from(studySessions).where(eq(studySessions.userId, userId));
  const [activityRows, attemptRows, runRows, masteryRows, xpRows] = await Promise.all([
    sessions.length
      ? db
          .select()
          .from(sessionActivities)
          .where(eq(sessionActivities.sessionId, sessions[0]?.id ?? ''))
      : Promise.resolve([]),
    db.select().from(attempts).where(eq(attempts.userId, userId)),
    db.select().from(lessonRuns).where(eq(lessonRuns.userId, userId)),
    db.select().from(mastery).where(eq(mastery.userId, userId)),
    db.select().from(xpEvents).where(eq(xpEvents.userId, userId)),
  ]);
  const problems = runRows.length
    ? await db
        .select()
        .from(lessonProblems)
        .where(eq(lessonProblems.runId, runRows[0]?.id ?? ''))
    : [];
  return {
    sessions: sessions.length,
    activities: activityRows.length,
    attempts: attemptRows.length,
    runs: runRows.length,
    problems: problems.length,
    mastery: masteryRows.length,
    xp: xpRows.length,
  };
}

async function get(path: string) {
  return app.request(`/api${path}`, {
    headers: { 'X-Now': '2026-01-07T12:00:00.000Z' },
  });
}

function completedMasteryRows(conceptIds: readonly string[]) {
  return conceptIds.flatMap((conceptId) => {
    const concept = content.conceptsById.get(conceptId);
    return (
      concept?.dimensions.map((dimension) => ({
        userId,
        conceptId,
        dimension,
        state: 'independent' as const,
      })) ?? []
    );
  });
}

async function activateCourse(courseId: string) {
  await db.insert(courseEnrollments).values({
    userId,
    courseId,
    status: 'active',
    startMethod: 'beginning',
  });
  await db.update(users).set({ activeCourseId: courseId }).where(eq(users.id, userId));
}

test('Home offers a remediation review with its reason instead of the retrying lesson', async () => {
  await activateCourse('ml-foundations');
  await completeHardAncestors('gradient-descent');
  await db.insert(lessonRuns).values({
    userId,
    conceptId: 'gradient-descent',
    status: 'needs_retry',
    haltedAt: new Date('2026-01-06T12:00:00.000Z'),
    retryAfter: new Date('2026-01-07T00:00:00.000Z'),
    haltedPointIndex: 0,
    haltCount: 1,
  });
  await db.insert(remediationFlags).values({
    userId,
    conceptId: 'gradient-descent',
    targetPrereqId: 'gradients',
  });

  const response = await get('/learn');
  expect(response.status).toBe(200);
  const payload = await response.json();
  const prerequisiteTitle = content.conceptsById.get('gradients')?.title;
  const lessonTitle = content.conceptsById.get('gradient-descent')?.title;
  if (!prerequisiteTitle || !lessonTitle) throw new Error('Missing remediation test concepts');
  expect(payload.tasks).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        activityKind: 'review',
        conceptId: 'gradients',
        reason: `Review ${prerequisiteTitle} before retrying ${lessonTitle}`,
      }),
    ]),
  );
  expect(
    payload.tasks.some(
      (task: { activityKind: string; conceptId?: string }) =>
        task.activityKind === 'learn' && task.conceptId === 'gradient-descent',
    ),
  ).toBe(false);
});

test('Home choices hide a retry until its retry time is eligible', async () => {
  await activateCourse('ml-foundations');
  await completeHardAncestors('gradient-descent');
  const [run] = await db
    .insert(lessonRuns)
    .values({
      userId,
      conceptId: 'gradient-descent',
      status: 'needs_retry',
      retryAfter: new Date('2026-01-08T00:00:00.000Z'),
    })
    .returning();
  if (!run) throw new Error('Could not create retry lesson run');

  const paused = await (await get('/learn')).json();
  expect(paused.choices.map((choice: { conceptId: string }) => choice.conceptId)).not.toContain(
    'gradient-descent',
  );

  await db
    .update(lessonRuns)
    .set({ retryAfter: new Date('2026-01-07T00:00:00.000Z') })
    .where(eq(lessonRuns.id, run.id));
  const ready = await (await get('/learn')).json();
  expect(ready.choices.map((choice: { conceptId: string }) => choice.conceptId)).toContain(
    'gradient-descent',
  );
});

test('a focused session cannot start a needs-retry lesson before retryAfter', async () => {
  const courseId = content.curriculum?.default_course;
  if (!courseId) throw new Error('Missing default course');
  await activateCourse(courseId);
  await db.insert(lessonRuns).values({
    userId,
    conceptId: 'vectors',
    status: 'needs_retry',
    haltedAt: new Date('2026-01-07T11:00:00.000Z'),
    retryAfter: new Date('2026-01-08T00:00:00.000Z'),
    haltedPointIndex: 0,
    haltCount: 1,
  });
  const response = await app.request('/api/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Now': '2026-01-07T12:00:00.000Z' },
    body: JSON.stringify({ budgetMinutes: 60, focusConceptId: 'vectors' }),
  });
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: 'This lesson comes back tomorrow.' });
});

async function completeHardAncestors(conceptId: string, except: readonly string[] = []) {
  const completedIds = [...hardPrerequisiteAncestors(content, conceptId)].filter(
    (id) => !except.includes(id),
  );
  if (completedIds.length) {
    await db
      .insert(lessonRuns)
      .values(completedIds.map((id) => ({ userId, conceptId: id, status: 'completed' as const })));
  }
}

async function put(path: string, body: unknown) {
  return app.request(`/api${path}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'X-Now': '2026-01-07T12:00:00.000Z',
    },
    body: JSON.stringify(body),
  });
}

async function post(path: string, body: unknown) {
  return app.request(`/api${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Now': '2026-01-07T12:00:00.000Z',
    },
    body: JSON.stringify(body),
  });
}

test('restarting a topic clears only its progress while preserving history', async () => {
  const conceptX = 'vectors';
  const conceptY = 'supervised-learning';
  const mixedReviewExerciseIds = [
    content.exercisesByConcept.get(conceptX)?.[0]?.id,
    content.exercisesByConcept.get('derivatives')?.[0]?.id,
  ];
  const [conceptXExerciseId, conceptBExerciseId] = mixedReviewExerciseIds;
  if (!conceptXExerciseId || !conceptBExerciseId) {
    throw new Error('Could not find exercises for the mixed review fixture');
  }
  const [session] = await db
    .insert(studySessions)
    .values({ userId, plannedMinutes: 60, status: 'active' })
    .returning();
  if (!session) throw new Error('Could not create restart test session');
  const activityRows = await db
    .insert(sessionActivities)
    .values([
      {
        sessionId: session.id,
        idx: 0,
        kind: 'learn',
        conceptId: conceptX,
        plannedMinutes: 10,
        status: 'planned',
      },
      {
        sessionId: session.id,
        idx: 1,
        kind: 'learn',
        conceptId: conceptX,
        plannedMinutes: 10,
        status: 'in_progress',
      },
      {
        sessionId: session.id,
        idx: 2,
        kind: 'learn',
        conceptId: conceptX,
        plannedMinutes: 10,
        status: 'completed',
      },
      {
        sessionId: session.id,
        idx: 3,
        kind: 'learn',
        conceptId: conceptY,
        plannedMinutes: 10,
        status: 'planned',
      },
      {
        sessionId: session.id,
        idx: 4,
        kind: 'review',
        conceptId: null,
        exerciseIds: [conceptXExerciseId, conceptBExerciseId],
        plannedMinutes: 10,
        status: 'in_progress',
      },
    ])
    .returning();
  const xActivity = activityRows.find(
    (activity) => activity.conceptId === conceptX && activity.status === 'in_progress',
  );
  if (!xActivity) throw new Error('Could not find restart test activity');
  const mixedReviewActivity = activityRows.find((activity) => activity.kind === 'review');
  const unrelatedActivity = activityRows.find((activity) => activity.conceptId === conceptY);
  if (!mixedReviewActivity || !unrelatedActivity) {
    throw new Error('Could not find mixed review and unrelated activities');
  }

  const [attempt] = await db
    .insert(attempts)
    .values({
      userId,
      sessionId: session.id,
      activityId: xActivity.id,
      exerciseId: 'vectors-restart-history',
      exerciseVersion: 'test',
      conceptId: conceptX,
      dimension: 'conceptual',
      mode: 'practice',
      answer: { response: 'retained' },
      correct: 1,
      credit: 1,
      gradedBy: 'deterministic',
    })
    .returning();
  if (!attempt) throw new Error('Could not create restart test attempt');

  await db.insert(mastery).values([
    { userId, conceptId: conceptX, dimension: 'conceptual', state: 'assisted' },
    { userId, conceptId: conceptY, dimension: 'conceptual', state: 'assisted' },
  ]);
  await db.insert(masteryEvents).values([
    {
      userId,
      conceptId: conceptX,
      dimension: 'conceptual',
      fromState: 'introduced',
      toState: 'assisted',
      rule: 'restart-test',
    },
    {
      userId,
      conceptId: conceptY,
      dimension: 'conceptual',
      fromState: 'introduced',
      toState: 'assisted',
      rule: 'restart-test',
    },
  ]);
  const cards = await db
    .insert(reviewCards)
    .values([
      { userId, conceptId: conceptX, dimension: 'conceptual', fsrs: {}, dueAt: new Date() },
      { userId, conceptId: conceptY, dimension: 'conceptual', fsrs: {}, dueAt: new Date() },
    ])
    .returning();
  const cardX = cards.find((card) => card.conceptId === conceptX);
  const cardY = cards.find((card) => card.conceptId === conceptY);
  if (!cardX || !cardY) throw new Error('Could not create restart test review cards');
  await db.insert(reviewLogs).values([
    { cardId: cardX.id, attemptId: attempt.id, rating: 'good', fsrsLog: {} },
    { cardId: cardY.id, rating: 'good', fsrsLog: {} },
  ]);

  const runs = await db
    .insert(lessonRuns)
    .values([
      { userId, conceptId: conceptX, status: 'in_progress' },
      { userId, conceptId: conceptY, status: 'in_progress' },
    ])
    .returning();
  const runX = runs.find((run) => run.conceptId === conceptX);
  const runY = runs.find((run) => run.conceptId === conceptY);
  if (!runX || !runY) throw new Error('Could not create restart test lesson runs');
  await db.insert(lessonProblems).values([
    {
      runId: runX.id,
      knowledgePointId: `${conceptX}-point`,
      round: 0,
      position: 0,
      exerciseId: 'vectors-restart-history',
      attemptId: attempt.id,
    },
    {
      runId: runY.id,
      knowledgePointId: `${conceptY}-point`,
      round: 0,
      position: 0,
      exerciseId: 'supervised-learning-history',
    },
  ]);
  const quizAttempts = await db
    .insert(lessonQuizAttempts)
    .values([
      { runId: runX.id, attemptNo: 1 },
      { runId: runY.id, attemptNo: 1 },
    ])
    .returning();
  const quizX = quizAttempts.find((attemptRow) => attemptRow.runId === runX.id);
  const quizY = quizAttempts.find((attemptRow) => attemptRow.runId === runY.id);
  if (!quizX || !quizY) throw new Error('Could not create restart test quiz attempts');
  await db.insert(lessonQuizItems).values([
    {
      quizAttemptId: quizX.id,
      position: 0,
      knowledgePointId: `${conceptX}-point`,
      exerciseId: 'vectors-restart-history',
      attemptId: attempt.id,
    },
    {
      quizAttemptId: quizY.id,
      position: 0,
      knowledgePointId: `${conceptY}-point`,
      exerciseId: 'supervised-learning-history',
    },
  ]);
  await db.insert(remediationFlags).values([
    { userId, conceptId: conceptX, targetPrereqId: null },
    { userId, conceptId: conceptY, targetPrereqId: conceptX },
    { userId, conceptId: conceptY, targetPrereqId: null },
  ]);
  await db.insert(xpEvents).values({
    userId,
    kind: 'knowledge_point',
    sourceKey: 'restart-history',
    conceptId: conceptX,
    amount: 10,
    earnedAt: new Date('2026-01-07T12:00:00.000Z'),
    localDate: '2026-01-07',
  });
  await db.insert(diagnosticRuns).values({
    userId,
    kind: 'placement',
    status: 'completed',
    state: { courseId: 'ml-foundations', answers: [], known: [conceptX], unknown: [] },
    completedAt: new Date('2026-01-07T11:00:00.000Z'),
  });

  const response = await post(`/concepts/${conceptX}/restart`, {});
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ conceptId: conceptX });

  const [remainingMastery, remainingEvents, remainingCards, remainingRuns, remainingAttempts] =
    await Promise.all([
      db.select().from(mastery).where(eq(mastery.userId, userId)),
      db.select().from(masteryEvents).where(eq(masteryEvents.userId, userId)),
      db.select().from(reviewCards).where(eq(reviewCards.userId, userId)),
      db.select().from(lessonRuns).where(eq(lessonRuns.userId, userId)),
      db.select().from(attempts).where(eq(attempts.userId, userId)),
    ]);
  expect(remainingMastery.map((row) => row.conceptId)).toEqual([conceptY]);
  expect(remainingEvents.map((row) => row.conceptId)).toEqual([conceptY]);
  expect(remainingCards.map((row) => row.conceptId)).toEqual([conceptY]);
  expect(remainingRuns.map((row) => row.conceptId)).toEqual([conceptY]);
  expect(remainingAttempts.map((row) => row.id)).toEqual([attempt.id]);
  expect(await db.select().from(reviewLogs)).toMatchObject([{ cardId: cardY.id }]);
  expect(await db.select().from(lessonProblems)).toMatchObject([{ runId: runY.id }]);
  expect(await db.select().from(lessonQuizAttempts)).toMatchObject([{ runId: runY.id }]);
  expect(await db.select().from(lessonQuizItems)).toMatchObject([{ quizAttemptId: quizY.id }]);
  expect(await db.select().from(xpEvents).where(eq(xpEvents.userId, userId))).toHaveLength(1);
  expect(
    await db.select().from(remediationFlags).where(eq(remediationFlags.userId, userId)),
  ).toMatchObject([{ conceptId: conceptY, targetPrereqId: null }]);
  const remainingActivities = await db
    .select()
    .from(sessionActivities)
    .where(eq(sessionActivities.sessionId, session.id));
  expect(
    remainingActivities.find((activity) => activity.id === mixedReviewActivity.id)?.status,
  ).toBe('skipped');
  expect(remainingActivities.find((activity) => activity.id === unrelatedActivity.id)?.status).toBe(
    'planned',
  );
  expect(
    remainingActivities
      .sort((left, right) => left.idx - right.idx)
      .map((activity) => [activity.idx, activity.status]),
  ).toEqual([
    [0, 'skipped'],
    [1, 'skipped'],
    [2, 'completed'],
    [3, 'planned'],
    [4, 'skipped'],
  ]);
  const courseResponse = await get('/courses/ml-foundations');
  const course = (await courseResponse.json()) as {
    units: Array<{ topics: Array<{ conceptId: string; status: string }> }>;
  };
  const restartedTopic = course.units
    .flatMap((unit) => unit.topics)
    .find((topic) => topic.conceptId === conceptX);
  expect(restartedTopic?.status).toBe('not_started');

  expect((await post('/concepts/missing-concept/restart', {})).status).toBe(404);
});

test('restarting a completed course topic reactivates the course and removes its completion', async () => {
  const course = content.coursesById.get('ml-foundations');
  const conceptId = 'vectors';
  if (!course?.units.some((unit) => unit.concepts.includes(conceptId))) {
    throw new Error('Expected vectors to be part of ml-foundations');
  }
  const conceptIds = [...new Set(course.units.flatMap((unit) => unit.concepts))];
  await db.insert(courseEnrollments).values({
    userId,
    courseId: course.id,
    status: 'completed',
    startMethod: 'beginning',
    completedAt: new Date('2026-01-07T12:00:00.000Z'),
  });
  await db
    .insert(lessonRuns)
    .values(conceptIds.map((id) => ({ userId, conceptId: id, status: 'completed' as const })));

  const response = await post(`/concepts/${conceptId}/restart`, {});
  expect(response.status).toBe(200);
  const [enrollment] = await db
    .select()
    .from(courseEnrollments)
    .where(eq(courseEnrollments.courseId, course.id));
  expect(enrollment).toMatchObject({ status: 'active', completedAt: null });

  const today = await (await get('/today')).json();
  expect(today.studyCourses.map((studyCourse: { id: string }) => studyCourse.id)).toContain(
    course.id,
  );
  const coursePayload = await (await get(`/courses/${course.id}`)).json();
  const restartedTopic = coursePayload.units
    .flatMap((unit: { topics: Array<{ conceptId: string; status: string }> }) => unit.topics)
    .find((topic: { conceptId: string }) => topic.conceptId === conceptId);
  expect(restartedTopic?.status).toBe('not_started');
});

test('a restarted lesson does not restore its previous final answer', async () => {
  const conceptId = 'vectors';
  const lesson = content.lessonsByConcept.get(conceptId);
  const finalExercise = lesson?.final ? content.exercisesById.get(lesson.final) : undefined;
  if (!lesson?.knowledge_points?.length || !finalExercise || !lesson.final) {
    throw new Error('Expected vectors to have a knowledge-point final exercise');
  }
  const [oldSession] = await db
    .insert(studySessions)
    .values({ userId, plannedMinutes: 60, status: 'completed' })
    .returning();
  if (!oldSession) throw new Error('Could not create the previous lesson session');
  const [oldActivity] = await db
    .insert(sessionActivities)
    .values({
      sessionId: oldSession.id,
      idx: 0,
      kind: 'learn',
      conceptId,
      exerciseIds: [lesson.final],
      plannedMinutes: 10,
      status: 'completed',
    })
    .returning();
  if (!oldActivity) throw new Error('Could not create the previous lesson activity');
  await db.insert(lessonRuns).values({
    userId,
    conceptId,
    status: 'completed',
    startedAt: new Date('2026-01-01T09:00:00.000Z'),
  });
  await db.insert(attempts).values({
    userId,
    sessionId: oldSession.id,
    activityId: oldActivity.id,
    exerciseId: lesson.final,
    exerciseVersion: finalExercise.contentVersion,
    conceptId,
    dimension: finalExercise.dimension,
    mode: 'practice',
    answer: { text: 'A previously completed final answer.' },
    correct: 1,
    credit: 1,
    attemptNo: 1,
    gradedBy: 'test',
    feedback: {},
    createdAt: new Date('2026-01-06T09:00:00.000Z'),
  });

  expect((await post(`/concepts/${conceptId}/restart`, {})).status).toBe(200);
  const sessionResponse = await post('/sessions', {
    budgetMinutes: 60,
    focusConceptId: conceptId,
  });
  expect(sessionResponse.status).toBe(201);
  const session = await sessionResponse.json();
  const activity = session.activities.find(
    (candidate: { kind: string; conceptId: string }) =>
      candidate.kind === 'learn' && candidate.conceptId === conceptId,
  );
  if (!activity?.exerciseIds.includes(lesson.final)) {
    throw new Error('Could not find the restarted final exercise in the new session');
  }
  expect(activity.progress?.completedExerciseIds ?? []).not.toContain(lesson.final);
  const runResponse = await post(`/lessons/${conceptId}/run`, { activityId: activity.id });
  expect(runResponse.status).toBe(200);
  expect(
    (await db.select().from(sessionActivities).where(eq(sessionActivities.id, activity.id)))[0]
      ?.progress,
  ).not.toMatchObject({ completedExerciseIds: [lesson.final] });
});

test('restarting a prerequisite skips planned and in-progress dependent activities', async () => {
  const prerequisiteId = 'tokenization';
  const dependentId = 'embeddings';
  const dependent = content.conceptsById.get(dependentId);
  if (
    !dependent?.prereqs.some(
      (prerequisite) => prerequisite.id === prerequisiteId && prerequisite.strength === 'hard',
    )
  ) {
    throw new Error('Expected embeddings to have tokenization as a hard prerequisite');
  }
  const unrelated = [...content.conceptsById.values()].find(
    (concept) =>
      concept.id !== prerequisiteId &&
      concept.id !== dependentId &&
      concept.prereqs.every((prerequisite) => prerequisite.strength !== 'hard'),
  );
  if (!unrelated) throw new Error('Could not find a concept without hard prerequisites');
  const assistedDependent = [...content.conceptsById.values()].find((concept) => {
    const hardPrerequisites = concept.prereqs.filter(
      (prerequisite) => prerequisite.strength === 'hard',
    );
    if (
      concept.id === prerequisiteId ||
      concept.id === dependentId ||
      hardPrerequisites.length !== 1 ||
      hardPrerequisites[0]?.id === prerequisiteId ||
      hardPrerequisites[0]?.id === 'matrices'
    ) {
      return false;
    }
    return (content.conceptsById.get(hardPrerequisites[0]?.id ?? '')?.dimensions.length ?? 0) > 1;
  });
  const assistedPrerequisite = assistedDependent?.prereqs.find(
    (prerequisite) => prerequisite.strength === 'hard',
  );
  const assistedPrerequisiteConcept = assistedPrerequisite
    ? content.conceptsById.get(assistedPrerequisite.id)
    : undefined;
  if (!assistedDependent || !assistedPrerequisiteConcept?.dimensions[0]) {
    throw new Error('Could not find a dependent with a multi-dimension hard prerequisite');
  }

  const [session] = await db
    .insert(studySessions)
    .values({ userId, plannedMinutes: 60, status: 'active' })
    .returning();
  if (!session) throw new Error('Could not create prerequisite restart session');
  const runs = await db
    .insert(lessonRuns)
    .values([
      { userId, conceptId: prerequisiteId, status: 'completed' },
      { userId, conceptId: 'matrices', status: 'completed' },
      { userId, conceptId: dependentId, status: 'in_progress' },
      ...[...hardPrerequisiteAncestors(content, assistedDependent.id)]
        .filter(
          (conceptId) =>
            ![prerequisiteId, 'matrices', dependentId, assistedPrerequisiteConcept.id].includes(
              conceptId,
            ),
        )
        .map((conceptId) => ({ userId, conceptId, status: 'completed' as const })),
    ])
    .returning();
  const dependentRun = runs.find((run) => run.conceptId === dependentId);
  if (!dependentRun) throw new Error('Could not create dependent lesson run');
  await db.insert(lessonProblems).values({
    runId: dependentRun.id,
    knowledgePointId: `${dependentId}-preserved`,
    round: 0,
    position: 0,
    exerciseId: `${dependentId}-preserved-answer`,
    answeredAt: new Date('2026-01-07T09:00:00.000Z'),
    correct: 1,
  });
  await db.insert(mastery).values({
    userId,
    conceptId: assistedPrerequisiteConcept.id,
    dimension: assistedPrerequisiteConcept.dimensions[0],
    state: 'assisted',
  });
  await db.insert(sessionActivities).values([
    {
      sessionId: session.id,
      idx: 0,
      kind: 'learn',
      conceptId: dependentId,
      plannedMinutes: 10,
      status: 'planned',
    },
    {
      sessionId: session.id,
      idx: 1,
      kind: 'learn',
      conceptId: dependentId,
      plannedMinutes: 10,
      status: 'in_progress',
      startedAt: new Date('2026-01-07T09:00:00.000Z'),
      progress: { lessonViewed: true, savedAnswer: 'keep-me' },
    },
    {
      sessionId: session.id,
      idx: 2,
      kind: 'learn',
      conceptId: dependentId,
      plannedMinutes: 10,
      status: 'completed',
    },
    {
      sessionId: session.id,
      idx: 3,
      kind: 'learn',
      conceptId: unrelated.id,
      plannedMinutes: 10,
      status: 'planned',
    },
    {
      sessionId: session.id,
      idx: 4,
      kind: 'learn',
      conceptId: assistedDependent.id,
      plannedMinutes: 10,
      status: 'planned',
    },
  ]);

  const response = await post(`/concepts/${prerequisiteId}/restart`, {});
  expect(response.status).toBe(200);
  const activities = await db
    .select()
    .from(sessionActivities)
    .where(eq(sessionActivities.sessionId, session.id));
  expect(
    activities
      .sort((left, right) => left.idx - right.idx)
      .map((activity) => [activity.conceptId, activity.status]),
  ).toEqual([
    [dependentId, 'skipped'],
    [dependentId, 'skipped'],
    [dependentId, 'completed'],
    [unrelated.id, 'planned'],
    [assistedDependent.id, 'planned'],
  ]);
  expect(activities.find((activity) => activity.idx === 1)?.progress).toEqual({
    lessonViewed: true,
    savedAnswer: 'keep-me',
  });
  expect(
    await db.select().from(lessonRuns).where(eq(lessonRuns.id, dependentRun.id)),
  ).toMatchObject([{ status: 'in_progress', id: dependentRun.id }]);
  expect(
    await db.select().from(lessonProblems).where(eq(lessonProblems.runId, dependentRun.id)),
  ).toMatchObject([
    {
      knowledgePointId: `${dependentId}-preserved`,
      exerciseId: `${dependentId}-preserved-answer`,
    },
  ]);
});

test('restarting an indirect ancestor keeps a completed descendant review planned', async () => {
  const descendantId = 'eigen-svd';
  const descendant = content.conceptsById.get(descendantId);
  if (!descendant) throw new Error('Expected eigen-svd');
  const hardAncestors = hardPrerequisiteAncestors(content, descendantId);
  const ancestorId = [...hardAncestors].find(
    (id) => !descendant.prereqs.some((prerequisite) => prerequisite.id === id),
  );
  if (!ancestorId) throw new Error('Expected an indirect hard ancestor for eigen-svd');
  const exerciseId = [...content.exercisesById.values()].find(
    (exercise) => exercise.concept === descendantId,
  )?.id;
  if (!exerciseId) throw new Error('Expected an eigen-svd exercise');

  await db.insert(lessonRuns).values(
    [...hardAncestors, descendantId].map((conceptId) => ({
      userId,
      conceptId,
      status: 'completed' as const,
    })),
  );
  const [session] = await db
    .insert(studySessions)
    .values({ userId, plannedMinutes: 60, status: 'active' })
    .returning();
  if (!session) throw new Error('Could not create descendant review session');
  const [review] = await db
    .insert(sessionActivities)
    .values({
      sessionId: session.id,
      idx: 0,
      kind: 'review',
      conceptId: descendantId,
      exerciseIds: [exerciseId],
      plannedMinutes: 10,
      status: 'planned',
    })
    .returning();
  if (!review) throw new Error('Could not create descendant review');
  const [practice] = await db
    .insert(sessionActivities)
    .values({
      sessionId: session.id,
      idx: 1,
      kind: 'practice',
      conceptId: descendantId,
      exerciseIds: [exerciseId],
      plannedMinutes: 10,
      status: 'planned',
    })
    .returning();
  if (!practice) throw new Error('Could not create descendant practice');

  const restart = await post(`/concepts/${ancestorId}/restart`, {});
  expect(restart.status).toBe(200);
  const [afterRestart] = await db
    .select()
    .from(sessionActivities)
    .where(eq(sessionActivities.id, review.id));
  expect(afterRestart?.status).toBe('planned');
  const [practiceAfterRestart] = await db
    .select()
    .from(sessionActivities)
    .where(eq(sessionActivities.id, practice.id));
  expect(practiceAfterRestart?.status).toBe('skipped');
});

test('learners can switch to a listed course', async () => {
  const response = await put('/course/active', { courseId: 'reinforcement-learning' });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ courseId: 'reinforcement-learning' });
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  expect(user?.activeCourseId).toBe('reinforcement-learning');
  const coursePayload = await (await get('/course')).json();
  expect(coursePayload.course).toMatchObject({
    id: 'reinforcement-learning',
    title: 'Reinforcement Learning',
  });
  expect(
    coursePayload.courses.find((course: { id: string }) => course.id === 'reinforcement-learning'),
  ).toMatchObject({
    active: true,
    topicsTotal: expect.any(Number),
  });
  const learnPayload = await (await get('/learn')).json();
  expect(learnPayload.streak).toMatchObject({
    current: expect.any(Number),
    longest: expect.any(Number),
    todayComplete: expect.any(Boolean),
    days: expect.any(Array),
  });
  expect(learnPayload.streak.days).toHaveLength(7);
  expect(learnPayload.course).toMatchObject({
    title: 'Reinforcement Learning',
    topicsTotal: coursePayload.units.reduce(
      (total: number, unit: { topics: unknown[] }) => total + unit.topics.length,
      0,
    ),
  });
});

test('study set backfill includes started courses and later respects removal', async () => {
  const courseA = content.coursesById.get('ml-foundations');
  const courseB = content.coursesById.get('deep-learning');
  if (!courseA || !courseB) throw new Error('Missing study set test courses');
  const conceptFor = (course: NonNullable<typeof courseA>, excluded: Set<string> = new Set()) => {
    const conceptId = course.units
      .flatMap((unit) => unit.concepts)
      .find((id) => !excluded.has(id) && content.conceptsById.get(id)?.dimensions[0]);
    if (!conceptId) throw new Error(`Missing test concept in ${course.id}`);
    const dimension = content.conceptsById.get(conceptId)?.dimensions[0];
    if (!dimension) throw new Error(`Missing test dimension for ${conceptId}`);
    return { conceptId, dimension };
  };
  const a = conceptFor(courseA);
  const b = conceptFor(courseB, new Set(courseA.units.flatMap((unit) => unit.concepts)));
  await db.update(users).set({ activeCourseId: courseA.id }).where(eq(users.id, userId));
  await db.insert(mastery).values([
    { userId, conceptId: a.conceptId, dimension: a.dimension, state: 'introduced', evidence: {} },
    { userId, conceptId: b.conceptId, dimension: b.dimension, state: 'introduced', evidence: {} },
  ]);

  const repository = repositoryFor();
  expect(await repository.studyCourseIds(content)).toEqual(
    (content.curriculum?.courses ?? content.courses.map((course) => course.id)).filter((id) =>
      [courseA.id, courseB.id].includes(id),
    ),
  );

  await repository.setCourseEnrollmentStatus(courseB.id, 'paused');
  expect(await repository.studyCourseIds(content)).toEqual([courseA.id]);
});

test('an unstarted selected course stays unenrolled and still needs its start card', async () => {
  const course = content.coursesById.get('ml-foundations');
  if (!course) throw new Error('Missing ML Foundations course');
  await db.update(users).set({ activeCourseId: course.id }).where(eq(users.id, userId));

  const response = await get(`/courses/${course.id}`);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    status: 'not_started',
    courseStart: { courseId: course.id, needed: true, placementRunId: null },
  });
  expect(
    await db.select().from(courseEnrollments).where(eq(courseEnrollments.userId, userId)),
  ).toEqual([]);
});

test('study-course membership refreshes after a course is started in the same repository', async () => {
  const repository = repositoryFor();
  expect(await repository.studyCourseIds(content)).toEqual([]);

  await repository.startCourse('deep-learning', 'beginning', new Date('2026-01-07T12:00:00.000Z'));

  expect(await repository.studyCourseIds(content)).toEqual(['deep-learning']);
});

test('course query views a requested course without changing the stored active course', async () => {
  await put('/course/active', { courseId: 'reinforcement-learning' });

  const response = await get('/course?course=deep-learning');
  expect(response.status).toBe(200);
  const payload = await response.json();
  expect(payload.course).toMatchObject({ id: 'deep-learning' });
  expect(
    payload.courses.find((course: { id: string }) => course.id === 'deep-learning'),
  ).toMatchObject({ active: true });
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  expect(user?.activeCourseId).toBe('reinforcement-learning');

  const unknownCourse = await (await get('/course?course=missing-course')).json();
  expect(unknownCourse.course).toMatchObject({ id: 'reinforcement-learning' });
});

test('starting a course uses a valid requested courseId instead of the active course', async () => {
  await put('/course/active', { courseId: 'reinforcement-learning' });

  const response = await post('/course/start', {
    method: 'beginning',
    courseId: 'deep-learning',
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ courseId: 'deep-learning', method: 'beginning' });

  const enrollments = await db
    .select()
    .from(courseEnrollments)
    .where(eq(courseEnrollments.userId, userId));
  expect(enrollments.some((enrollment) => enrollment.courseId === 'deep-learning')).toBe(true);
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  expect(user?.activeCourseId).toBe('reinforcement-learning');
});

test('course catalogue and enrollment routes start, pause, and reactivate courses', async () => {
  const catalog = await (await get('/courses')).json();
  expect(
    catalog.subjects.map((subject: { id: string; title: string }) => ({
      id: subject.id,
      title: subject.title,
    })),
  ).toEqual([
    { id: 'mathematics', title: 'Mathematics' },
    { id: 'ai', title: 'AI' },
  ]);
  for (const subject of catalog.subjects as Array<{ id: string; courses: Array<{ id: string }> }>) {
    expect(subject.courses.map((course) => course.id)).toEqual(
      (content.curriculum?.courses ?? content.courses.map((course) => course.id)).filter(
        (courseId) => subjectForCourse(content, courseId).id === subject.id,
      ),
    );
  }
  const courses = catalog.subjects.flatMap(
    (subject: { courses: Array<{ id: string; status: string; startNeeded: boolean }> }) =>
      subject.courses,
  );
  expect(new Set(courses.map((course: { id: string }) => course.id))).toEqual(
    new Set(content.curriculum?.courses ?? content.courses.map((course) => course.id)),
  );
  expect(courses.find((course: { id: string }) => course.id === 'deep-learning')).toMatchObject({
    status: 'not_started',
    startNeeded: true,
  });

  const detail = await (await get('/courses/deep-learning')).json();
  expect(detail).toMatchObject({
    course: { id: 'deep-learning' },
    status: 'not_started',
    suggestedNext: [],
    queue: null,
  });
  expect((await put('/courses/deep-learning/enrollment', { status: 'active' })).status).toBe(409);

  expect(
    (
      await post('/courses/deep-learning/start', {
        method: 'beginning',
      })
    ).status,
  ).toBe(200);
  expect((await (await get('/courses/deep-learning')).json()).queue).not.toBeNull();
  expect(
    (
      await put('/courses/deep-learning/enrollment', {
        status: 'paused',
      })
    ).status,
  ).toBe(200);
  const pausedCatalog = await (await get('/courses')).json();
  expect(
    pausedCatalog.subjects
      .flatMap((subject: { courses: Array<{ id: string; status: string }> }) => subject.courses)
      .find((course: { id: string }) => course.id === 'deep-learning')?.status,
  ).toBe('paused');

  expect(
    (
      await put('/courses/deep-learning/enrollment', {
        status: 'active',
      })
    ).status,
  ).toBe(200);
});

test('active subjects report whether their active courses have lessons', async () => {
  const courseIds = (
    content.curriculum?.courses ?? content.courses.map((course) => course.id)
  ).filter((courseId) => ['mathematics', 'ai'].includes(subjectForCourse(content, courseId).id));
  await db.insert(courseEnrollments).values(
    courseIds.map((courseId) => ({
      userId,
      courseId,
      status: 'active' as const,
      startMethod: 'beginning' as const,
    })),
  );

  const learn = await (await get('/learn')).json();

  expect(
    learn.activeSubjects.map((subject: { id: string; title: string; hasLessons: boolean }) => ({
      id: subject.id,
      title: subject.title,
      hasLessons: subject.hasLessons,
    })),
  ).toEqual([
    { id: 'mathematics', title: 'Mathematics', hasLessons: true },
    { id: 'ai', title: 'AI', hasLessons: true },
  ]);
});

test('course details persist completion when every topic is complete', async () => {
  const course = content.coursesById.get('deep-learning');
  if (!course) throw new Error('Missing deep learning course');
  const records = course.units
    .flatMap((unit) => unit.concepts)
    .flatMap((conceptId) => {
      const concept = content.conceptsById.get(conceptId);
      return (concept?.dimensions ?? []).map((dimension) => ({
        userId,
        conceptId,
        dimension,
        state: 'independent' as const,
        evidence: {},
      }));
    });
  await db.insert(mastery).values(records);

  const detail = await (await get('/courses/deep-learning')).json();
  expect(detail.status).toBe('completed');
  const enrollment = await repositoryFor().courseEnrollment('deep-learning');
  expect(enrollment).toMatchObject({
    status: 'completed',
    completedAt: expect.any(Date),
  });
});

test('switching to an unknown course returns 404 without changing learner state', async () => {
  const response = await put('/course/active', { courseId: 'missing-course' });
  expect(response.status).toBe(404);
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  expect(user?.activeCourseId).toBeNull();
});

test('course outlines list shared-course dependents once', async () => {
  const fixtureContent = await loadContent('tests/fixtures/content');
  const fixtureApp = createApp({ db, content: fixtureContent, tutorProvider: null });
  const response = await fixtureApp.request('/api/course', {
    headers: { 'X-Now': '2026-01-07T12:00:00.000Z' },
  });
  expect(response.status).toBe(200);
  expect(
    fixtureContent.courses.filter((course) =>
      course.units.some((unit) => unit.concepts.includes('linear-models')),
    ),
  ).toHaveLength(2);
  const coursePayload = (await response.json()) as {
    units: Array<{
      topics: Array<{
        conceptId: string;
        leadsTo: Array<{ id: string }>;
        leadsToMore: number;
      }>;
    }>;
  };
  const topics = coursePayload.units.flatMap((unit) => unit.topics);
  const vectorDependents = [
    ...new Set(
      fixtureContent.courses
        .flatMap((course) => course.units.flatMap((unit) => unit.concepts))
        .filter((conceptId) =>
          fixtureContent.conceptsById
            .get(conceptId)
            ?.prereqs.some((prerequisite) => prerequisite.id === 'vectors'),
        ),
    ),
  ];
  const vectors = topics.find((topic) => topic.conceptId === 'vectors');
  expect(vectors?.leadsTo.map(({ id }) => id)).toEqual(vectorDependents.slice(0, 3));
  expect(vectors?.leadsToMore).toBe(Math.max(0, vectorDependents.length - 3));

  const supervisedLearning = topics.find((topic) => topic.conceptId === 'supervised-learning');
  expect(supervisedLearning?.leadsTo.map(({ id }) => id)).toEqual(['linear-models']);
  expect(supervisedLearning?.leadsToMore).toBe(0);
});

test('paper completion changes only its reading status, not learner progress', async () => {
  const defaultCourse = content.coursesById.get(content.curriculum?.default_course ?? '');
  const paperId = defaultCourse?.units.flatMap((unit) => unit.papers ?? [])[0];
  const paper = paperId ? content.papersById.get(paperId) : undefined;
  if (!paper) throw new Error('Expected paper content');

  const beforeLearn = await (await get('/learn')).json();
  const beforeCourse = (await (await get('/course')).json()) as {
    currentUnit: number;
    units: Array<{
      papers: Array<{ id: string; status: string }>;
      topics: Array<{ conceptId: string; status: string }>;
    }>;
  };
  const now = new Date('2026-01-07T12:00:00.000Z');
  await db.insert(paperProgress).values({
    userId,
    paperId: paper.id,
    completedAt: now,
    updatedAt: now,
  });
  const afterLearn = await (await get('/learn')).json();
  const afterCourse = (await (await get('/course')).json()) as typeof beforeCourse;
  const paperStatus = (course: typeof beforeCourse) =>
    course.units
      .flatMap((unit) => unit.papers)
      .find((entry: { id: string }) => entry.id === paper.id)?.status;
  const topicProgress = (course: typeof beforeCourse) =>
    course.units.flatMap((unit) =>
      unit.topics.map((topic: { conceptId: string; status: string }) => [
        topic.conceptId,
        topic.status,
      ]),
    );

  expect(paperStatus(beforeCourse)).toBe('not_started');
  expect(paperStatus(afterCourse)).toBe('completed');
  expect(afterLearn.xp).toEqual(beforeLearn.xp);
  expect(afterLearn.course).toEqual(beforeLearn.course);
  expect(afterCourse.currentUnit).toBe(beforeCourse.currentUnit);
  expect(topicProgress(afterCourse)).toEqual(topicProgress(beforeCourse));
});

const nnFromScratchTestIds = [
  'test_data_is_seeded_and_split',
  'test_parameter_forward_and_gradient_shapes',
  'test_forward_matches_reference',
  'test_loss_matches_mean_binary_cross_entropy',
  'test_gradients_match_numerical_differences',
  'test_training_step_lowers_loss',
  'test_training_reaches_validation_accuracy',
  'test_hidden_layer_beats_linear_baseline',
];

const nnFromScratchPassingMetrics = {
  final_train_loss: 0.05,
  validation_accuracy: 0.95,
  max_gradient_check_relative_error: 0.000001,
};

function nnFromScratchResults(
  tests = nnFromScratchTestIds.map((id) => ({ id, passed: true, message: 'passed' })),
  metrics = nnFromScratchPassingMetrics,
) {
  return {
    project: 'nn-from-scratch',
    version: 1,
    tests,
    metrics,
    generated_at: '2026-11-14T12:00:00.000Z',
  };
}

test('lesson response includes ordered authored prerequisites', async () => {
  const response = await get('/lessons/gradient-descent');
  expect(response.status).toBe(200);
  expect((await response.json()).prerequisites).toMatchObject([
    {
      id: 'gradients',
      title: 'Gradient vectors',
      recap: expect.stringContaining('The gradient'),
    },
    {
      id: 'loss-functions',
      title: 'Loss functions (MSE, MAE)',
      recap: expect.stringContaining('A loss is one number'),
    },
    {
      id: 'linear-regression',
      title: 'Linear regression',
      recap: expect.stringContaining('A linear model predicts'),
    },
  ]);
});

test('planned Learn tasks and Course numbering are read-only', async () => {
  await db
    .update(users)
    .set({ activeCourseId: content.curriculum?.default_course ?? content.courses[0]?.id ?? null })
    .where(eq(users.id, userId));
  const courseId = content.curriculum?.default_course ?? content.courses[0]?.id;
  if (!courseId) throw new Error('Missing default course');
  await db.insert(courseEnrollments).values({
    userId,
    courseId,
    startMethod: 'beginning',
  });
  const before = await rowCounts();
  const learnResponse = await get('/learn');
  expect(learnResponse.status).toBe(200);
  const learn = await learnResponse.json();
  expect(learn.activeSessionId).toBeNull();
  expect(
    learn.upNext.upcoming
      .filter((topic: { dayLabel: string }) => topic.dayLabel === 'Today')
      .map((topic: { conceptId: string }) => topic.conceptId),
  ).toEqual(
    learn.tasks
      .filter((task: { activityKind: string }) => task.activityKind === 'learn')
      .map((task: { conceptId: string }) => task.conceptId),
  );
  expect(learn.tasks.length).toBeGreaterThan(0);
  expect(learn.tasks[0]).toMatchObject({
    id: expect.any(String),
    label: expect.stringMatching(/^(Lesson|Review|Practice|Project|Quiz)$/),
    title: expect.any(String),
    xp: expect.any(Number),
    prerequisites: expect.any(Array),
  });
  expect(new Set(learn.tasks.map((task: { id: string }) => task.id)).size).toBe(learn.tasks.length);
  expect(learn.course).toMatchObject({
    percentComplete: expect.any(Number),
    topicsDone: expect.any(Number),
    topicsTotal: expect.any(Number),
    estimatedFinish: expect.any(String),
    estimatedFinishAtGoal: expect.any(String),
  });

  const courseResponse = await get('/course');
  expect(courseResponse.status).toBe(200);
  const course: {
    course: { id: string; title: string; description: string };
    courses: Array<{
      id: string;
      title: string;
      description: string;
      topicsDone: number;
      topicsTotal: number;
      active: boolean;
    }>;
    currentUnit: number;
    foundations: Array<{ number: string; conceptId: string; title: string }>;
    units: Array<{
      unit: number;
      title: string;
      intro: string;
      project: {
        id: string;
        title: string;
        authored: boolean;
        available: boolean;
        status: 'not_started' | 'in_progress' | 'completed';
      } | null;
      topics: Array<{
        number: string;
        conceptId: string;
        title: string;
        hasLesson: boolean;
        status: string;
        mastery: string;
        needs?: Array<{ id: string; title: string }>;
        buildsOn: Array<{ id: string; title: string }>;
        leadsTo: Array<{ id: string; title: string }>;
        leadsToMore: number;
      }>;
    }>;
  } = await courseResponse.json();
  expect(course.course).toMatchObject({
    id: 'ml-foundations',
    title: 'Machine Learning Foundations',
    description: expect.any(String),
  });
  expect(course.courses.find((entry) => entry.id === course.course.id)).toMatchObject({
    active: true,
    topicsDone: 0,
    topicsTotal: expect.any(Number),
  });
  expect(course.currentUnit).toBe(1);
  expect(course.foundations).toEqual(expect.any(Array));
  expect(course.courses.some((entry) => entry.active)).toBe(true);
  expect(course.units[0].topics[0]).toMatchObject({
    number: '1.1',
    conceptId: 'what-is-ml',
    title: 'What machine learning is, and how this course fits together',
    status: expect.stringMatching(/^(locked|not_started|in_progress|complete)$/),
    mastery: 'Not started',
  });
  expect(course.units[0]).toMatchObject({
    intro:
      "You'll build the simplest model that learns: predicting a house's price from its measurements, trained on past sales. The maths topics are the tools this model needs, taught in the order it needs them.",
    project: {
      id: 'linreg-numpy',
      title: expect.any(String),
      authored: true,
      available: false,
      status: 'not_started',
    },
  });
  expect(
    course.units[0].topics.find((topic) => topic.conceptId === 'supervised-learning'),
  ).toMatchObject({
    buildsOn: [
      {
        id: 'what-is-ml',
        title: 'What machine learning is, and how this course fits together',
      },
    ],
    leadsTo: expect.arrayContaining([expect.objectContaining({ id: 'linear-regression' })]),
    leadsToMore: expect.any(Number),
  });
  const dotProduct = course.units
    .flatMap((unit) => unit.topics)
    .find((topic) => topic.conceptId === 'dot-product');
  expect(dotProduct).toMatchObject({
    needs: [{ id: 'vectors', title: 'Vectors and vector operations' }],
  });
  const masteryByKey = new Map<string, Pick<MasteryRecord, 'state' | 'inferred'>>();
  const lessonRuns: Array<{
    conceptId: string;
    status: 'in_progress' | 'needs_retry' | 'completed';
  }> = [];
  const prerequisiteChecker = createPrerequisiteChecker(masteryByKey, lessonRuns, content);
  for (const topic of course.units.flatMap((unit) => unit.topics)) {
    const concept = content.conceptsById.get(topic.conceptId);
    const locked = Boolean(concept && !prerequisiteChecker.chainReady(concept.id));
    expect(topic.status === 'locked').toBe(locked);
  }
  expect(await rowCounts()).toEqual(before);
});

test('course payload marks stub projects as unauthored', async () => {
  await activateCourse('llm-inference');

  const course = (await (await get('/course')).json()) as {
    units: Array<{
      project: { id: string; authored: boolean; available: boolean } | null;
    }>;
  };
  const project = course.units.find((unit) => unit.project?.id === 'inference-engine')?.project;

  expect(project).toMatchObject({
    id: 'inference-engine',
    authored: false,
    available: false,
  });
});

test('Home previews the same quiz-first activities as a new session', async () => {
  const quizContent = await loadContent('content');
  const quizApp = createApp({ db, content: quizContent, tutorProvider: null });
  const now = '2026-01-14T12:00:00.000Z';
  await db
    .update(users)
    .set({ activeCourseId: 'ml-foundations', prefs: { scheduleMinutes: 35 } })
    .where(eq(users.id, userId));
  await db.insert(lessonRuns).values(
    quizContent.lessons.map(({ concept }) => ({
      userId,
      conceptId: concept,
      status: 'completed' as const,
      completedAt: new Date(now),
    })),
  );
  await repositoryFor().completeCourses(
    quizContent.courses.map(({ id }) => id),
    new Date(now),
  );
  await db.insert(xpEvents).values({
    userId,
    amount: 150,
    kind: 'knowledge_point',
    sourceKey: 'test:home-quiz',
    earnedAt: new Date(now),
    localDate: '2026-01-14',
  });
  const headers = { 'X-Now': now, 'Content-Type': 'application/json' };
  const home = await quizApp.request('/api/learn', { headers });
  expect(home.status).toBe(200);
  const session = await quizApp.request('/api/sessions', { method: 'POST', headers, body: '{}' });
  expect(session.status).toBe(201);
  const { activities } = await session.json();
  expect(activities[0].kind).toBe('mixed_quiz');
  const { tasks } = await home.json();
  expect(tasks[0]).toMatchObject({
    activityKind: 'mixed_quiz',
    label: 'Quiz',
    title: 'Timed quiz',
  });
  expect(tasks.map(({ activityKind }: { activityKind: string }) => activityKind)).toEqual(
    activities.map(({ kind }: { kind: string }) => kind),
  );
});

test('session creation matches the local-day preview kind and activities', async () => {
  for (const [now, expectedKind] of [
    ['2026-11-14T12:00:00.000Z', 'saturday'],
    ['2026-11-15T12:00:00.000Z', 'sunday'],
    ['2026-11-16T12:00:00.000Z', 'weekday'],
  ] as const) {
    const headers = { 'X-Now': now, 'X-Time-Zone': 'UTC' };
    const previewResponse = await app.request('/api/today', { headers });
    expect(previewResponse.status).toBe(200);
    const preview = await previewResponse.json();
    expect(preview.sessionKind).toBe(expectedKind);
    const home = await (await app.request('/api/learn', { headers })).json();
    expect(home.today).toMatchObject({
      needsCourseChoice: preview.needsCourseChoice,
      courseStart: preview.courseStart,
      sessionKind: preview.sessionKind,
    });

    const createdResponse = await app.request('/api/sessions', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json();
    expect(created.kind).toBe(preview.sessionKind);
    expect(created.activities.map((activity: { kind: string }) => activity.kind)).toEqual(
      preview.plan.activities.map((activity: { kind: string }) => activity.kind),
    );
  }
});

test('lesson choices exclude locked, completed and stub concepts and retain the recommended lesson past five', async () => {
  const defaultCourseId = content.curriculum?.default_course ?? content.courses[0]?.id;
  if (!defaultCourseId) throw new Error('Expected a default course');
  await db.update(users).set({ activeCourseId: defaultCourseId }).where(eq(users.id, userId));
  await db.insert(courseEnrollments).values(
    content.courses.map((course) => ({
      userId,
      courseId: course.id,
      startMethod: 'beginning' as const,
    })),
  );
  const outlineIds = Array.from(
    new Set(content.courses.flatMap((course) => course.units.flatMap((unit) => unit.concepts))),
  );
  const initial = await (await get('/learn')).json();
  const initialChoiceIds = initial.choices.map((choice: { conceptId: string }) => choice.conceptId);
  expect(initialChoiceIds).not.toContain('dot-product');
  const stubConceptId = initialChoiceIds.find((conceptId: string) =>
    content.lessonsByConcept.has(conceptId),
  );
  if (!stubConceptId) throw new Error('Expected an available lesson to mark as a stub');
  const stubApp = createApp({
    db,
    content: withStubConcept(content, stubConceptId),
    tutorProvider: null,
  });
  const stubbedInitialResponse = await stubApp.request('/api/learn', {
    headers: { 'X-Now': '2026-01-07T12:00:00.000Z' },
  });
  expect(stubbedInitialResponse.status).toBe(200);
  const stubbedInitial = await stubbedInitialResponse.json();
  expect(
    stubbedInitial.choices.map((choice: { conceptId: string }) => choice.conceptId),
  ).not.toContain(stubConceptId);

  const targets: typeof content.concepts = [];
  for (const conceptId of outlineIds) {
    const concept = content.conceptsById.get(conceptId);
    const lesson = content.lessonsByConcept.get(conceptId);
    const ancestors = hardPrerequisiteAncestors(content, conceptId);
    if (
      concept?.status !== 'authored' ||
      !lesson?.knowledge_points?.length ||
      targets.some(
        (target) =>
          ancestors.has(target.id) || hardPrerequisiteAncestors(content, target.id).has(conceptId),
      )
    ) {
      continue;
    }
    targets.push(concept);
    if (targets.length === 6) break;
  }
  if (targets.length !== 6) throw new Error('Expected six independent authored lessons');
  const targetIds = new Set(targets.map((concept) => concept.id));
  await db
    .update(users)
    .set({ prefs: { scheduleMinutes: 600 } })
    .where(eq(users.id, userId));
  await db.insert(lessonRuns).values(
    content.concepts
      .filter((concept) => !targetIds.has(concept.id))
      .map((concept) => ({
        userId,
        conceptId: concept.id,
        status: 'completed' as const,
        completedAt: new Date('2026-01-07T11:00:00.000Z'),
      })),
  );
  const recommendedConcept = targets[5];
  if (!recommendedConcept) throw new Error('Expected a sixth lesson target');
  await db.insert(lessonRuns).values({
    userId,
    conceptId: recommendedConcept.id,
    status: 'in_progress',
  });

  const learn = await (await get('/learn')).json();
  const recommendedConceptId = learn.tasks.find(
    (task: { activityKind: string; conceptId?: string }) => task.activityKind === 'learn',
  )?.conceptId;
  expect(recommendedConceptId).toBe(recommendedConcept.id);
  expect(learn.choices.map((choice: { conceptId: string }) => choice.conceptId)).toEqual([
    ...targets.slice(0, 5).map((concept) => concept.id),
    recommendedConcept.id,
  ]);
  expect(learn.choices).toHaveLength(6);
  expect(learn.choices[5]).toMatchObject({
    conceptId: recommendedConcept.id,
    recommended: true,
  });
  expect(
    learn.choices.slice(0, 5).every((choice: { recommended: boolean }) => !choice.recommended),
  ).toBe(true);
  expect(learn.choices.map((choice: { conceptId: string }) => choice.conceptId)).not.toContain(
    'dot-product',
  );
  expect(learn.choices[0]?.xp).toBe(
    (content.lessonsByConcept.get(targets[0]?.id ?? '')?.knowledge_points?.length ?? 0) * 10,
  );
});

test('course details group builds-on topics by source course in subject order', async () => {
  const payload = await (await get('/courses/transformers-llms')).json();

  expect(payload.buildsOn).toEqual([
    {
      courseId: 'maths-for-ml',
      title: 'Mathematics for Machine Learning',
      topicCount: 4,
      remaining: 4,
    },
    {
      courseId: 'ml-foundations',
      title: 'Machine Learning Foundations',
      topicCount: 20,
      remaining: 20,
    },
    { courseId: 'deep-learning', title: 'Deep Learning', topicCount: 6, remaining: 6 },
    {
      courseId: 'reinforcement-learning',
      title: 'Reinforcement Learning',
      topicCount: 6,
      remaining: 6,
    },
  ]);
});

test('course details reduce builds-on remaining count when a foundation topic is complete', async () => {
  const courseId = 'transformers-llms';
  const conceptId = [...courseFoundationIds(content, courseId)].find((id) =>
    content.lessonsByConcept.has(id),
  );
  if (!conceptId) throw new Error('Missing lessoned foundation topic');
  const sourceCourse = content.courses.find((course) =>
    course.units.some((unit) => unit.concepts.includes(conceptId)),
  );
  if (!sourceCourse) throw new Error(`Missing source course for ${conceptId}`);

  const beforePayload = await (await get(`/courses/${courseId}`)).json();
  const beforeGroup = beforePayload.buildsOn.find(
    (group: { courseId: string }) => group.courseId === sourceCourse.id,
  );
  if (!beforeGroup) throw new Error(`Missing builds-on group for ${sourceCourse.id}`);

  await db.insert(lessonRuns).values({ userId, conceptId, status: 'completed' });

  const afterPayload = await (await get(`/courses/${courseId}`)).json();
  const afterGroup = afterPayload.buildsOn.find(
    (group: { courseId: string }) => group.courseId === sourceCourse.id,
  );
  expect(afterGroup.remaining).toBe(beforeGroup.remaining - 1);
});

test('a first-in-subject course with no foundations has no builds-on courses', async () => {
  const firstCourseIdsBySubject = new Set<string>();
  const courseId = orderCourseIdsBySubject(content).find((candidateId) => {
    const subjectId = subjectForCourse(content, candidateId).id;
    if (firstCourseIdsBySubject.has(subjectId)) return false;
    firstCourseIdsBySubject.add(subjectId);
    return courseFoundationIds(content, candidateId).size === 0;
  });
  if (!courseId) throw new Error('Missing a first-in-subject course without foundations');

  const payload = await (await get(`/courses/${courseId}`)).json();
  expect(payload.buildsOn).toEqual([]);
});

test('all-subject projection uses recent learn minutes from outside the focus', async () => {
  const mathsCourse = content.coursesById.get('maths-for-ml');
  const aiCourse = content.coursesById.get('ml-foundations');
  if (!mathsCourse || !aiCourse) throw new Error('Missing subject projection test courses');
  const mathsCourseConcepts = new Set(mathsCourse.units.flatMap((unit) => unit.concepts));
  const aiCourseConcepts = new Set(aiCourse.units.flatMap((unit) => unit.concepts));
  const mathsFoundations = courseFoundationIds(content, mathsCourse.id);
  const hasIndependentLesson = (conceptId: string) => {
    const concept = content.conceptsById.get(conceptId);
    return (
      concept?.status !== 'stub' &&
      concept?.prereqs.every((prerequisite) => prerequisite.strength !== 'hard') &&
      (content.lessonsByConcept.get(conceptId)?.knowledge_points?.length ?? 0) > 0
    );
  };
  const mathsConceptId = [...mathsCourseConcepts].find((conceptId) => {
    return hasIndependentLesson(conceptId);
  });
  const aiConceptId = [...aiCourseConcepts].find((conceptId) => {
    return (
      !mathsCourseConcepts.has(conceptId) &&
      !mathsFoundations.has(conceptId) &&
      hasIndependentLesson(conceptId)
    );
  });
  if (!mathsConceptId || !aiConceptId) {
    throw new Error('Missing independent Mathematics and AI lessons for subject balancing');
  }
  await db.insert(courseEnrollments).values(
    [mathsCourse.id, aiCourse.id].map((courseId) => ({
      userId,
      courseId,
      status: 'active' as const,
      startMethod: 'beginning' as const,
    })),
  );
  const [session] = await db
    .insert(studySessions)
    .values({
      userId,
      kind: 'weekday',
      plannedMinutes: 30,
      status: 'completed',
      startedAt: new Date('2026-01-07T09:30:00.000Z'),
      endedAt: new Date('2026-01-07T10:00:00.000Z'),
    })
    .returning();
  if (!session) throw new Error('Could not create recent learn session');
  await db.insert(sessionActivities).values([
    {
      sessionId: session.id,
      idx: 0,
      kind: 'learn',
      conceptId: mathsConceptId,
      plannedMinutes: 10,
      status: 'completed',
      completedAt: new Date('2026-01-07T10:00:00.000Z'),
    },
    {
      sessionId: session.id,
      idx: 1,
      kind: 'learn',
      conceptId: aiConceptId,
      plannedMinutes: 20,
      status: 'completed',
      completedAt: new Date('2026-01-07T10:00:00.000Z'),
    },
  ]);
  await db
    .update(users)
    .set({ prefs: { scheduleMinutes: 5 } })
    .where(eq(users.id, userId));

  const allSubjects = await (await get('/learn')).json();
  expect(allSubjects.focusSubjectId).toBeNull();
  expect(allSubjects.upNext.upcoming[0]?.courseId).toBe(mathsCourse.id);

  expect((await put('/focus', { subjectId: 'mathematics' })).status).toBe(200);
  const focused = await (await get('/learn')).json();
  expect(focused.upNext.allSubjects).not.toBeNull();
  expect(
    focused.upNext.allSubjects.map(
      ({
        conceptId,
        courseId,
        dayLabel,
      }: {
        conceptId: string;
        courseId: string;
        dayLabel: string;
      }) => ({
        conceptId,
        courseId,
        dayLabel,
      }),
    ),
  ).toEqual(
    allSubjects.upNext.upcoming.map(
      ({
        conceptId,
        courseId,
        dayLabel,
      }: {
        conceptId: string;
        courseId: string;
        dayLabel: string;
      }) => ({
        conceptId,
        courseId,
        dayLabel,
      }),
    ),
  );
});

test('focus persists and replans only planned activities', async () => {
  const mathsCourse = content.coursesById.get('maths-for-ml');
  const aiCourse = content.coursesById.get('ml-foundations');
  if (!mathsCourse || !aiCourse) throw new Error('Missing subject focus test courses');
  const aiFoundations = courseFoundationIds(content, aiCourse.id);
  const aiInProgressConceptId = aiCourse.units
    .flatMap((unit) => unit.concepts)
    .find((conceptId) => {
      const concept = content.conceptsById.get(conceptId);
      return (
        (content.lessonsByConcept.get(conceptId)?.knowledge_points?.length ?? 0) > 0 &&
        concept?.prereqs.every((prerequisite) => prerequisite.strength !== 'hard')
      );
    });
  if (!aiInProgressConceptId) throw new Error('Missing an available AI lesson for focus test');
  const mathsConcept = mathsCourse.units
    .flatMap((unit) => unit.concepts)
    .find((conceptId) => !aiFoundations.has(conceptId));
  if (!mathsConcept) throw new Error('Missing non-foundation Mathematics topic');
  await db.insert(courseEnrollments).values(
    [mathsCourse.id, aiCourse.id].map((courseId) => ({
      userId,
      courseId,
      status: 'active' as const,
      startMethod: 'beginning' as const,
    })),
  );
  const [session] = await db
    .insert(studySessions)
    .values({
      userId,
      kind: 'weekday',
      plannedMinutes: 60,
      status: 'active',
      startedAt: new Date('2026-01-07T11:00:00.000Z'),
    })
    .returning();
  if (!session) throw new Error('Could not create focus test session');
  const [completed, inProgress, planned, aiInProgress] = await db
    .insert(sessionActivities)
    .values([
      {
        sessionId: session.id,
        idx: 0,
        kind: 'learn',
        conceptId: mathsConcept,
        plannedMinutes: 5,
        status: 'completed',
      },
      {
        sessionId: session.id,
        idx: 1,
        kind: 'learn',
        conceptId: mathsConcept,
        plannedMinutes: 5,
        status: 'in_progress',
      },
      {
        sessionId: session.id,
        idx: 2,
        kind: 'learn',
        conceptId: mathsConcept,
        plannedMinutes: 5,
        status: 'planned',
      },
      {
        sessionId: session.id,
        idx: 3,
        kind: 'learn',
        conceptId: aiInProgressConceptId,
        plannedMinutes: 10,
        status: 'in_progress',
      },
    ])
    .returning();
  if (!completed || !inProgress || !planned || !aiInProgress) {
    throw new Error('Could not seed focus test activities');
  }
  await db.insert(lessonRuns).values({
    userId,
    conceptId: aiInProgressConceptId,
    status: 'in_progress',
  });

  expect((await put('/focus', { subjectId: 'history' })).status).toBe(400);
  const response = await put('/focus', { subjectId: 'ai' });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ focusSubjectId: 'ai' });
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  expect(user?.prefs).toMatchObject({ focusSubjectId: 'ai' });
  const activities = await db
    .select()
    .from(sessionActivities)
    .where(eq(sessionActivities.sessionId, session.id));
  expect(activities.find((activity) => activity.id === completed.id)?.status).toBe('completed');
  expect(activities.find((activity) => activity.id === inProgress.id)?.status).toBe('in_progress');
  const aiConceptActivities = activities.filter(
    (activity) =>
      activity.kind === 'learn' &&
      activity.conceptId === aiInProgressConceptId &&
      ['planned', 'in_progress'].includes(activity.status),
  );
  expect(aiConceptActivities.map((activity) => activity.status)).toEqual(['in_progress']);
  expect(activities.some((activity) => activity.id === planned.id)).toBe(false);
  const plannedAfterFocus = activities.filter(
    (activity) => activity.status === 'planned' && ['learn', 'review'].includes(activity.kind),
  );
  expect(plannedAfterFocus.length).toBeGreaterThan(0);
  expect(
    plannedAfterFocus.every((activity) => {
      const belongsToAi = aiCourse.units.some((unit) =>
        unit.concepts.includes(activity.conceptId ?? ''),
      );
      return belongsToAi || aiFoundations.has(activity.conceptId ?? '');
    }),
  ).toBe(true);

  const learn = await (await get('/learn')).json();
  expect(learn.focusSubjectId).toBe('ai');
  expect(learn.studyCourses.map((studyCourse: { id: string }) => studyCourse.id)).toEqual([
    mathsCourse.id,
    aiCourse.id,
  ]);
  expect(
    learn.upNext.upcoming
      .filter((topic: { dayLabel: string }) => topic.dayLabel !== 'Today')
      .some((topic: { courseId: string }) => topic.courseId === mathsCourse.id),
  ).toBe(false);
  expect(
    learn.upNext.upcoming.every(
      (topic: { courseId: string; dayLabel: string }) =>
        topic.dayLabel === 'Today' || topic.courseId === aiCourse.id,
    ),
  ).toBe(true);
  expect(learn.upNext.allSubjects).not.toBeNull();
  expect(
    learn.upNext.allSubjects.some(
      (topic: { courseId: string; dayLabel: string }) =>
        topic.courseId === mathsCourse.id && topic.dayLabel !== 'Today',
    ),
  ).toBe(true);
  const mathsStudyCourse = learn.studyCourses.find(
    (studyCourse: { id: string }) => studyCourse.id === mathsCourse.id,
  );
  expect(mathsStudyCourse?.estimatedFinish).toBeNull();
  expect(mathsStudyCourse?.estimatedFinishAtGoal).toBeNull();
  expect((await put('/focus', { subjectId: null })).status).toBe(200);
  const [resetUser] = await db.select().from(users).where(eq(users.id, userId));
  expect(resetUser?.prefs).not.toHaveProperty('focusSubjectId');
  await db
    .update(users)
    .set({ prefs: { scheduleMinutes: 60, focusSubjectId: 'history' } })
    .where(eq(users.id, userId));
  expect((await (await get('/learn')).json()).focusSubjectId).toBeNull();
});

test('outside-focus due review count ignores unknown concepts', async () => {
  const mathsCourse = content.coursesById.get('maths-for-ml');
  const aiCourse = content.coursesById.get('ml-foundations');
  if (!mathsCourse || !aiCourse) throw new Error('Missing subject focus test courses');
  await db.insert(courseEnrollments).values(
    [mathsCourse.id, aiCourse.id].map((courseId) => ({
      userId,
      courseId,
      status: 'active' as const,
      startMethod: 'beginning' as const,
    })),
  );
  await db
    .update(users)
    .set({
      activeCourseId: aiCourse.id,
      studySetInitializedAt: new Date('2026-01-01T00:00:00.000Z'),
      prefs: { scheduleMinutes: 60, focusSubjectId: 'ai' },
    })
    .where(eq(users.id, userId));
  const dueAt = new Date('2026-01-06T00:00:00.000Z');
  await db.insert(reviewCards).values({
    userId,
    conceptId: 'unknown-review-concept',
    dimension: 'math',
    fsrs: newReviewCard(dueAt),
    dueAt,
  });
  await db.insert(studySessions).values({
    userId,
    kind: 'weekday',
    plannedMinutes: 60,
    status: 'active',
    startedAt: new Date('2026-01-07T11:00:00.000Z'),
  });

  const learn = await (await get('/learn')).json();
  const reviews = await (await get('/reviews')).json();

  expect(learn.focusSubjectId).toBe('ai');
  expect(learn.dueReviewsOutsideFocus).toBe(0);
  expect(reviews.dueNow).toBe(0);
});

test('a stored focus is ignored when only one subject is active', async () => {
  const mathsCourse = content.coursesById.get('maths-for-ml');
  const aiCourse = content.coursesById.get('ml-foundations');
  if (!mathsCourse || !aiCourse) throw new Error('Missing single-subject focus test courses');
  const aiFoundations = courseFoundationIds(content, aiCourse.id);
  const reviewExercise = mathsCourse.units
    .flatMap((unit) => unit.concepts)
    .filter((conceptId) => !aiFoundations.has(conceptId))
    .flatMap((conceptId) =>
      (content.exercisesByConcept.get(conceptId) ?? []).map((exercise) => ({
        conceptId,
        exercise,
      })),
    )
    .find(({ exercise }) =>
      ['review', 'core', 'practice', 'transfer', 'basics'].includes(exercise.role),
    );
  if (!reviewExercise) throw new Error('Missing a Mathematics review exercise');
  await db.insert(courseEnrollments).values({
    userId,
    courseId: aiCourse.id,
    status: 'active',
    startMethod: 'beginning',
  });
  await db
    .update(users)
    .set({
      activeCourseId: aiCourse.id,
      studySetInitializedAt: new Date('2026-01-01T00:00:00.000Z'),
      prefs: { scheduleMinutes: 60, focusSubjectId: 'ai' },
    })
    .where(eq(users.id, userId));
  await db.insert(reviewCards).values({
    userId,
    conceptId: reviewExercise.conceptId,
    dimension: reviewExercise.exercise.dimension,
    fsrs: newReviewCard(new Date('2026-01-06T00:00:00.000Z')),
    dueAt: new Date('2026-01-06T00:00:00.000Z'),
  });

  const learn = await (await get('/learn')).json();

  expect(learn.activeSubjects.map((subject: { id: string }) => subject.id)).toEqual(['ai']);
  expect(learn.focusSubjectId).toBeNull();
  expect(learn.upNext.allSubjects).toBeNull();
  expect(
    learn.tasks.some(
      (task: { activityKind: string; conceptId?: string }) =>
        task.activityKind === 'review' && task.conceptId === reviewExercise.conceptId,
    ),
  ).toBe(true);

  const started = await post('/sessions', { budgetMinutes: 60 });
  expect(started.status).toBe(201);
  const session = await started.json();
  expect(
    session.activities.some(
      (activity: { kind: string; conceptId?: string }) =>
        activity.kind === 'review' && activity.conceptId === reviewExercise.conceptId,
    ),
  ).toBe(true);
});

test('lesson choices are empty while a session is active', async () => {
  const started = await app.request('/api/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Now': '2026-01-07T12:00:00.000Z' },
    body: JSON.stringify({ budgetMinutes: 60 }),
  });
  expect(started.status).toBe(201);
  const response = await get('/learn');
  expect((await response.json()).choices).toEqual([]);
});

test('a focused session replaces the default new lesson and rejects locked concepts', async () => {
  const courseId = content.curriculum?.default_course;
  if (!courseId) throw new Error('Expected a default course');
  await db.insert(courseEnrollments).values({
    userId,
    courseId,
    status: 'active',
    startMethod: 'beginning',
  });
  await db.update(users).set({ activeCourseId: courseId }).where(eq(users.id, userId));
  const learnResponse = await get('/learn');
  const learn = await learnResponse.json();
  const focusedChoice = learn.choices.find(
    (choice: { recommended: boolean }) => !choice.recommended,
  );
  if (!focusedChoice) throw new Error('Expected a non-recommended lesson choice');
  const response = await app.request('/api/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Now': '2026-01-07T12:00:00.000Z' },
    body: JSON.stringify({ budgetMinutes: 60, focusConceptId: focusedChoice.conceptId }),
  });
  expect(response.status).toBe(201);
  const session = await response.json();
  const learnActivities = session.activities.filter(
    (activity: { kind: string }) => activity.kind === 'learn',
  );
  expect(learnActivities.map((activity: { conceptId: string }) => activity.conceptId)).toEqual([
    focusedChoice.conceptId,
  ]);
  const recommendedConceptId = learn.tasks.find(
    (task: { activityKind: string; conceptId?: string }) => task.activityKind === 'learn',
  )?.conceptId;
  expect(
    learnActivities.map((activity: { conceptId: string }) => activity.conceptId),
  ).not.toContain(recommendedConceptId);

  const locked = await app.request('/api/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Now': '2026-01-07T12:00:00.000Z' },
    body: JSON.stringify({ focusConceptId: 'dot-product' }),
  });
  expect(locked.status).toBe(409);
  expect(await locked.json()).toEqual({ error: 'Finish Vectors and vector operations first' });
});

test('transitive hard ancestors lock descendant topics, choices, and focused starts', async () => {
  const targetConceptId = 'lora';
  const targetCourseId = 'transformers-llms';
  const ancestors = hardPrerequisiteAncestors(content, targetConceptId);
  expect(ancestors.has('eigen-svd')).toBe(true);
  expect(ancestors.has('orthogonality-projections')).toBe(true);
  await activateCourse(targetCourseId);
  await completeHardAncestors(targetConceptId, ['orthogonality-projections']);

  const mathsResponse = await get('/course?course=maths-for-ml');
  expect(mathsResponse.status).toBe(200);
  const maths = (await mathsResponse.json()) as {
    units: Array<{ topics: Array<{ conceptId: string; status: string }> }>;
  };
  expect(
    maths.units.flatMap((unit) => unit.topics).find((topic) => topic.conceptId === 'eigen-svd')
      ?.status,
  ).toBe('complete');

  const targetCourseResponse = await get(`/course?course=${targetCourseId}`);
  expect(targetCourseResponse.status).toBe(200);
  const targetCourse = (await targetCourseResponse.json()) as {
    units: Array<{
      topics: Array<{ conceptId: string; status: string; needs?: Array<{ id: string }> }>;
    }>;
  };
  const loraTopic = targetCourse.units
    .flatMap((unit) => unit.topics)
    .find((topic) => topic.conceptId === targetConceptId);
  expect(loraTopic?.status).toBe('locked');
  expect(loraTopic?.needs).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: 'orthogonality-projections' })]),
  );

  const learnResponse = await get('/learn');
  const learn = (await learnResponse.json()) as {
    choices: Array<{ conceptId: string }>;
  };
  expect(learn.choices.map((choice) => choice.conceptId)).not.toContain(targetConceptId);

  const focused = await app.request('/api/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Now': '2026-01-07T12:00:00.000Z' },
    body: JSON.stringify({ focusConceptId: targetConceptId }),
  });
  expect(focused.status).toBe(409);
  const missingPrerequisiteTitle = content.conceptsById.get('orthogonality-projections')?.title;
  expect(await focused.json()).toEqual({ error: `Finish ${missingPrerequisiteTitle} first` });
});

test('introduced eigen-svd mastery stays locked when an ancestor is not complete', async () => {
  await activateCourse('maths-for-ml');
  await completeHardAncestors('eigen-svd', ['orthogonality-projections']);
  const eigenSvd = content.conceptsById.get('eigen-svd');
  if (!eigenSvd) throw new Error('Expected eigen-svd in real content');
  await db.insert(mastery).values(
    eigenSvd.dimensions.map((dimension) => ({
      userId,
      conceptId: eigenSvd.id,
      dimension,
      state: 'introduced' as const,
    })),
  );

  const courseResponse = await get('/course?course=maths-for-ml');
  const course = (await courseResponse.json()) as {
    units: Array<{ topics: Array<{ conceptId: string; status: string }> }>;
  };
  expect(
    course.units.flatMap((unit) => unit.topics).find((topic) => topic.conceptId === 'eigen-svd')
      ?.status,
  ).toBe('locked');
});

test('a started descendant locks and its planned learn activity is skipped when its chain is reset', async () => {
  const targetConceptId = 'lora';
  await activateCourse('transformers-llms');
  await completeHardAncestors(targetConceptId);
  await db.insert(lessonRuns).values({
    userId,
    conceptId: targetConceptId,
    status: 'in_progress',
  });
  const [session] = await db
    .insert(studySessions)
    .values({ userId, plannedMinutes: 60, status: 'active' })
    .returning();
  if (!session) throw new Error('Could not create transitive prerequisite session');
  await db.insert(sessionActivities).values({
    sessionId: session.id,
    idx: 0,
    kind: 'learn',
    conceptId: targetConceptId,
    plannedMinutes: 20,
    status: 'planned',
  });

  const restart = await post('/concepts/orthogonality-projections/restart', {});
  expect(restart.status).toBe(200);
  const activities = await db
    .select()
    .from(sessionActivities)
    .where(eq(sessionActivities.sessionId, session.id));
  expect(activities[0]?.status).toBe('skipped');

  const courseResponse = await get('/course?course=transformers-llms');
  const course = (await courseResponse.json()) as {
    units: Array<{ topics: Array<{ conceptId: string; status: string }> }>;
  };
  expect(
    course.units.flatMap((unit) => unit.topics).find((topic) => topic.conceptId === targetConceptId)
      ?.status,
  ).toBe('locked');
});

test('Home hides an active PCA project until all hard prerequisite ancestors are complete', async () => {
  const directPrerequisites = ['vectors', 'dot-product', 'matrices', 'eigen-svd'];
  const hardAncestors = [
    'determinants',
    'inverses-linear-systems',
    'rank-span',
    'orthogonality-projections',
  ];
  const [session] = await db
    .insert(studySessions)
    .values({ userId, plannedMinutes: 60, status: 'active' })
    .returning();
  if (!session) throw new Error('Could not create active PCA project session');
  const [labActivity] = await db
    .insert(sessionActivities)
    .values({
      sessionId: session.id,
      idx: 0,
      kind: 'lab',
      projectId: 'pca-numpy',
      plannedMinutes: 60,
      status: 'planned',
    })
    .returning();
  if (!labActivity) throw new Error('Could not create active PCA lab activity');
  await db.insert(mastery).values(completedMasteryRows(directPrerequisites));

  const beforeAncestorsResponse = await get('/learn');
  expect(beforeAncestorsResponse.status).toBe(200);
  const beforeAncestors = (await beforeAncestorsResponse.json()) as {
    tasks: Array<{ title: string }>;
  };
  expect(beforeAncestors.tasks.some((task) => task.title === 'PCA from scratch')).toBe(false);

  await db.insert(mastery).values(completedMasteryRows(hardAncestors));
  const afterAncestorsResponse = await get('/learn');
  expect(afterAncestorsResponse.status).toBe(200);
  const afterAncestors = (await afterAncestorsResponse.json()) as {
    tasks: Array<{ title: string }>;
  };
  expect(afterAncestors.tasks.some((task) => task.title === 'PCA from scratch')).toBe(true);

  const beforeRestartSessionResponse = await get(`/sessions/${session.id}`);
  const beforeRestartSession = (await beforeRestartSessionResponse.json()) as {
    activities: Array<{ kind: string; projectId?: string }>;
  };
  expect(
    beforeRestartSession.activities.some(
      (activity) => activity.kind === 'lab' && activity.projectId === 'pca-numpy',
    ),
  ).toBe(true);

  const restart = await post('/concepts/orthogonality-projections/restart', {});
  expect(restart.status).toBe(200);

  const afterRestartHomeResponse = await get('/learn');
  const afterRestartHome = (await afterRestartHomeResponse.json()) as {
    tasks: Array<{ title: string }>;
  };
  expect(afterRestartHome.tasks.some((task) => task.title === 'PCA from scratch')).toBe(false);

  const afterRestartSessionResponse = await get(`/sessions/${session.id}`);
  const afterRestartSession = (await afterRestartSessionResponse.json()) as {
    activities: Array<{ id: string; kind: string; projectId?: string; status: string }>;
  };
  expect(
    afterRestartSession.activities.some(
      (activity) =>
        activity.id === labActivity.id &&
        activity.kind === 'lab' &&
        activity.projectId === 'pca-numpy' &&
        activity.status === 'skipped',
    ),
  ).toBe(true);

  await db
    .update(sessionActivities)
    .set({ status: 'planned' })
    .where(eq(sessionActivities.id, labActivity.id));
  const plannedSessionResponse = await get(`/sessions/${session.id}`);
  const plannedSession = (await plannedSessionResponse.json()) as {
    activities: Array<{ id: string }>;
  };
  expect(plannedSession.activities.some((activity) => activity.id === labActivity.id)).toBe(false);

  await db
    .update(sessionActivities)
    .set({ status: 'completed' })
    .where(eq(sessionActivities.id, labActivity.id));
  const completedSessionResponse = await get(`/sessions/${session.id}`);
  const completedSession = (await completedSessionResponse.json()) as {
    activities: Array<{ id: string }>;
  };
  expect(completedSession.activities.some((activity) => activity.id === labActivity.id)).toBe(true);
});

test('PCA course row stays unavailable until hard prerequisite ancestors are complete', async () => {
  const directPrerequisites = ['vectors', 'dot-product', 'matrices', 'eigen-svd'];
  const hardAncestors = [
    'determinants',
    'inverses-linear-systems',
    'rank-span',
    'orthogonality-projections',
  ];
  await db.insert(mastery).values(completedMasteryRows(directPrerequisites));

  const beforeAncestorsResponse = await get('/course?course=maths-for-ml');
  expect(beforeAncestorsResponse.status).toBe(200);
  const beforeAncestors = (await beforeAncestorsResponse.json()) as {
    units: Array<{ project: { id: string; available: boolean } | null }>;
  };
  const pcaBefore = beforeAncestors.units.find((unit) => unit.project?.id === 'pca-numpy')?.project;
  expect(pcaBefore?.available).toBe(false);

  await db.insert(mastery).values(completedMasteryRows(hardAncestors));
  const afterAncestorsResponse = await get('/course?course=maths-for-ml');
  expect(afterAncestorsResponse.status).toBe(200);
  const afterAncestors = (await afterAncestorsResponse.json()) as {
    units: Array<{ project: { id: string; available: boolean } | null }>;
  };
  const pcaAfter = afterAncestors.units.find((unit) => unit.project?.id === 'pca-numpy')?.project;
  expect(pcaAfter?.available).toBe(true);
});

test('Course project status reflects the learner project-progress row', async () => {
  await db.insert(projectProgress).values({
    userId,
    projectId: 'linreg-numpy',
    status: 'in_progress',
  });

  const response = await get('/course');
  expect(response.status).toBe(200);
  const course = await response.json();
  expect(course.currentUnit).toBe(1);
  expect(course.units[0].project).toMatchObject({
    id: 'linreg-numpy',
    available: false,
    status: 'in_progress',
  });
});

test('empty project evidence and out-of-range metrics cannot complete a project', async () => {
  const results = {
    project: 'linreg-numpy',
    version: 1,
    tests: [],
    metrics: { val_mse: 999, weight_error: 999 },
    generated_at: '2026-11-14T12:00:00.000Z',
  };
  const submissionResponse = await app.request('/api/projects/linreg-numpy/results', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Now': results.generated_at },
    body: JSON.stringify(results),
  });
  expect(submissionResponse.status).toBe(201);
  const submission = await submissionResponse.json();
  expect(submission.evidence).toContain('No verifier tests were reported');
  expect(submission.evidence).toContain('Validation MSE');
  expect(submission.evidence).toContain('Max |w - w_true|');

  const projectResponse = await get('/projects/linreg-numpy');
  expect(projectResponse.status).toBe(200);
  const project = await projectResponse.json();
  expect(project.status).toBe('in_progress');
  expect(project.latestSubmission.results).toMatchObject({
    tests: [],
    metrics: results.metrics,
  });

  const failingMetricResponse = await app.request('/api/projects/linreg-numpy/results', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Now': results.generated_at },
    body: JSON.stringify({
      ...results,
      tests: [{ id: 'test_predict_shape_and_values', passed: true, message: 'passed' }],
    }),
  });
  expect(failingMetricResponse.status).toBe(201);
  expect((await failingMetricResponse.json()).evidence).toContain('Validation MSE');
  const failedMetricProject = await (await get('/projects/linreg-numpy')).json();
  expect(failedMetricProject.status).toBe('in_progress');
});

test('project evidence requires every declared verifier test', async () => {
  const results = nnFromScratchResults([
    {
      id: nnFromScratchTestIds[0] ?? '',
      passed: true,
      message: 'passed',
    },
  ]);
  const response = await app.request('/api/projects/nn-from-scratch/results', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Now': results.generated_at },
    body: JSON.stringify(results),
  });

  expect(response.status).toBe(201);
  const submission = await response.json();
  expect(submission.evidence).toContain('1/8 checks passed');
  expect(submission.evidence).toContain('Missing:');
  for (const missingTestId of nnFromScratchTestIds.slice(1)) {
    expect(submission.evidence).toContain(missingTestId);
  }

  const project = await (await get('/projects/nn-from-scratch')).json();
  expect(project.status).toBe('in_progress');
});

test('all verifier tests still require every project metric to pass', async () => {
  const results = nnFromScratchResults(undefined, {
    ...nnFromScratchPassingMetrics,
    validation_accuracy: 0.89,
  });
  const response = await app.request('/api/projects/nn-from-scratch/results', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Now': results.generated_at },
    body: JSON.stringify(results),
  });

  expect(response.status).toBe(201);
  expect((await response.json()).evidence).toContain('8/8 checks passed');
  const project = await (await get('/projects/nn-from-scratch')).json();
  expect(project.status).toBe('in_progress');
});

test.each([
  ['validation_accuracy', 0.9, 'completed'],
  ['final_train_loss', 0.1, 'in_progress'],
  ['max_gradient_check_relative_error', 0.00001, 'in_progress'],
])(
  'project metric %s honors its inclusive or strict threshold',
  async (metricId, value, status) => {
    const results = nnFromScratchResults(undefined, {
      ...nnFromScratchPassingMetrics,
      [metricId]: value,
    });
    const response = await app.request('/api/projects/nn-from-scratch/results', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(results),
    });
    expect(response.status).toBe(201);
    expect((await response.json()).status).toBe(status);
  },
);

test('all verifier tests and metrics complete the project', async () => {
  const results = nnFromScratchResults();
  const response = await app.request('/api/projects/nn-from-scratch/results', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Now': results.generated_at },
    body: JSON.stringify(results),
  });

  expect(response.status).toBe(201);
  expect((await response.json()).evidence).toContain('8/8 checks passed');
  const project = await (await get('/projects/nn-from-scratch')).json();
  expect(project.status).toBe('completed');
});

test('unknown project verifier test IDs are rejected with 422', async () => {
  const results = nnFromScratchResults([{ id: 'test_unknown', passed: true, message: 'passed' }]);
  const response = await app.request('/api/projects/nn-from-scratch/results', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Now': results.generated_at },
    body: JSON.stringify(results),
  });

  expect(response.status).toBe(422);
});

test('active-session tasks, done-today activity, and local-date KP XP are returned read-only', async () => {
  const [session] = await db
    .insert(studySessions)
    .values({
      userId,
      kind: 'weekday',
      plannedMinutes: 30,
      status: 'active',
      startedAt: new Date('2026-01-07T11:00:00.000Z'),
    })
    .returning();
  if (!session) throw new Error('Could not create Learn fixture session');
  const [completed, remaining] = await db
    .insert(sessionActivities)
    .values([
      {
        sessionId: session.id,
        idx: 0,
        kind: 'practice',
        conceptId: 'vectors',
        exerciseIds: ['vec-points-moves-basics'],
        plannedMinutes: 12,
        status: 'completed',
        completedAt: new Date('2026-01-07T11:30:00.000Z'),
      },
      {
        sessionId: session.id,
        idx: 1,
        kind: 'learn',
        conceptId: 'supervised-learning',
        plannedMinutes: 18,
        status: 'in_progress',
      },
    ])
    .returning();
  if (!completed || !remaining) throw new Error('Could not create Learn fixture activities');
  const [run] = await db
    .insert(lessonRuns)
    .values({
      userId,
      conceptId: 'supervised-learning',
      status: 'in_progress',
      startedAt: new Date('2026-01-07T11:00:00.000Z'),
    })
    .returning();
  if (!run) throw new Error('Could not create active lesson run');
  await db.insert(xpEvents).values([
    {
      userId,
      kind: 'knowledge_point',
      sourceKey: `kp:${run.id}:point`,
      conceptId: 'supervised-learning',
      amount: 10,
      earnedAt: new Date('2026-01-07T11:15:00.000Z'),
      localDate: '2026-01-07',
    },
    {
      userId,
      kind: 'activity',
      sourceKey: `activity:${completed.id}`,
      conceptId: 'vectors',
      amount: 12,
      earnedAt: new Date('2026-01-05T12:00:00.000Z'),
      localDate: '2026-01-05',
    },
  ]);
  const before = await rowCounts();

  const response = await get('/learn');
  expect(response.status).toBe(200);
  const learn = await response.json();
  expect(learn).toMatchObject({
    activeSessionId: session.id,
    xp: {
      total: 22,
      today: 10,
      goal: 60,
      week: expect.arrayContaining([
        { date: '2026-01-05', xp: 12, goal: 60 },
        { date: '2026-01-07', xp: 10, goal: 60 },
      ]),
    },
  });
  expect(learn.tasks).toHaveLength(1);
  expect(learn.tasks[0]).toMatchObject({
    id: remaining.id,
    activityKind: 'learn',
    label: 'Lesson',
    conceptId: 'supervised-learning',
    title: 'Supervised learning setup',
    xp: expect.any(Number),
  });
  expect(learn.doneToday).toEqual([
    {
      activityId: expect.any(String),
      label: 'Practice',
      title: 'Vectors and vector operations',
      xp: 0,
      completedAt: '2026-01-07T11:30:00.000Z',
    },
  ]);
  expect(await rowCounts()).toEqual(before);
});

test('done-today XP rows include lesson quiz XP and sum to the earned total', async () => {
  const [session] = await db
    .insert(studySessions)
    .values({
      userId,
      kind: 'weekday',
      plannedMinutes: 60,
      status: 'completed',
      startedAt: new Date('2026-01-07T10:00:00.000Z'),
      endedAt: new Date('2026-01-07T11:00:00.000Z'),
    })
    .returning();
  if (!session) throw new Error('Could not create passed-quiz session');
  const [lessonActivity, reviewActivity] = await db
    .insert(sessionActivities)
    .values([
      {
        sessionId: session.id,
        idx: 0,
        kind: 'learn',
        conceptId: 'supervised-learning',
        exerciseIds: [],
        plannedMinutes: 40,
        status: 'completed',
        completedAt: new Date('2026-01-07T10:50:00.000Z'),
      },
      {
        sessionId: session.id,
        idx: 1,
        kind: 'review',
        conceptId: 'vectors',
        exerciseIds: [],
        plannedMinutes: 4,
        status: 'completed',
        completedAt: new Date('2026-01-07T11:00:00.000Z'),
      },
    ])
    .returning();
  if (!lessonActivity || !reviewActivity) {
    throw new Error('Could not create passed-quiz activities');
  }
  const [run] = await db
    .insert(lessonRuns)
    .values({
      userId,
      conceptId: 'supervised-learning',
      status: 'completed',
      startedAt: new Date('2026-01-07T10:00:00.000Z'),
      completedAt: new Date('2026-01-07T10:50:00.000Z'),
      quizPassedAt: new Date('2026-01-07T10:50:00.000Z'),
    })
    .returning();
  if (!run) throw new Error('Could not create passed lesson run');
  await db.insert(xpEvents).values([
    {
      userId,
      kind: 'knowledge_point',
      sourceKey: `kp:${run.id}:sl-inputs-targets`,
      conceptId: 'supervised-learning',
      amount: 40,
      earnedAt: new Date('2026-01-07T10:40:00.000Z'),
      localDate: '2026-01-07',
    },
    {
      userId,
      kind: 'quiz',
      sourceKey: `quiz:${run.id}`,
      conceptId: 'supervised-learning',
      amount: 8,
      earnedAt: new Date('2026-01-07T10:50:00.000Z'),
      localDate: '2026-01-07',
    },
    {
      userId,
      kind: 'activity',
      sourceKey: `activity:${reviewActivity.id}`,
      conceptId: 'vectors',
      amount: 4,
      earnedAt: new Date('2026-01-07T11:00:00.000Z'),
      localDate: '2026-01-07',
    },
  ]);

  const response = await get('/learn');
  expect(response.status).toBe(200);
  const learn = await response.json();
  expect(learn.xp.today).toBe(52);
  expect(learn.doneToday).toMatchObject([
    { activityId: lessonActivity.id, xp: 48 },
    { activityId: reviewActivity.id, xp: 4 },
  ]);
  expect(learn.doneToday.reduce((total: number, item: { xp: number }) => total + item.xp, 0)).toBe(
    learn.xp.today,
  );
});

test('done-today XP rows include XP from a finalized timed quiz', async () => {
  const quizContent = await loadContent('content');
  const quizApp = createApp({ db, content: quizContent, tutorProvider: null });
  const now = '2026-01-14T12:00:00.000Z';
  await db
    .update(users)
    .set({ activeCourseId: 'ml-foundations', prefs: { scheduleMinutes: 60 } })
    .where(eq(users.id, userId));
  await db.insert(lessonRuns).values(
    quizContent.lessons.map(({ concept }) => ({
      userId,
      conceptId: concept,
      status: 'completed' as const,
      completedAt: new Date(now),
    })),
  );
  await repositoryFor().completeCourses(
    quizContent.courses.map(({ id }) => id),
    new Date(now),
  );
  await db.insert(xpEvents).values({
    userId,
    amount: 150,
    kind: 'knowledge_point',
    sourceKey: 'test:home-timed-quiz',
    earnedAt: new Date(now),
    localDate: '2026-01-14',
  });
  const headers = { 'X-Now': now, 'X-Time-Zone': 'UTC', 'Content-Type': 'application/json' };
  const sessionResponse = await quizApp.request('/api/sessions', {
    method: 'POST',
    headers,
    body: JSON.stringify({ budgetMinutes: 120 }),
  });
  expect(sessionResponse.status).toBe(201);
  const session = (await sessionResponse.json()) as {
    id: string;
    activities: Array<{ id: string; kind: string }>;
  };
  const quizActivity = session.activities.find((activity) => activity.kind === 'mixed_quiz');
  if (!quizActivity) throw new Error('Could not create timed quiz activity');

  const startResponse = await quizApp.request('/api/quizzes/start', {
    method: 'POST',
    headers,
    body: JSON.stringify({ sessionId: session.id, activityId: quizActivity.id }),
  });
  expect(startResponse.status).toBe(201);
  const quiz = (await startResponse.json()) as { id: string };
  const items = await db
    .select()
    .from(quizItems)
    .where(eq(quizItems.runId, quiz.id))
    .orderBy(asc(quizItems.position));
  for (const item of items) {
    const answerResponse = await quizApp.request(`/api/quizzes/${quiz.id}/answer`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        position: item.position,
        questionId: item.question.exercise.id,
        answer: answerFor(quizContent, item.question.exercise.id, item.question.seed),
      }),
    });
    expect(answerResponse.status).toBe(200);
  }

  const finalizeResponse = await quizApp.request(`/api/quizzes/${quiz.id}/finalize`, {
    method: 'POST',
    headers,
  });
  expect(finalizeResponse.status).toBe(200);
  const finalized = (await finalizeResponse.json()) as { result: { xpAwarded: number } };
  expect(finalized.result.xpAwarded).toBeGreaterThan(0);

  const homeResponse = await quizApp.request('/api/learn', { headers });
  expect(homeResponse.status).toBe(200);
  const home = await homeResponse.json();
  expect(home.doneToday).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ activityId: quizActivity.id, xp: finalized.result.xpAwarded }),
    ]),
  );
});

test('learn XP goal follows the learner daily study time', async () => {
  await db
    .update(users)
    .set({ prefs: { scheduleMinutes: 30, saturdayMinutes: 45, sundayMinutes: 75 } })
    .where(eq(users.id, userId));
  const response = await get('/learn');
  expect(response.status).toBe(200);
  const learn = await response.json();
  expect(learn.xp.goal).toBe(30);
  expect(learn.xp.week.map((day: { goal: number }) => day.goal)).toEqual([
    30, 30, 30, 30, 30, 45, 75,
  ]);
});

test('session XP counts events during the session and all events from the local day', async () => {
  const [session] = await db
    .insert(studySessions)
    .values({
      userId,
      kind: 'weekday',
      plannedMinutes: 60,
      status: 'completed',
      startedAt: new Date('2026-01-07T10:00:00.000Z'),
      endedAt: new Date('2026-01-07T11:00:00.000Z'),
    })
    .returning();
  if (!session) throw new Error('Could not create XP session');
  await db.insert(xpEvents).values([
    {
      userId,
      kind: 'activity',
      sourceKey: 'xp-session-before',
      amount: 20,
      earnedAt: new Date('2026-01-07T09:59:00.000Z'),
      localDate: '2026-01-07',
    },
    {
      userId,
      kind: 'activity',
      sourceKey: 'xp-session-inside',
      amount: 15,
      earnedAt: new Date('2026-01-07T10:30:00.000Z'),
      localDate: '2026-01-07',
    },
    {
      userId,
      kind: 'activity',
      sourceKey: 'xp-session-after',
      amount: 50,
      earnedAt: new Date('2026-01-07T11:01:00.000Z'),
      localDate: '2026-01-07',
    },
    {
      userId,
      kind: 'activity',
      sourceKey: 'xp-today-only',
      amount: 10,
      earnedAt: new Date('2026-01-07T12:00:00.000Z'),
      localDate: '2026-01-07',
    },
  ]);
  const response = await get(`/sessions/${session.id}`);
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.xp).toEqual({ session: 15, today: 95, goal: 60 });
});

test('request timezone updates the learner, rebuckets XP, and drives the local week', async () => {
  const earnedAt = new Date('2026-11-09T00:17:00.000Z');
  await db.insert(xpEvents).values({
    userId,
    kind: 'activity',
    sourceKey: 'timezone-rebucket',
    conceptId: 'vectors',
    amount: 10,
    earnedAt,
    localDate: '2026-11-09',
  });
  const headers = {
    'X-Now': earnedAt.toISOString(),
    'X-Time-Zone': 'America/Los_Angeles',
  };

  const learnResponse = await app.request('/api/learn', { headers });
  expect(learnResponse.status).toBe(200);
  const learn = await learnResponse.json();
  expect(learn.xp.today).toBe(10);
  expect(learn.xp.week).toContainEqual({ date: '2026-11-08', xp: 10, goal: 60 });

  const [user] = await db.select().from(users).where(eq(users.id, userId));
  const [event] = await db.select().from(xpEvents).where(eq(xpEvents.userId, userId));
  expect(user?.timezone).toBe('America/Los_Angeles');
  expect(event?.localDate).toBe('2026-11-08');
  const todayResponse = await app.request('/api/today', { headers });
  expect((await todayResponse.json()).sessionKind).toBe('sunday');
});

test('invalid timezone is ignored and a missing header uses the stored timezone', async () => {
  const invalid = await app.request('/api/learn', {
    headers: { 'X-Now': '2026-11-09T00:17:00.000Z', 'X-Time-Zone': 'Not/AZone' },
  });
  expect(invalid.status).toBe(200);
  expect((await db.select().from(users).where(eq(users.id, userId)))[0]?.timezone).toBe('UTC');

  await db.update(users).set({ timezone: 'America/Los_Angeles' }).where(eq(users.id, userId));
  const missing = await app.request('/api/today', {
    headers: { 'X-Now': '2026-11-09T00:17:00.000Z' },
  });
  expect((await missing.json()).sessionKind).toBe('sunday');
});

async function seedStaleEmbeddingsSession() {
  const now = new Date('2026-01-07T10:00:00.000Z');
  await db
    .update(users)
    .set({ activeCourseId: 'ml-foundations', studySetInitializedAt: now })
    .where(eq(users.id, userId));
  await db.insert(courseEnrollments).values(
    ['ml-foundations', 'transformers-llms'].map((courseId) => ({
      userId,
      courseId,
      startMethod: 'beginning' as const,
    })),
  );
  const [session] = await db
    .insert(studySessions)
    .values({
      userId,
      kind: 'weekday',
      plannedMinutes: 60,
      status: 'active',
      startedAt: now,
    })
    .returning();
  if (!session) throw new Error('Could not create stale-activity session');
  const [activity] = await db
    .insert(sessionActivities)
    .values({
      sessionId: session.id,
      idx: 0,
      kind: 'learn',
      conceptId: 'embeddings',
      plannedMinutes: 20,
      status: 'planned',
    })
    .returning();
  if (!activity) throw new Error('Could not create stale Embeddings activity');
  return { session, activity };
}

async function seedInProgressStaleEmbeddingsSession() {
  const seeded = await seedStaleEmbeddingsSession();
  const progress = { lessonViewed: true, savedAnswer: 'keep-embeddings-progress' };
  const startedAt = new Date('2026-01-07T11:00:00.000Z');
  const [run] = await db
    .insert(lessonRuns)
    .values({ userId, conceptId: 'embeddings', status: 'in_progress' })
    .returning();
  if (!run) throw new Error('Could not create in-progress Embeddings run');
  const [problem] = await db
    .insert(lessonProblems)
    .values({
      runId: run.id,
      knowledgePointId: 'embeddings-preserved',
      round: 0,
      position: 0,
      exerciseId: 'embeddings-preserved-answer',
      answeredAt: startedAt,
      correct: 1,
    })
    .returning();
  if (!problem) throw new Error('Could not create Embeddings lesson progress');
  await db
    .update(sessionActivities)
    .set({ status: 'in_progress', startedAt, progress })
    .where(eq(sessionActivities.id, seeded.activity.id));
  return { ...seeded, run, problem, progress, startedAt };
}

test('Home skips a planned lesson with an unmet prerequisite and replans the front AI course', async () => {
  const { session, activity } = await seedStaleEmbeddingsSession();

  const response = await get('/learn');
  expect(response.status).toBe(200);

  const sessionRows = await db
    .select()
    .from(sessionActivities)
    .where(eq(sessionActivities.sessionId, session.id));
  expect(sessionRows.find((row) => row.id === activity.id)?.status).toBe('skipped');
  const frontCourse = content.coursesById.get('ml-foundations');
  if (!frontCourse) throw new Error('Expected the ML Foundations course');
  const frontConceptIds = new Set(frontCourse.units.flatMap((unit) => unit.concepts));
  expect(
    sessionRows.some(
      (row) =>
        row.kind === 'learn' &&
        row.status === 'planned' &&
        row.conceptId !== 'embeddings' &&
        frontConceptIds.has(row.conceptId ?? ''),
    ),
  ).toBe(true);
});

test('Home skips a stale in-progress lesson without changing its run or progress', async () => {
  const { session, activity, run, problem, progress, startedAt } =
    await seedInProgressStaleEmbeddingsSession();

  const response = await get('/learn');
  expect(response.status).toBe(200);

  const sessionRows = await db
    .select()
    .from(sessionActivities)
    .where(eq(sessionActivities.sessionId, session.id));
  expect(sessionRows.find((row) => row.id === activity.id)).toMatchObject({
    status: 'skipped',
    startedAt,
    progress,
  });
  expect(await db.select().from(lessonRuns).where(eq(lessonRuns.id, run.id))).toMatchObject([
    { id: run.id, status: 'in_progress' },
  ]);
  expect(
    await db.select().from(lessonProblems).where(eq(lessonProblems.runId, run.id)),
  ).toMatchObject([problem]);
  const frontCourse = content.coursesById.get('ml-foundations');
  if (!frontCourse) throw new Error('Expected the ML Foundations course');
  const frontConceptIds = new Set(frontCourse.units.flatMap((unit) => unit.concepts));
  expect(
    sessionRows.some(
      (row) =>
        row.kind === 'learn' &&
        row.status === 'planned' &&
        row.conceptId !== 'embeddings' &&
        frontConceptIds.has(row.conceptId ?? ''),
    ),
  ).toBe(true);
});

test('starting a planned lesson with an unmet prerequisite skips it instead of opening it', async () => {
  const { session, activity } = await seedStaleEmbeddingsSession();
  const response = await app.request(
    `/api/sessions/${session.id}/activities/${activity.id}/progress`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Now': '2026-01-07T12:00:00.000Z',
      },
      body: JSON.stringify({ lessonViewed: true }),
    },
  );

  expect(response.status).toBe(409);
  const [row] = await db
    .select()
    .from(sessionActivities)
    .where(eq(sessionActivities.id, activity.id));
  expect(row?.status).toBe('skipped');
  expect(row?.startedAt).toBeNull();
});

test('starting a stale in-progress lesson skips it without changing its run or progress', async () => {
  const { session, activity, run, progress } = await seedInProgressStaleEmbeddingsSession();
  const response = await app.request(
    `/api/sessions/${session.id}/activities/${activity.id}/progress`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Now': '2026-01-07T12:00:00.000Z',
      },
      body: JSON.stringify({ lessonViewed: true }),
    },
  );

  expect(response.status).toBe(409);
  expect(
    await db.select().from(sessionActivities).where(eq(sessionActivities.id, activity.id)),
  ).toMatchObject([{ status: 'skipped', progress }]);
  expect(await db.select().from(lessonRuns).where(eq(lessonRuns.id, run.id))).toMatchObject([
    { id: run.id, status: 'in_progress' },
  ]);
  expect(
    await db.select().from(lessonProblems).where(eq(lessonProblems.runId, run.id)),
  ).toMatchObject([
    { knowledgePointId: 'embeddings-preserved', exerciseId: 'embeddings-preserved-answer' },
  ]);
});

test('Up next does not forecast lessons Today when no learn tasks are planned', async () => {
  const courseId = content.curriculum?.default_course ?? content.courses[0]?.id;
  if (!courseId) throw new Error('Missing default course');
  await db
    .update(users)
    .set({ activeCourseId: courseId, prefs: { scheduleMinutes: 5 } })
    .where(eq(users.id, userId));
  await db.insert(courseEnrollments).values({
    userId,
    courseId,
    startMethod: 'beginning',
  });

  const learn = await (await get('/learn')).json();
  const learnTaskConceptIds = learn.tasks
    .filter((task: { activityKind: string }) => task.activityKind === 'learn')
    .map((task: { conceptId: string }) => task.conceptId);
  const todayConceptIds = learn.upNext.upcoming
    .filter((topic: { dayLabel: string }) => topic.dayLabel === 'Today')
    .map((topic: { conceptId: string }) => topic.conceptId);

  expect(learn.activeSessionId).toBeNull();
  expect(learnTaskConceptIds).toEqual([]);
  expect(learn.upNext.upcoming.length).toBeGreaterThan(0);
  expect(learn.upNext.upcoming[0]?.dayLabel).not.toBe('Today');
  expect(todayConceptIds).toEqual(learnTaskConceptIds);
});

test('Up next starts with active-session lessons in order and projects future topics from tomorrow', async () => {
  const now = new Date('2026-01-07T10:00:00.000Z');
  await db
    .update(users)
    .set({ activeCourseId: 'ml-foundations', studySetInitializedAt: now })
    .where(eq(users.id, userId));
  await db.insert(courseEnrollments).values({
    userId,
    courseId: 'ml-foundations',
    startMethod: 'beginning',
  });
  const [session] = await db
    .insert(studySessions)
    .values({
      userId,
      kind: 'weekday',
      plannedMinutes: 60,
      status: 'active',
      startedAt: now,
    })
    .returning();
  if (!session) throw new Error('Could not create Up next session');
  await db.insert(sessionActivities).values([
    {
      sessionId: session.id,
      idx: 0,
      kind: 'learn',
      conceptId: 'supervised-learning',
      plannedMinutes: 20,
      status: 'in_progress',
    },
    {
      sessionId: session.id,
      idx: 1,
      kind: 'learn',
      conceptId: 'what-is-ml',
      plannedMinutes: 20,
      status: 'planned',
    },
  ]);

  const learn = await (await get('/learn')).json();
  expect(
    learn.upNext.upcoming.slice(0, 2).map((topic: { conceptId: string }) => topic.conceptId),
  ).toEqual(['supervised-learning', 'what-is-ml']);
  expect(
    learn.upNext.upcoming
      .slice(0, 2)
      .every((topic: { dayLabel: string }) => topic.dayLabel === 'Today'),
  ).toBe(true);
  expect(
    learn.upNext.upcoming.slice(2).every((topic: { date: string }) => topic.date >= '2026-01-08'),
  ).toBe(true);
});

test('Finished topics use lesson completion dates or the earliest mastery transition', async () => {
  const studySetInitializedAt = new Date('2026-01-01T00:00:00.000Z');
  await db
    .update(users)
    .set({ activeCourseId: 'ml-foundations', studySetInitializedAt })
    .where(eq(users.id, userId));
  await db.insert(courseEnrollments).values({
    userId,
    courseId: 'ml-foundations',
    startMethod: 'beginning',
  });
  await db.insert(lessonRuns).values([
    {
      userId,
      conceptId: 'supervised-learning',
      status: 'completed',
      completedAt: new Date('2026-01-06T18:00:00.000Z'),
    },
    { userId, conceptId: 'probability-basics', status: 'completed' },
  ]);
  const statistics = content.conceptsById.get('descriptive-statistics');
  if (!statistics) throw new Error('Expected descriptive statistics in authored content');
  await db.insert(mastery).values(
    statistics.dimensions.map((dimension) => ({
      userId,
      conceptId: statistics.id,
      dimension,
      state: 'assisted' as const,
    })),
  );
  await db.insert(masteryEvents).values([
    {
      userId,
      conceptId: 'supervised-learning',
      dimension: 'conceptual',
      fromState: 'not_assessed',
      toState: 'assisted',
      rule: 'test',
      createdAt: new Date('2026-01-03T08:00:00.000Z'),
    },
    {
      userId,
      conceptId: statistics.id,
      dimension: statistics.dimensions[0] ?? 'conceptual',
      fromState: 'not_assessed',
      toState: 'assisted',
      rule: 'test',
      createdAt: new Date('2026-01-05T08:00:00.000Z'),
    },
  ]);

  const response = await get('/learn');
  expect(response.status).toBe(200);
  const learn = await response.json();
  expect(
    learn.upNext.finished
      .filter((topic: { conceptId: string }) =>
        ['supervised-learning', 'descriptive-statistics', 'probability-basics'].includes(
          topic.conceptId,
        ),
      )
      .map((topic: { conceptId: string; date?: string }) => [topic.conceptId, topic.date]),
  ).toEqual([
    ['supervised-learning', '2026-01-06'],
    ['descriptive-statistics', '2026-01-05'],
    ['probability-basics', undefined],
  ]);
});
