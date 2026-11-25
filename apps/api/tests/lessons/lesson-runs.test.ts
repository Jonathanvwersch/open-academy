import { instantiateExercise, isTemplate } from '@academy/aesop/course/templates';
import type { ContentIndex } from '@academy/aesop/course/types';
import { scoreLessonQuiz } from '@academy/aesop/lessons/lesson-quiz';
import { newReviewCard, scheduleReview } from '@academy/aesop/memory/fsrs';
import { and, eq, inArray } from 'drizzle-orm';
import { Rating, State } from 'ts-fsrs';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { createApp } from '../../src/app.js';
import { env } from '../../src/config.js';
import { loadContent } from '../../src/content/load.js';
import { createDb } from '../../src/db/client.js';
import {
  attempts,
  courseEnrollments,
  lessonProblems,
  lessonQuizAttempts,
  lessonQuizItems,
  lessonRuns,
  mastery,
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

const db = createDb(env.TEST_DATABASE_URL);
const userId = '00000000-0000-4000-8000-000000000087';
const conceptId = 'supervised-learning';
const headers = { 'content-type': 'application/json', 'X-Now': '2026-01-01T12:00:00.000Z' };
let app: ReturnType<typeof createApp>;
let content: ContentIndex;

beforeAll(async () => {
  content = await loadContent('content');
  app = createApp({ db, content, tutorProvider: new FakeProvider() });
});

beforeEach(async () => {
  app = createApp({ db, content, tutorProvider: new FakeProvider() });
  await db.delete(users);
  await db.insert(users).values({
    id: userId,
    displayName: 'Lesson runner test learner',
    timezone: 'Europe/London',
    startDate: '2026-01-01',
  });
});

afterAll(async () => {
  await db.delete(users).where(eq(users.id, userId));
  await db.$client.end();
});

async function startRun(activityId?: string, runConceptId = conceptId, requestHeaders = headers) {
  return app.request(`/api/lessons/${runConceptId}/run`, {
    method: 'POST',
    headers: requestHeaders,
    body: JSON.stringify(activityId ? { activityId } : {}),
  });
}

async function getRun(runConceptId = conceptId) {
  return app.request(`/api/lessons/${runConceptId}/run`, { headers });
}

function removeExercises(ids: string[]) {
  const removed = new Set(ids);
  const revised = {
    ...content,
    exercisesById: new Map([...content.exercisesById].filter(([id]) => !removed.has(id))),
    exercisesByConcept: new Map(
      [...content.exercisesByConcept].map(([id, exercises]) => [
        id,
        exercises.filter((exercise) => !removed.has(exercise.id)),
      ]),
    ),
    exercisesByRole: new Map(
      [...content.exercisesByRole].map(([role, exercises]) => [
        role,
        exercises.filter((exercise) => !removed.has(exercise.id)),
      ]),
    ),
  };
  app = createApp({ db, content: revised, tutorProvider: new FakeProvider() });
}

test('loading a run replaces a deleted pending question without credit', async () => {
  const { run } = await (await startRun()).json();
  const stale = run.pendingProblem;
  removeExercises([stale.exerciseId]);

  const recovered = (await (await getRun()).json()).run;
  expect(recovered.pendingProblem).toMatchObject({ knowledgePointId: stale.knowledgePointId });
  expect(recovered.pendingProblem.exerciseId).not.toBe(stale.exerciseId);
  expect((await (await getRun()).json()).run.pendingProblem.id).toBe(recovered.pendingProblem.id);
  expect(await db.select().from(lessonProblems).where(eq(lessonProblems.runId, run.id))).toEqual([
    expect.objectContaining({ id: recovered.pendingProblem.id, answeredAt: null, attemptId: null }),
  ]);
  expect(await db.select().from(attempts).where(eq(attempts.userId, userId))).toHaveLength(0);
  expect(await db.select().from(xpEvents).where(eq(xpEvents.userId, userId))).toHaveLength(0);
  expect(await db.select().from(mastery).where(eq(mastery.userId, userId))).toHaveLength(0);
});

test('a deleted last answer keeps step progress and opens the next question', async () => {
  const { run } = await (await startRun()).json();
  const pending = run.pendingProblem;
  const answered = await answerProblem(pending.id, correctAnswer(pending.exerciseId, pending.seed));
  expect(answered.status).toBe(200);
  const before = (await answered.json()).state;
  removeExercises([pending.exerciseId]);

  const { run: recovered } = await (await getRun()).json();
  expect(recovered.points).toEqual(before.points);
  expect(recovered).not.toHaveProperty('lastAnsweredProblem');
  expect(recovered.pendingProblem.exerciseId).not.toBe(pending.exerciseId);
  expect(await db.select().from(attempts).where(eq(attempts.userId, userId))).toEqual([
    expect.objectContaining({ exerciseId: pending.exerciseId, correct: 1 }),
  ]);
});

test('an open quiz keeps deleted answered items and replaces or drops deleted unanswered items', async () => {
  const run = await finishLessonSteps();
  const point = content.lessonsByConcept.get(conceptId)?.knowledge_points?.[0];
  if (!point) throw new Error('Expected an authored knowledge point');
  const eligible = point.problems.filter((id) => {
    const exercise = content.exercisesById.get(id);
    return (
      exercise && !exercise.lesson_only && exercise.role !== 'recall' && exercise.type === 'mc'
    );
  });
  const [answered, stale, extra, replacement] = eligible;
  if (!answered || !stale || !extra || !replacement) throw new Error('Expected four quiz choices');
  const [quiz] = await db
    .insert(lessonQuizAttempts)
    .values({ runId: run.id, attemptNo: 1 })
    .returning();
  const [saved, old, dropped] = await db
    .insert(lessonQuizItems)
    .values(
      [answered, stale, extra].map((exerciseId, index) => ({
        quizAttemptId: quiz.id,
        position: index + 1,
        knowledgePointId: point.id,
        exerciseId,
        ...(index === 0
          ? {
              answeredAt: new Date(headers['X-Now']),
              correct: 1,
              answer: correctAnswer(exerciseId, null),
            }
          : {}),
      })),
    )
    .returning();
  const all =
    content.lessonsByConcept.get(conceptId)?.knowledge_points?.flatMap((step) => step.problems) ??
    [];
  removeExercises(all.filter((id) => id !== replacement));

  const { items } = (await (await getRun()).json()).run.quiz.current;
  expect(items).toEqual([
    expect.objectContaining({ id: saved.id, exercise: null, answered: true, answer: saved.answer }),
    expect.objectContaining({
      position: old.position,
      exercise: expect.objectContaining({ id: replacement }),
      answered: false,
    }),
  ]);
  expect(items[1].id).not.toBe(old.id);
  expect(
    await db.select().from(lessonQuizItems).where(eq(lessonQuizItems.id, dropped.id)),
  ).toHaveLength(0);
  expect((await answerQuizItem(items[1].id, correctAnswer(replacement, null))).status).toBe(200);
  const submitted = await submitQuiz();
  expect(submitted.status).toBe(200);
  expect((await submitted.json()).run.quiz.last).toMatchObject({ total: 2, correctCount: 2 });
  expect(
    (await db.select().from(lessonQuizItems).where(eq(lessonQuizItems.id, saved.id)))[0],
  ).toEqual(saved);
});

test('an entirely deleted quiz is restarted without recording a failed attempt', async () => {
  const run = await finishLessonSteps();
  const deleted = 'sl-inputs-targets-basics';
  const [quiz] = await db
    .insert(lessonQuizAttempts)
    .values({ runId: run.id, attemptNo: 1 })
    .returning();
  await db.insert(lessonQuizItems).values({
    quizAttemptId: quiz.id,
    position: 1,
    knowledgePointId: 'removed-knowledge-point',
    exerciseId: deleted,
  });
  removeExercises([deleted]);

  expect((await submitQuiz()).status).toBe(404);
  expect(
    await db.select().from(lessonQuizAttempts).where(eq(lessonQuizAttempts.runId, run.id)),
  ).toHaveLength(0);
  expect((await (await getRun()).json()).run.quiz).toMatchObject({ status: 'not_started' });
  const restarted = await startQuiz();
  expect(restarted.status).toBe(200);
  expect((await restarted.json()).run.quiz.current.items.length).toBeGreaterThan(0);
});

test('continuing a recovered review finalizes the surviving answers exactly once', async () => {
  const now = new Date(headers['X-Now']);
  const dueAt = new Date(now.getTime() - 86_400_000);
  const survivor = 'sl-classify-vs-regress';
  const deleted = 'sl-review-ingredients';
  const [card] = await db
    .insert(reviewCards)
    .values({
      userId,
      conceptId,
      dimension: 'conceptual',
      dueAt,
      fsrs: newReviewCard(dueAt),
    })
    .returning();
  const [session] = await db
    .insert(studySessions)
    .values({
      userId,
      status: 'active',
      startedAt: now,
      plannedMinutes: 15,
    })
    .returning();
  const [activity] = await db
    .insert(sessionActivities)
    .values({
      sessionId: session.id,
      idx: 0,
      kind: 'review',
      conceptId,
      plannedMinutes: 5,
      exerciseIds: [survivor, deleted],
      status: 'in_progress',
      startedAt: now,
    })
    .returning();
  const answer = await app.request('/api/attempts', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      activityId: activity.id,
      exerciseId: survivor,
      mode: 'review',
      answer: correctAnswer(survivor, null),
    }),
  });
  expect(answer.status).toBe(200);
  const { attemptId, activityCompleted } = await answer.json();
  expect(activityCompleted).toBe(false);
  expect(await db.select().from(reviewLogs).where(eq(reviewLogs.cardId, card.id))).toHaveLength(0);
  removeExercises([deleted]);

  for (let retry = 0; retry < 2; retry += 1) {
    const complete = await app.request(
      `/api/sessions/${session.id}/activities/${activity.id}/progress`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ complete: true, completedExerciseIds: [survivor] }),
      },
    );
    expect(complete.status).toBe(200);
    expect(await complete.json()).toMatchObject({ status: 'completed', exerciseIds: [survivor] });
  }
  const [rated] = await db.select().from(reviewCards).where(eq(reviewCards.id, card.id));
  expect(rated.reps).toBe(1);
  expect(rated.dueAt.getTime()).toBeGreaterThan(now.getTime());
  expect(await db.select().from(reviewLogs).where(eq(reviewLogs.cardId, card.id))).toEqual([
    expect.objectContaining({ attemptId }),
  ]);
  expect(
    await db
      .select()
      .from(xpEvents)
      .where(eq(xpEvents.sourceKey, `activity:${activity.id}`)),
  ).toEqual([expect.objectContaining({ amount: 5 })]);
  expect(await db.select().from(attempts).where(eq(attempts.activityId, activity.id))).toHaveLength(
    1,
  );
});

test.each([
  [true, false],
  [false, false],
  [false, true],
])('recover a saved review (surviving question: %s, remedial: %s)', async (partial, remedial) => {
  const now = new Date(headers['X-Now']);
  const dueAt = new Date(now.getTime() + (remedial ? 1 : -1) * 86_400_000);
  const deleted = 'sl-review-ingredients';
  const survivor = 'sl-classify-vs-regress';
  await db
    .insert(reviewCards)
    .values({ userId, conceptId, dimension: 'conceptual', dueAt, fsrs: newReviewCard(dueAt) });
  if (remedial) {
    await db.insert(remediationFlags).values({
      userId,
      conceptId: 'linear-regression',
      targetPrereqId: conceptId,
    });
  }
  const [session] = await db
    .insert(studySessions)
    .values({
      userId,
      status: 'active',
      startedAt: now,
      plannedMinutes: 15,
    })
    .returning();
  const [activity] = await db
    .insert(sessionActivities)
    .values({
      sessionId: session.id,
      idx: 0,
      kind: 'review',
      conceptId,
      plannedMinutes: 5,
      exerciseIds: partial ? [deleted, survivor] : [deleted],
      status: 'in_progress',
    })
    .returning();
  removeExercises([deleted]);

  const active = await app.request('/api/sessions/active', { headers });
  expect(active.status).toBe(200);
  const [restored] = (await active.json()).activities;
  expect(restored).toMatchObject({ id: activity.id, kind: 'review', status: 'in_progress' });
  if (partial) expect(restored.exerciseIds).toEqual([survivor]);
  else {
    expect(restored.exerciseIds.length).toBeGreaterThan(0);
    expect(restored.exerciseIds).not.toContain(deleted);
    expect(
      restored.exerciseIds.every(
        (id: string) => content.exercisesById.get(id)?.concept === conceptId,
      ),
    ).toBe(true);
  }
  const resumed = await app.request(`/api/sessions/${session.id}`, { headers });
  expect((await resumed.json()).activities[0].exerciseIds).toEqual(restored.exerciseIds);
  expect(
    (await db.select().from(reviewCards).where(eq(reviewCards.userId, userId)))[0].dueAt,
  ).toEqual(dueAt);
});

test('full lesson review carries its rendered checks and the same derived run status', async () => {
  const untouchedResponse = await app.request(`/api/lessons/${conceptId}/review`, { headers });
  expect((await untouchedResponse.json()).canRestart).toBe(false);
  const started = await (await startRun()).json();
  const response = await app.request(`/api/lessons/${conceptId}/review`, { headers });
  expect(response.status).toBe(200);
  const review = await response.json();
  expect(review.course).toMatchObject({
    id: 'ml-foundations',
    title: 'Machine Learning Foundations',
  });
  expect((await (await getRun()).json()).course).toEqual(review.course);
  expect(review.runStatus).toBe(started.run.status);
  expect(review.canRestart).toBe(true);
  const ids = Object.keys(review.checks);
  expect(ids).toEqual([review.lesson.final]);
  for (const id of ids) {
    const exercise = await (await app.request(`/api/exercises/${id}`, { headers })).json();
    expect(review.checks[id]).toEqual(exercise);
    expect(review.checks[id]).not.toHaveProperty('solution');
    expect(review.checks[id]).not.toHaveProperty('answer');
  }
});

test('lesson review derives run status from the current retry attempt', async () => {
  const fixture = [...content.lessonsByConcept.entries()].find(
    ([, lesson]) =>
      lesson.knowledge_points?.length &&
      lesson.knowledge_points.every((point) => point.problems.length > 0),
  );
  if (!fixture) throw new Error('No lesson with knowledge-point problems was found');
  const [runConceptId, lesson] = fixture;
  const knowledgePoints = lesson.knowledge_points ?? [];
  const [firstPoint] = knowledgePoints;
  if (!firstPoint) throw new Error('Missing first lesson point');
  const [run] = await db
    .insert(lessonRuns)
    .values({ userId, conceptId: runConceptId, status: 'in_progress', attempt: 2 })
    .returning();
  if (!run) throw new Error('Could not create retry lesson run');
  const servedAt = new Date(headers['X-Now']);
  const rows = [
    ...firstPoint.problems.slice(0, 3).map((exerciseId, position) => ({
      runId: run.id,
      knowledgePointId: firstPoint.id,
      round: 1,
      position,
      exerciseId,
      answeredAt: new Date(servedAt.getTime() + (position + 1) * 1_000),
      correct: 0,
    })),
    ...knowledgePoints.flatMap((point) =>
      point.problems.slice(0, 2).map((exerciseId, position) => ({
        runId: run.id,
        knowledgePointId: point.id,
        round: 2,
        position,
        exerciseId,
        answeredAt: new Date(servedAt.getTime() + (position + 4) * 1_000),
        correct: 1,
      })),
    ),
  ].map((row) => ({
    ...row,
    seed: null,
    servedAt,
  }));
  await db.insert(lessonProblems).values(rows);

  const response = await app.request(`/api/lessons/${runConceptId}/review`, { headers });
  expect(response.status).toBe(200);
  expect((await response.json()).runStatus).toBe('quiz');
});

test('locked started topics can restart while locked untouched topics cannot', async () => {
  const topicId = 'eigen-svd';
  const untouched = await app.request(`/api/lessons/${topicId}/review`, { headers });
  expect((await untouched.json()).canRestart).toBe(false);

  await db.insert(lessonRuns).values({
    userId,
    conceptId: topicId,
    status: 'in_progress',
  });
  const started = await app.request(`/api/lessons/${topicId}/review`, { headers });
  expect(started.status).toBe(200);
  expect((await started.json()).canRestart).toBe(true);
});

test('planned session activities persist their course and return it on lesson payloads', async () => {
  const conceptId = 'what-is-ml';
  await db
    .insert(courseEnrollments)
    .values({ userId, courseId: 'ml-foundations', status: 'active', startMethod: 'beginning' });
  const response = await app.request('/api/sessions', {
    method: 'POST',
    headers,
    body: JSON.stringify({ budgetMinutes: 60, focusConceptId: conceptId }),
  });
  expect(response.status).toBe(201);
  const session = await response.json();
  const [activity] = await db
    .select()
    .from(sessionActivities)
    .where(
      and(eq(sessionActivities.sessionId, session.id), eq(sessionActivities.conceptId, conceptId)),
    );
  expect(activity.reason).toMatchObject({ courseId: 'ml-foundations' });
  const run = await (
    await app.request(`/api/lessons/${conceptId}/run?activityId=${activity.id}`, { headers })
  ).json();
  const review = await (await app.request(`/api/lessons/${conceptId}/review`, { headers })).json();
  expect(run.course).toMatchObject({ id: 'ml-foundations' });
  expect(review.course).toEqual(run.course);
});

function concreteExercise(exerciseId: string, seed: number | null) {
  const exercise = content.exercisesById.get(exerciseId);
  if (!exercise) throw new Error(`Missing exercise ${exerciseId}`);
  return isTemplate(exercise) ? instantiateExercise(exercise, seed ?? 0).exercise : exercise;
}

function correctAnswer(exerciseId: string, seed: number | null): unknown {
  const exercise = concreteExercise(exerciseId, seed);
  if (exercise.type === 'mc') {
    const correct = exercise.options.filter((option) => option.correct).map((option) => option.id);
    return exercise.multi ? correct : correct[0];
  }
  if (exercise.type === 'numeric') return exercise.answer;
  if ('answer' in exercise) return exercise.answer;
  if ('accept' in exercise) return exercise.accept[0];
  if (exercise.type === 'debug') {
    return {
      line: exercise.buggy_line,
      fixId: exercise.fix_options.find((option) => option.correct)?.id,
    };
  }
  throw new Error(`No test answer for ${exercise.id}`);
}

function wrongAnswer(exerciseId: string, seed: number | null): unknown {
  const exercise = concreteExercise(exerciseId, seed);
  if (exercise.type === 'mc') {
    return exercise.options.find((option) => !option.correct)?.id ?? 'incorrect-option';
  }
  if (exercise.type === 'numeric') return exercise.answer + 1_000_000;
  if (exercise.type === 'debug') {
    return {
      line: exercise.buggy_line + 1,
      fixId: exercise.fix_options.find((option) => !option.correct)?.id ?? '',
    };
  }
  if ('answer' in exercise) {
    return typeof exercise.answer === 'number' ? exercise.answer + 1_000_000 : 'wrong answer';
  }
  if ('accept' in exercise) return 'wrong answer';
  throw new Error(`No test wrong answer for ${exercise.id}`);
}

async function answerProblem(
  problemId: string,
  answer: unknown,
  activityId?: string,
  requestHeaders = headers,
  runConceptId = conceptId,
) {
  return app.request(`/api/lessons/${runConceptId}/run/answer`, {
    method: 'POST',
    headers: requestHeaders,
    body: JSON.stringify({ problemId, answer, ...(activityId ? { activityId } : {}) }),
  });
}

function withPointKeyPrereqs(
  source: ContentIndex,
  runConceptId: string,
  pointId: string,
  keyPrereqIds: string[],
): ContentIndex {
  const lesson = source.lessonsByConcept.get(runConceptId);
  if (!lesson?.knowledge_points) throw new Error(`Missing lesson points for ${runConceptId}`);
  const updatedLesson = {
    ...lesson,
    knowledge_points: lesson.knowledge_points.map((point) =>
      point.id === pointId ? { ...point, key_prereqs: keyPrereqIds } : point,
    ),
  };
  return {
    ...source,
    lessonsByConcept: new Map(source.lessonsByConcept).set(runConceptId, updatedLesson),
  };
}

test('retry starts attempt two at step one and opens key prerequisite flags after no progress', async () => {
  const runConceptId = [...content.lessonsByConcept.keys()].find((id) => {
    const concept = content.conceptsById.get(id);
    return (
      Boolean(content.lessonsByConcept.get(id)?.knowledge_points?.length) &&
      concept?.prereqs.some((prerequisite) => prerequisite.strength === 'hard')
    );
  });
  if (!runConceptId) throw new Error('No lesson with a hard prerequisite was found');
  const lesson = content.lessonsByConcept.get(runConceptId);
  const firstPoint = lesson?.knowledge_points?.[0];
  const keyPrereqIds =
    content.conceptsById
      .get(runConceptId)
      ?.prereqs.filter((prerequisite) => prerequisite.strength === 'hard')
      .map(({ id }) => id) ?? [];
  if (!firstPoint || keyPrereqIds.length === 0) throw new Error('Missing lesson fixture');
  app = createApp({
    db,
    content: withPointKeyPrereqs(content, runConceptId, firstPoint.id, keyPrereqIds),
    tutorProvider: new FakeProvider(),
  });

  let run = (await (await startRun(undefined, runConceptId)).json()).run;
  const missPoint = async () => {
    for (let count = 0; count < 3; count += 1) {
      const pending = run.pending;
      expect(pending).toBeTruthy();
      const response = await answerProblem(
        pending.id,
        wrongAnswer(pending.exerciseId, pending.seed),
        undefined,
        headers,
        runConceptId,
      );
      expect(response.status).toBe(200);
      run = (await response.json()).state;
      if (count < 2) {
        run = (await (await startRun(undefined, runConceptId)).json()).run;
      }
    }
  };
  await missPoint();
  expect(run.status).toBe('needs_retry');

  const afterRetry = { ...headers, 'X-Now': '2026-01-02T01:00:00.000Z' };
  const restartedResponse = await startRun(undefined, runConceptId, afterRetry);
  expect(restartedResponse.status).toBe(200);
  run = (await restartedResponse.json()).run;
  expect(run.status).toBe('in_progress');
  expect(run.currentPointId).toBe(firstPoint.id);
  expect(run.points[0].round).toBe(2);

  for (let count = 0; count < 3; count += 1) {
    const pending = run.pending;
    const response = await answerProblem(
      pending.id,
      wrongAnswer(pending.exerciseId, pending.seed),
      undefined,
      afterRetry,
      runConceptId,
    );
    expect(response.status).toBe(200);
    run = (await response.json()).state;
    if (count < 2) run = (await (await startRun(undefined, runConceptId, afterRetry)).json()).run;
  }
  expect(run.status).toBe('needs_retry');
  expect((run.retry.reviewFirst as Array<{ id: string }>).map(({ id }) => id).sort()).toEqual(
    keyPrereqIds.sort(),
  );
  const flags = await db
    .select()
    .from(remediationFlags)
    .where(and(eq(remediationFlags.userId, userId), eq(remediationFlags.status, 'open')));
  expect(flags.map((flag) => flag.targetPrereqId).sort()).toEqual(keyPrereqIds.sort());
  const afterSecondRetryDate = { ...afterRetry, 'X-Now': '2026-01-03T01:00:00.000Z' };
  const blockedByReviews = await startRun(undefined, runConceptId, afterSecondRetryDate);
  expect(blockedByReviews.status).toBe(409);
  const error = await blockedByReviews.json();
  expect(error.error).toMatch(/^Review .+ first\.$/);
  for (const prerequisite of run.retry.reviewFirst)
    expect(error.error).toContain(prerequisite.title);
});

test('legacy in-progress run with a halted first step restarts at attempt two', async () => {
  const fixture = [...content.lessonsByConcept.entries()].find(([, lesson]) =>
    Boolean(
      lesson.knowledge_points?.[0]?.problems.length &&
        lesson.knowledge_points[0].problems.length >= 3,
    ),
  );
  if (!fixture) throw new Error('No lesson with three first-step problems was found');
  const [runConceptId, lesson] = fixture;
  const point = lesson.knowledge_points?.[0];
  if (!point) throw new Error('Missing first lesson point');
  const [legacyRun] = await db
    .insert(lessonRuns)
    .values({ userId, conceptId: runConceptId, status: 'in_progress' })
    .returning();
  if (!legacyRun) throw new Error('Could not create the legacy lesson run');
  const servedAt = new Date(headers['X-Now']);
  await db.insert(lessonProblems).values(
    point.problems.slice(0, 3).map((exerciseId, position) => {
      const exercise = content.exercisesById.get(exerciseId);
      if (!exercise) throw new Error(`Missing fixture exercise ${exerciseId}`);
      return {
        runId: legacyRun.id,
        knowledgePointId: point.id,
        round: 1,
        position,
        exerciseId,
        seed: isTemplate(exercise) ? position + 1 : null,
        servedAt: new Date(servedAt.getTime() + position * 1_000),
        answeredAt: new Date(servedAt.getTime() + (position + 1) * 1_000),
        correct: 0,
      };
    }),
  );

  const existing = await (await getRun(runConceptId)).json();
  expect(existing.run).toMatchObject({
    status: 'in_progress',
    halted: { pointId: point.id },
  });

  const started = await startRun(undefined, runConceptId);
  expect(started.status).toBe(200);
  const run = (await started.json()).run;
  expect(run.status).toBe('in_progress');
  expect(run.currentPointId).toBe(point.id);
  expect(run.pending.round).toBe(2);

  const answered = await answerProblem(
    run.pending.id,
    correctAnswer(run.pending.exerciseId, run.pending.seed),
    undefined,
    headers,
    runConceptId,
  );
  expect(answered.status).toBe(200);
  expect((await answered.json()).state.lastAnsweredProblem).toMatchObject({
    round: 2,
    correct: 1,
  });
  const [recoveredRun] = await db
    .select()
    .from(lessonRuns)
    .where(and(eq(lessonRuns.userId, userId), eq(lessonRuns.conceptId, runConceptId)));
  expect(recoveredRun).toMatchObject({
    attempt: 2,
    status: 'in_progress',
    haltedAt: null,
    retryAfter: null,
    haltCount: 0,
  });
  expect(
    await db
      .select()
      .from(remediationFlags)
      .where(
        and(
          eq(remediationFlags.userId, userId),
          eq(remediationFlags.conceptId, runConceptId),
          eq(remediationFlags.status, 'open'),
        ),
      ),
  ).toHaveLength(0);
});

test('legacy quiz run keeps passed steps after three misses and a pass', async () => {
  const fixture = [...content.lessonsByConcept.entries()].find(
    ([, lesson]) =>
      lesson.knowledge_points?.length &&
      lesson.knowledge_points.every((point) => point.problems.length > 0),
  );
  if (!fixture) throw new Error('No lesson with knowledge-point problems was found');
  const [runConceptId, lesson] = fixture;
  const knowledgePoints = lesson.knowledge_points ?? [];
  const firstPoint = knowledgePoints[0];
  if (!firstPoint?.problems.length) throw new Error('Missing first lesson point');
  const [legacyRun] = await db
    .insert(lessonRuns)
    .values({ userId, conceptId: runConceptId, status: 'quiz', attempt: 1 })
    .returning();
  if (!legacyRun) throw new Error('Could not create the legacy quiz run');
  const servedAt = new Date(headers['X-Now']);
  const rows = knowledgePoints.flatMap((point, pointIndex) => {
    const count = point.id === firstPoint.id ? 5 : 2;
    return Array.from({ length: count }, (_, position) => {
      const exerciseId = point.problems[position % point.problems.length];
      if (!exerciseId) throw new Error(`Missing exercise for ${point.id}`);
      const exercise = content.exercisesById.get(exerciseId);
      if (!exercise) throw new Error(`Missing fixture exercise ${exerciseId}`);
      const correct = point.id !== firstPoint.id || position >= 3 ? 1 : 0;
      return {
        runId: legacyRun.id,
        knowledgePointId: point.id,
        round: 1,
        position: pointIndex * 10 + position,
        exerciseId,
        seed: isTemplate(exercise) ? position + 1 : null,
        servedAt: new Date(servedAt.getTime() + position * 1_000),
        answeredAt: new Date(servedAt.getTime() + (position + 1) * 1_000),
        correct,
      };
    });
  });
  await db.insert(lessonProblems).values(rows);

  const started = await startRun(undefined, runConceptId);
  expect(started.status).toBe(200);
  const run = (await started.json()).run;
  expect(run.status).toBe('quiz');
  expect(run.points[0]).toMatchObject({ status: 'passed', round: 1 });
  expect(run.halted).toBeUndefined();
  const [storedRun] = await db
    .select()
    .from(lessonRuns)
    .where(and(eq(lessonRuns.userId, userId), eq(lessonRuns.conceptId, runConceptId)));
  expect(storedRun).toMatchObject({ attempt: 1, status: 'quiz' });
});

test('a halt after forward progress does not open remediation flags', async () => {
  const runConceptId = [...content.lessonsByConcept.keys()].find((id) => {
    const lesson = content.lessonsByConcept.get(id);
    return (
      Boolean(lesson?.knowledge_points && lesson.knowledge_points.length > 1) &&
      content.conceptsById.get(id)?.prereqs.some((prerequisite) => prerequisite.strength === 'hard')
    );
  });
  if (!runConceptId) throw new Error('No multi-step lesson with a hard prerequisite was found');
  const lesson = content.lessonsByConcept.get(runConceptId);
  const firstPoint = lesson?.knowledge_points?.[0];
  const secondPoint = lesson?.knowledge_points?.[1];
  const keyPrereqIds =
    content.conceptsById
      .get(runConceptId)
      ?.prereqs.filter((prerequisite) => prerequisite.strength === 'hard')
      .map(({ id }) => id) ?? [];
  if (!firstPoint || !secondPoint || keyPrereqIds.length === 0) {
    throw new Error('Missing multi-step lesson fixture');
  }
  let taggedContent = withPointKeyPrereqs(content, runConceptId, firstPoint.id, keyPrereqIds);
  taggedContent = withPointKeyPrereqs(taggedContent, runConceptId, secondPoint.id, keyPrereqIds);
  app = createApp({ db, content: taggedContent, tutorProvider: new FakeProvider() });

  let run = (await (await startRun(undefined, runConceptId)).json()).run;
  for (let count = 0; count < 3; count += 1) {
    const pending = run.pending;
    const response = await answerProblem(
      pending.id,
      wrongAnswer(pending.exerciseId, pending.seed),
      undefined,
      headers,
      runConceptId,
    );
    run = (await response.json()).state;
    if (count < 2) run = (await (await startRun(undefined, runConceptId)).json()).run;
  }
  expect(run.status).toBe('needs_retry');
  expect(run.halted.index).toBe(0);

  const afterRetry = { ...headers, 'X-Now': '2026-01-02T01:00:00.000Z' };
  run = (await (await startRun(undefined, runConceptId, afterRetry)).json()).run;
  while (run.currentPointId === firstPoint.id) {
    if (!run.pending)
      run = (await (await startRun(undefined, runConceptId, afterRetry)).json()).run;
    const pending = run.pending;
    const response = await answerProblem(
      pending.id,
      correctAnswer(pending.exerciseId, pending.seed),
      undefined,
      afterRetry,
      runConceptId,
    );
    run = (await response.json()).state;
  }
  expect(run.currentPointId).toBe(secondPoint.id);

  for (let count = 0; count < 3; count += 1) {
    if (!run.pending)
      run = (await (await startRun(undefined, runConceptId, afterRetry)).json()).run;
    const pending = run.pending;
    const response = await answerProblem(
      pending.id,
      wrongAnswer(pending.exerciseId, pending.seed),
      undefined,
      afterRetry,
      runConceptId,
    );
    run = (await response.json()).state;
    if (count < 2) run = (await (await startRun(undefined, runConceptId, afterRetry)).json()).run;
  }
  expect(run.status).toBe('needs_retry');
  expect(run.halted.index).toBe(1);
  expect(
    await db
      .select()
      .from(remediationFlags)
      .where(and(eq(remediationFlags.userId, userId), eq(remediationFlags.status, 'open'))),
  ).toHaveLength(0);
});

async function startQuiz(activityId?: string, runConceptId = conceptId) {
  return app.request(`/api/lessons/${runConceptId}/quiz/start`, {
    method: 'POST',
    headers,
    body: JSON.stringify(activityId ? { activityId } : {}),
  });
}

async function answerQuizItem(
  itemId: string,
  answer: unknown,
  activityId?: string,
  runConceptId = conceptId,
  durationMs?: number,
) {
  return app.request(`/api/lessons/${runConceptId}/quiz/answer`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      itemId,
      answer,
      ...(activityId ? { activityId } : {}),
      ...(durationMs === undefined ? {} : { durationMs }),
    }),
  });
}

async function submitQuiz(activityId?: string, runConceptId = conceptId) {
  return app.request(`/api/lessons/${runConceptId}/quiz/submit`, {
    method: 'POST',
    headers,
    body: JSON.stringify(activityId ? { activityId } : {}),
  });
}

async function finishLessonSteps(activityId?: string, runConceptId = conceptId) {
  let run = (await (await startRun(activityId, runConceptId)).json()).run;
  let steps = 0;
  while (run.status === 'in_progress' && steps < 100) {
    if (!run.pending) {
      run = (await (await startRun(activityId, runConceptId)).json()).run;
      continue;
    }
    const pending = run.pending;
    const response = await answerProblem(
      pending.id,
      correctAnswer(pending.exerciseId, pending.seed),
      activityId,
      headers,
      runConceptId,
    );
    expect(response.status).toBe(200);
    run = (await response.json()).state;
    steps += 1;
  }
  expect(steps).toBeLessThan(100);
  expect(run.status).toMatch(/^(quiz|completed)$/);
  return run;
}

async function answerQuizAttempt(
  quiz: { current: { attemptId: string } },
  correct = true,
  activityId?: string,
) {
  const items = await db
    .select()
    .from(lessonQuizItems)
    .where(eq(lessonQuizItems.quizAttemptId, quiz.current.attemptId))
    .orderBy(lessonQuizItems.position);
  for (const item of items) {
    const answer = correct
      ? correctAnswer(item.exerciseId, item.seed)
      : wrongAnswer(item.exerciseId, item.seed);
    const response = await answerQuizItem(item.id, answer, activityId);
    expect(response.status).toBe(200);
  }
  return items;
}

async function createDuePrerequisiteCard(prerequisiteConceptId: string) {
  const dueAt = new Date('2025-12-31T12:00:00.000Z');
  const reviewedAt = new Date('2025-12-01T12:00:00.000Z');
  const fsrs = {
    ...scheduleReview(newReviewCard(reviewedAt), reviewedAt, Rating.Good, 'UTC', false).card,
    state: State.Review,
    stability: 12,
    difficulty: 5,
    due: dueAt,
    reps: 5,
    lapses: 2,
  };
  const [card] = await db
    .insert(reviewCards)
    .values({
      userId,
      conceptId: prerequisiteConceptId,
      dimension: 'math',
      fsrs,
      dueAt,
      lastReviewAt: null,
      reps: fsrs.reps,
      lapses: fsrs.lapses,
    })
    .returning();
  if (!card) throw new Error(`Could not create the ${prerequisiteConceptId} review card`);
  return card;
}

async function submitQuizForConcept(runConceptId: string, wrongItemIndex = -1) {
  const run = await finishLessonSteps(undefined, runConceptId);
  expect(run.status).toBe('quiz');
  const started = await startQuiz(undefined, runConceptId);
  expect(started.status).toBe(200);
  const startedRun = (await started.json()).run;
  const items = await db
    .select()
    .from(lessonQuizItems)
    .where(eq(lessonQuizItems.quizAttemptId, startedRun.quiz.current.attemptId))
    .orderBy(lessonQuizItems.position);
  for (const [index, item] of items.entries()) {
    const answer =
      index === wrongItemIndex
        ? wrongAnswer(item.exerciseId, item.seed)
        : correctAnswer(item.exerciseId, item.seed);
    const response = await answerQuizItem(item.id, answer, undefined, runConceptId);
    expect(response.status).toBe(200);
  }
  const submitted = await submitQuiz(undefined, runConceptId);
  expect(submitted.status).toBe(200);
  return { result: await submitted.json(), items };
}

test('quiz misses do not halt a lesson run', async () => {
  await submitQuizForConcept(conceptId, 0);
  const [run] = await db
    .select()
    .from(lessonRuns)
    .where(and(eq(lessonRuns.userId, userId), eq(lessonRuns.conceptId, conceptId)));
  expect(run?.haltedAt).toBeNull();
  expect(run?.haltCount).toBe(0);
});

async function activityFixture() {
  const [session] = await db
    .insert(studySessions)
    .values({
      userId,
      plannedMinutes: 30,
      startedAt: new Date(headers['X-Now']),
      status: 'active',
    })
    .returning();
  if (!session) throw new Error('Could not create the session fixture');
  const rows = await db
    .insert(sessionActivities)
    .values([
      {
        sessionId: session.id,
        idx: 0,
        kind: 'learn',
        conceptId,
        plannedMinutes: 15,
        status: 'in_progress',
      },
      {
        sessionId: session.id,
        idx: 1,
        kind: 'practice',
        conceptId: 'linear-regression',
        plannedMinutes: 15,
        status: 'planned',
      },
    ])
    .returning();
  const [learn, next] = rows;
  if (!learn || !next) throw new Error('Could not create the activity fixtures');
  return { session, learn, next };
}

async function getCurrentRun() {
  const response = await getRun();
  expect(response.status).toBe(200);
  return (await response.json()).run;
}

async function rowCounts() {
  const runRows = await db
    .select({ id: lessonRuns.id })
    .from(lessonRuns)
    .where(eq(lessonRuns.userId, userId));
  const problemRows = runRows.length
    ? await db
        .select()
        .from(lessonProblems)
        .where(
          inArray(
            lessonProblems.runId,
            runRows.map((run) => run.id),
          ),
        )
    : [];
  return {
    enrollments: await db
      .select()
      .from(courseEnrollments)
      .where(eq(courseEnrollments.userId, userId)),
    studySetInitializedAt: (await db.select().from(users).where(eq(users.id, userId)))[0]
      .studySetInitializedAt,
    runs: runRows.length,
    problems: problemRows.length,
    attempts: (await db.select().from(attempts).where(eq(attempts.userId, userId))).length,
    xp: (await db.select().from(xpEvents).where(eq(xpEvents.userId, userId))).length,
  };
}

test('GET run is read-only and POST creates exactly one pending problem', async () => {
  const before = await rowCounts();
  expect(before.studySetInitializedAt).toBeNull();
  const review = await app.request(`/api/lessons/${conceptId}/review`, { headers });
  expect(review.status).toBe(200);
  expect(await rowCounts()).toEqual(before);
  const read = await getRun();
  expect(await read.json()).toMatchObject({ run: null });
  expect(await rowCounts()).toEqual(before);

  const first = await startRun();
  const firstBody = await first.json();
  expect(first.status).toBe(200);
  expect(firstBody.run.pendingProblem).toMatchObject({
    id: expect.any(String),
    exercise: { prompt: expect.any(String) },
  });
  const second = await startRun();
  expect((await second.json()).run.pendingProblem.id).toBe(firstBody.run.pendingProblem.id);
  expect(await db.select().from(lessonProblems)).toHaveLength(1);
});

test('run current point includes its optional tldr', async () => {
  const point = content.lessonsByConcept.get(conceptId)?.knowledge_points?.[0];
  if (!point) throw new Error('Missing first knowledge point');
  const originalTldr = point.tldr;
  point.tldr = 'A short summary before the explanation.';

  try {
    const response = await startRun();
    expect(response.status).toBe(200);
    expect((await response.json()).run.currentPoint).toMatchObject({
      id: point.id,
      tldr: point.tldr,
    });
  } finally {
    if (originalTldr === undefined) delete point.tldr;
    else point.tldr = originalTldr;
  }
});

test('lesson GETs do not backfill an uninitialized learner with prior lesson evidence', async () => {
  expect((await startRun()).status).toBe(200);
  await db.delete(courseEnrollments).where(eq(courseEnrollments.userId, userId));
  await db.update(users).set({ studySetInitializedAt: null }).where(eq(users.id, userId));
  const before = await rowCounts();
  expect(before.enrollments).toEqual([]);
  expect(before.studySetInitializedAt).toBeNull();
  const review = await app.request(`/api/lessons/${conceptId}/review`, { headers });
  expect(review.status).toBe(200);
  expect((await review.json()).course).toMatchObject({ id: 'ml-foundations' });
  expect(await rowCounts()).toEqual(before);
  const run = await getRun();
  expect(run.status).toBe(200);
  expect((await run.json()).course).toMatchObject({ id: 'ml-foundations' });
  expect(await rowCounts()).toEqual(before);
});

test('basics counts toward the two-correct streak and the XP award', async () => {
  let run = (await (await startRun()).json()).run;
  expect(run.currentPointId).toBe('sl-inputs-targets');
  expect(content.exercisesById.get(run.pending.exerciseId)?.role).toBe('basics');
  for (let count = 0; count < 3; count += 1) {
    const pending = run.pending;
    const response = await answerProblem(
      pending.id,
      correctAnswer(pending.exerciseId, pending.seed),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    run = body.state;
    expect(run.lastAnsweredProblem.id).toBe(pending.id);
    const resultExpectation = {
      yourAnswer: expect.any(String),
      correctAnswer: expect.any(String),
    };
    expect(run.lastAnsweredProblem.result).toMatchObject(resultExpectation);
    if (content.exercisesById.get(pending.exerciseId)?.type === 'mc') {
      expect(run.lastAnsweredProblem.result.answerOptions).toMatchObject({
        selected: expect.any(Array),
        correct: expect.any(Array),
      });
    }
    if (count === 0) expect(run.points[0]).toMatchObject({ answered: 1, streak: 1 });
    if (count < 2) run = (await (await startRun()).json()).run;
  }
  expect(run.points[0]).toMatchObject({ id: 'sl-inputs-targets', status: 'passed', answered: 2 });
  expect(run.xpEarned).toBe(10);
  const events = await db.select().from(xpEvents).where(eq(xpEvents.userId, userId));
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ kind: 'knowledge_point', amount: 10 });
});

test('asking the tutor never lowers credit or progress on a lesson answer', async () => {
  let run = (await (await startRun()).json()).run;
  let pending = run.pending;
  const firstAnswer = await answerProblem(
    pending.id,
    correctAnswer(pending.exerciseId, pending.seed),
  );
  expect(firstAnswer.status).toBe(200);
  run = (await firstAnswer.json()).state;
  expect(run.points[0]).toMatchObject({ status: 'active', streak: 1 });

  run = (await (await startRun()).json()).run;
  pending = run.pending;
  await db.insert(tutorMessages).values({
    userId,
    lessonProblemId: pending.id,
    role: 'user',
    content: 'Can you explain this question?',
    createdAt: new Date('2026-01-01T12:00:00.001Z'),
  });
  const assistedResponse = await answerProblem(
    pending.id,
    correctAnswer(pending.exerciseId, pending.seed),
    undefined,
    { ...headers, 'X-Now': '2026-01-01T12:00:01.000Z' },
  );
  expect(assistedResponse.status).toBe(200);
  const assistedBody = await assistedResponse.json();
  expect(assistedBody).not.toHaveProperty('assisted');
  expect(assistedBody.state.points[0]).toMatchObject({ status: 'passed', streak: 2 });
  expect(assistedBody.state.lastAnsweredProblem.result).not.toHaveProperty('assisted');
  const [assistedProblem] = await db
    .select()
    .from(lessonProblems)
    .where(eq(lessonProblems.id, pending.id));
  expect(assistedProblem?.assisted).toBe(false);
  const [assistedAttempt] = await db
    .select()
    .from(attempts)
    .where(eq(attempts.id, assistedProblem?.attemptId ?? ''));
  expect(assistedAttempt).toMatchObject({ hintsUsed: 0, credit: 1 });

  run = (await (await startRun()).json()).run;
  pending = run.pending;
  const unassistedResponse = await answerProblem(
    pending.id,
    correctAnswer(pending.exerciseId, pending.seed),
    undefined,
    { ...headers, 'X-Now': '2026-01-01T12:00:02.000Z' },
  );
  expect(unassistedResponse.status).toBe(200);
  const unassistedBody = await unassistedResponse.json();
  expect(unassistedBody.state.points[0]).toMatchObject({ status: 'passed', streak: 2 });
  expect(unassistedBody.state.points[1]).toMatchObject({ status: 'active', streak: 1 });
  const [unassistedProblem] = await db
    .select()
    .from(lessonProblems)
    .where(eq(lessonProblems.id, pending.id));
  expect(unassistedProblem?.assisted).toBe(false);
  const [unassistedAttempt] = await db
    .select()
    .from(attempts)
    .where(eq(attempts.id, unassistedProblem?.attemptId ?? ''));
  expect(unassistedAttempt).toMatchObject({ hintsUsed: 0 });
});

test('historical correct answers recover a blocked step without duplicate XP or replacing old awards', async () => {
  const initial = (await (await startRun()).json()).run;
  const problem = initial.pending;
  const [first] = await db.select().from(lessonProblems).where(eq(lessonProblems.id, problem.id));
  if (!first) throw new Error('Expected a served problem');
  await db
    .update(lessonProblems)
    .set({ correct: 1, answeredAt: new Date('2026-01-01T12:00:01Z') })
    .where(eq(lessonProblems.id, first.id));
  await db.insert(lessonProblems).values(
    [2, 3, 4].map((position) => ({
      runId: first.runId,
      knowledgePointId: first.knowledgePointId,
      round: first.round,
      position,
      exerciseId: first.exerciseId,
      seed: first.seed,
      assisted: true,
      correct: position < 4 ? 1 : null,
      servedAt: new Date(`2026-01-01T12:00:0${position}Z`),
      answeredAt: position < 4 ? new Date(`2026-01-01T12:00:0${position}Z`) : null,
    })),
  );
  const before = await (await getRun()).json();
  expect(before.run.points[0]).toMatchObject({ status: 'passed', streak: 2 });
  expect(before.run.needsProgressSync).toBe(true);
  expect(await db.select().from(xpEvents).where(eq(xpEvents.userId, userId))).toHaveLength(0);
  const reconcile = () =>
    app.request(`/api/lessons/${conceptId}/run`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ reconcileProgress: true }),
    });
  const recoveredResponse = await reconcile();
  expect(recoveredResponse.status).toBe(200);
  const recovered = (await recoveredResponse.json()).run;
  expect(recovered.needsProgressSync).toBeUndefined();
  expect(recovered.currentPointId).not.toBe(first.knowledgePointId);
  expect(recovered.points[0].xpEarned).toBe(10);
  await reconcile();
  const awards = await db.select().from(xpEvents).where(eq(xpEvents.userId, userId));
  expect(awards).toHaveLength(1);
  expect(awards[0].amount).toBe(10);
  expect(await db.select().from(attempts).where(eq(attempts.userId, userId))).toHaveLength(0);
  await db.update(xpEvents).set({ amount: 7 }).where(eq(xpEvents.id, awards[0].id));
  const preserved = (await (await reconcile()).json()).run;
  expect(preserved.points[0].xpEarned).toBe(7);
  expect(preserved.xpEarned).toBe(7);
});

test('double-submit returns 409 and records just one attempt', async () => {
  const run = (await (await startRun()).json()).run;
  const pending = run.pending;
  const answer = correctAnswer(pending.exerciseId, pending.seed);
  const firstResponse = await answerProblem(pending.id, answer);
  expect(firstResponse.status).toBe(200);
  expect((await firstResponse.json()).state.lastAnsweredProblem.id).toBe(pending.id);
  expect((await answerProblem(pending.id, answer)).status).toBe(409);
  expect(await db.select().from(attempts).where(eq(attempts.userId, userId))).toHaveLength(1);
});

async function pendingTemplate() {
  let run = (await (await startRun()).json()).run;
  for (let count = 0; count < 20; count += 1) {
    const pending = run.pending;
    if (!pending) throw new Error('No template was served before the lesson ended');
    const exercise = content.exercisesById.get(pending.exerciseId);
    if (exercise && isTemplate(exercise)) return { run, pending, exercise };
    const answer =
      count % 2 === 0
        ? wrongAnswer(pending.exerciseId, pending.seed)
        : correctAnswer(pending.exerciseId, pending.seed);
    const result = await answerProblem(pending.id, answer);
    run = (await result.json()).state;
    if (run.status === 'needs_retry')
      throw new Error('Template was not served before the point failed');
    if (!run.pending && run.status !== 'quiz' && count < 19) {
      run = (await (await startRun()).json()).run;
    }
  }
  throw new Error('No template was served in the first knowledge point');
}

test('a template is graded with its stored seed and rejects another seed answer', async () => {
  const own = await pendingTemplate();
  const accepted = await answerProblem(
    own.pending.id,
    correctAnswer(own.pending.exerciseId, own.pending.seed),
  );
  expect((await accepted.json()).correct).toBe(1);

  await db.delete(users).where(eq(users.id, userId));
  await db.insert(users).values({
    id: userId,
    displayName: 'Lesson runner test learner',
    timezone: 'Europe/London',
    startDate: '2026-01-01',
  });
  const otherSeedCase = await pendingTemplate();
  let alternateSeed = (otherSeedCase.pending.seed ?? 0) + 1;
  let alternateAnswer = instantiateExercise(otherSeedCase.exercise, alternateSeed).exercise.answer;
  const ownAnswer = correctAnswer(otherSeedCase.pending.exerciseId, otherSeedCase.pending.seed);
  while (alternateAnswer === ownAnswer) {
    alternateSeed += 1;
    alternateAnswer = instantiateExercise(otherSeedCase.exercise, alternateSeed).exercise.answer;
  }
  const rejected = await answerProblem(otherSeedCase.pending.id, alternateAnswer);
  expect(rejected.status).toBe(200);
  expect((await rejected.json()).correct).toBe(0);
});

test('three misses pause the lesson until the next local day and leave the activity open', async () => {
  const activities = await activityFixture();
  let run = (await (await startRun(activities.learn.id)).json()).run;
  for (let count = 0; count < 3; count += 1) {
    const pending = run.pending;
    const result = await answerProblem(
      pending.id,
      wrongAnswer(pending.exerciseId, pending.seed),
      activities.learn.id,
    );
    expect(result.status).toBe(200);
    const body = await result.json();
    run = body.state;
    expect(run.lastAnsweredProblem.id).toBe(pending.id);
    if (count < 2) run = (await (await startRun(activities.learn.id)).json()).run;
  }
  expect(run.status).toBe('needs_retry');
  expect(run.halted).toMatchObject({ pointId: 'sl-inputs-targets', index: 0 });
  expect(run.retry.after).toBe('2026-01-02T00:00:00.000Z');
  expect(run.pending).toBeFalsy();
  const [completedActivity] = await db
    .select()
    .from(sessionActivities)
    .where(eq(sessionActivities.id, activities.learn.id));
  const [startedActivity] = await db
    .select()
    .from(sessionActivities)
    .where(eq(sessionActivities.id, activities.next.id));
  expect(completedActivity?.status).toBe('in_progress');
  expect(startedActivity?.status).not.toBe('in_progress');
  const tooSoon = await startRun(activities.learn.id);
  expect(tooSoon.status).toBe(409);
  expect(await tooSoon.json()).toEqual({ error: 'This lesson comes back tomorrow.' });
});

test('finishing all points awards the XP sum and GET matches each POST state', async () => {
  let run = (await (await startRun()).json()).run;
  let reload = await getCurrentRun();
  expect(reload).toEqual(run);
  let steps = 0;
  while (run.status === 'in_progress' && steps < 30) {
    if (!run.pending) {
      run = (await (await startRun()).json()).run;
    } else {
      const pending = run.pending;
      const response = await answerProblem(
        pending.id,
        correctAnswer(pending.exerciseId, pending.seed),
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      run = body.state;
      expect(run.lastAnsweredProblem.id).toBe(pending.id);
    }
    reload = await getCurrentRun();
    expect(reload).toEqual(run);
    steps += 1;
  }
  expect(run.status).toBe('quiz');
  expect(run.points.every((point: { status: string }) => point.status === 'passed')).toBe(true);
  expect(run.xpEarned).toBe(
    run.points.reduce((sum: number, point: { answered: number }) => {
      const xp = { 2: 10, 3: 9, 4: 8, 5: 7 }[point.answered as 2 | 3 | 4 | 5] ?? 0;
      return sum + xp;
    }, 0),
  );
  expect(run.xpEarned).toBeGreaterThan(0);
});

test('practice-only questions resume, record practice, and do not change XP or run status', async () => {
  const completedSteps = await finishLessonSteps();
  const xpBefore = await db.select().from(xpEvents).where(eq(xpEvents.userId, userId));
  const pointId = completedSteps.points[0].id;
  const response = await app.request(`/api/lessons/${conceptId}/run/practice`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ pointId }),
  });
  expect(response.status).toBe(200);
  let run = (await response.json()).run;
  expect(run.status).toBe('quiz');
  expect(run.pendingPracticeProblem).toMatchObject({
    practiceOnly: true,
    answeredAt: null,
  });
  const practiceId = run.pendingPracticeProblem.id;
  const samePointResponse = await app.request(`/api/lessons/${conceptId}/run/practice`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ pointId }),
  });
  expect(samePointResponse.status).toBe(200);
  expect((await samePointResponse.json()).run.pendingPracticeProblem.id).toBe(practiceId);
  const pendingRows = await db
    .select()
    .from(lessonProblems)
    .where(eq(lessonProblems.runId, completedSteps.id));
  expect(pendingRows.filter((row) => row.practiceOnly && row.answeredAt === null)).toHaveLength(1);
  const switched = await app.request(`/api/lessons/${conceptId}/run/practice`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ pointId: completedSteps.points[1].id }),
  });
  expect(switched.status).toBe(200);
  run = (await switched.json()).run;
  expect(run.pendingPracticeProblem.knowledgePointId).toBe(completedSteps.points[1].id);
  const switchedPracticeId = run.pendingPracticeProblem.id;
  expect(switchedPracticeId).not.toBe(practiceId);
  const pendingAfterSwitch = await db
    .select()
    .from(lessonProblems)
    .where(eq(lessonProblems.runId, completedSteps.id));
  expect(
    pendingAfterSwitch.filter((row) => row.practiceOnly && row.answeredAt === null),
  ).toHaveLength(1);
  expect(pendingAfterSwitch.some((row) => row.id === practiceId)).toBe(false);
  const resumed = await getCurrentRun();
  expect(resumed.pendingPracticeProblem.id).toBe(switchedPracticeId);
  const answer = correctAnswer(
    resumed.pendingPracticeProblem.exerciseId,
    resumed.pendingPracticeProblem.seed,
  );
  const answered = await answerProblem(switchedPracticeId, answer);
  expect(answered.status).toBe(200);
  run = (await answered.json()).state;
  expect(run.status).toBe('quiz');
  expect(run.pendingPracticeProblem).toBeUndefined();
  expect(await db.select().from(xpEvents).where(eq(xpEvents.userId, userId))).toEqual(xpBefore);
  const [attempt] = await db
    .select()
    .from(attempts)
    .where(eq(attempts.id, run.lastAnsweredProblem.attemptId));
  expect(attempt?.mode).toBe('practice');
  const [problem] = await db
    .select()
    .from(lessonProblems)
    .where(eq(lessonProblems.id, switchedPracticeId));
  expect(problem?.practiceOnly).toBe(true);
});

test('quiz start is idempotent and unsubmitted answers disclose no correctness', async () => {
  await finishLessonSteps();
  const firstResponse = await startQuiz();
  expect(firstResponse.status).toBe(200);
  const firstRun = (await firstResponse.json()).run;
  expect(firstRun.quiz).toMatchObject({
    status: 'in_progress',
    passMark: 0.8,
    bestPassed: false,
  });
  expect(firstRun.quiz.current.items.length).toBeGreaterThan(0);
  const repeatedStart = await startQuiz();
  const repeatedRun = (await repeatedStart.json()).run;
  expect(repeatedRun.quiz.current.attemptId).toBe(firstRun.quiz.current.attemptId);
  expect(await db.select().from(lessonQuizAttempts)).toHaveLength(1);

  const attemptsBeforeAnswer = await db.select().from(attempts).where(eq(attempts.userId, userId));
  const masteryBeforeAnswer = await db.select().from(mastery).where(eq(mastery.userId, userId));
  const firstItem = firstRun.quiz.current.items[0];
  const question = JSON.stringify(firstItem);
  for (const secret of ['"answer"', '"answer_expr"', '"correct"', '"feedback"', '"solution"']) {
    expect(question).not.toContain(secret);
  }
  const [firstRow] = await db
    .select()
    .from(lessonQuizItems)
    .where(eq(lessonQuizItems.id, firstItem.id));
  if (!firstRow) throw new Error('Quiz item missing from database');
  const firstAnswer = correctAnswer(firstRow.exerciseId, firstRow.seed);
  const answered = await answerQuizItem(firstItem.id, firstAnswer);
  expect(answered.status).toBe(200);
  const answerBody = await answered.json();
  expect(answerBody).not.toHaveProperty('correct');
  expect(answerBody).not.toHaveProperty('feedback');
  expect(answerBody).not.toHaveProperty('solution');
  expect(answerBody.run.quiz.current.items[0]).toMatchObject({
    answered: true,
    answer: firstAnswer,
  });
  expect(answerBody.run.quiz.current.items[0]).not.toHaveProperty('correct');
  expect(JSON.stringify(answerBody.run.quiz.current)).not.toMatch(
    /"(?:correct|feedback|solution|answer_expr)"\s*:/,
  );
  const replacementAnswer = wrongAnswer(firstRow.exerciseId, firstRow.seed);
  const revised = await answerQuizItem(firstItem.id, replacementAnswer);
  expect(revised.status).toBe(200);
  const revisedBody = await revised.json();
  expect(revisedBody.run.quiz.current.items[0]).toMatchObject({
    answered: true,
    answer: replacementAnswer,
  });
  const [revisedRow] = await db
    .select()
    .from(lessonQuizItems)
    .where(eq(lessonQuizItems.id, firstItem.id));
  expect(revisedRow?.answer).toEqual(replacementAnswer);
  expect(revisedRow?.correct).toBeLessThan(1);
  expect(await db.select().from(attempts).where(eq(attempts.userId, userId))).toEqual(
    attemptsBeforeAnswer,
  );
  expect(await db.select().from(mastery).where(eq(mastery.userId, userId))).toEqual(
    masteryBeforeAnswer,
  );
  expect((await submitQuiz()).status).toBe(409);
  const review = await app.request(
    `/api/lessons/${conceptId}/quiz/${firstRun.quiz.current.attemptId}/review`,
    { headers },
  );
  expect(review.status).toBe(403);
  const remaining = await db
    .select()
    .from(lessonQuizItems)
    .where(eq(lessonQuizItems.quizAttemptId, firstRun.quiz.current.attemptId));
  for (const item of remaining.filter((row) => row.id !== firstItem.id)) {
    const response = await answerQuizItem(item.id, wrongAnswer(item.exerciseId, item.seed));
    expect(response.status).toBe(200);
  }
  const failed = await submitQuiz();
  expect(failed.status).toBe(200);
  const failedRun = (await failed.json()).run;
  expect(failedRun.quiz).toMatchObject({
    status: 'failed',
    bestPassed: false,
    last: { passed: false },
  });
  const submittedItems = await db
    .select()
    .from(lessonQuizItems)
    .where(eq(lessonQuizItems.quizAttemptId, firstRun.quiz.current.attemptId));
  expect(submittedItems.every((item) => item.attemptId !== null)).toBe(true);
  const quizAttemptIds = submittedItems.flatMap((item) => (item.attemptId ? [item.attemptId] : []));
  expect(await db.select().from(attempts).where(inArray(attempts.id, quizAttemptIds))).toHaveLength(
    submittedItems.length,
  );
  const masteryRows = await db
    .select({ evidence: mastery.evidence })
    .from(mastery)
    .where(eq(mastery.userId, userId));
  const masteredAttemptIds = new Set(
    masteryRows.flatMap((row) => {
      const evidence = row.evidence as { attempts?: Array<{ attemptId: string }> };
      return evidence.attempts?.map((attempt) => attempt.attemptId) ?? [];
    }),
  );
  expect(
    submittedItems.every((item) => item.attemptId && masteredAttemptIds.has(item.attemptId)),
  ).toBe(true);
  expect((await answerQuizItem(firstItem.id, 'after submit')).status).toBe(409);
  expect(failedRun.quiz.reviewRequired.length).toBeGreaterThan(0);
  expect(
    failedRun.quiz.reviewRequired.every(
      (step: { answered: number; needed: number }) => step.answered === 0 && step.needed === 3,
    ),
  ).toBe(true);
  const blockedRetake = await startQuiz();
  expect(blockedRetake.status).toBe(409);
  expect(await blockedRetake.json()).toEqual({
    error: 'Review the steps you missed before retaking the quiz',
  });
  let practiceTime = Date.parse(headers['X-Now']);
  for (const step of failedRun.quiz.reviewRequired as Array<{ pointId: string; needed: number }>) {
    for (let count = 0; count < step.needed; count += 1) {
      practiceTime += 1_000;
      const practiceHeaders = {
        ...headers,
        'X-Now': new Date(practiceTime).toISOString(),
      };
      const practiceResponse = await app.request(`/api/lessons/${conceptId}/run/practice`, {
        method: 'POST',
        headers: practiceHeaders,
        body: JSON.stringify({ pointId: step.pointId, warmup: true }),
      });
      expect(practiceResponse.status).toBe(200);
      const practiceRun = (await practiceResponse.json()).run;
      const practiceProblem = practiceRun.pendingPracticeProblem;
      expect(practiceProblem.practiceOnly).toBe(true);
      practiceTime += 1_000;
      const answerHeaders = {
        ...headers,
        'X-Now': new Date(practiceTime).toISOString(),
      };
      const answerResponse = await answerProblem(
        practiceProblem.id,
        correctAnswer(practiceProblem.exerciseId, practiceProblem.seed),
        undefined,
        answerHeaders,
      );
      expect(answerResponse.status).toBe(200);
    }
  }
  const reviewed = await getCurrentRun();
  expect(
    reviewed.quiz.reviewRequired.every((step: { answered: number }) => step.answered === 3),
  ).toBe(true);
  practiceTime += 1_000;
  const completePointId = reviewed.quiz.reviewRequired[0].pointId;
  const extraPractice = await app.request(`/api/lessons/${conceptId}/run/practice`, {
    method: 'POST',
    headers: { ...headers, 'X-Now': new Date(practiceTime).toISOString() },
    body: JSON.stringify({ pointId: completePointId }),
  });
  expect(extraPractice.status).toBe(200);
  const extraPracticeProblem = (await extraPractice.json()).run.pendingPracticeProblem;
  expect(extraPracticeProblem.knowledgePointId).toBe(completePointId);
  practiceTime += 1_000;
  const extraWarmup = await app.request(`/api/lessons/${conceptId}/run/practice`, {
    method: 'POST',
    headers: { ...headers, 'X-Now': new Date(practiceTime).toISOString() },
    body: JSON.stringify({
      pointId: completePointId,
      warmup: true,
    }),
  });
  expect(extraWarmup.status).toBe(409);
  expect(await extraWarmup.json()).toEqual({
    error: 'Quiz practice is complete for this step',
  });
  expect((await getCurrentRun()).pendingPracticeProblem).toBeUndefined();
  expect(
    await db.select().from(lessonProblems).where(eq(lessonProblems.id, extraPracticeProblem.id)),
  ).toHaveLength(0);
  expect((await startQuiz()).status).toBe(200);
  const failedReview = await app.request(
    `/api/lessons/${conceptId}/quiz/${firstRun.quiz.current.attemptId}/review`,
    { headers },
  );
  expect(failedReview.status).toBe(403);
});

test('quiz answers can be revised before submit and submission grades the latest answer', async () => {
  await finishLessonSteps();
  const started = (await (await startQuiz()).json()).run;
  const items = await db
    .select()
    .from(lessonQuizItems)
    .where(eq(lessonQuizItems.quizAttemptId, started.quiz.current.attemptId))
    .orderBy(lessonQuizItems.position);
  expect(items.length).toBeGreaterThanOrEqual(5);
  const wrongCount = Math.floor(items.length * 0.2) + 1;

  for (const [index, item] of items.entries()) {
    const answer =
      index < wrongCount
        ? wrongAnswer(item.exerciseId, item.seed)
        : correctAnswer(item.exerciseId, item.seed);
    expect((await answerQuizItem(item.id, answer)).status).toBe(200);
  }

  let storedItems = await db
    .select()
    .from(lessonQuizItems)
    .where(eq(lessonQuizItems.quizAttemptId, started.quiz.current.attemptId))
    .orderBy(lessonQuizItems.position);
  expect(scoreLessonQuiz(storedItems.map((item) => item.correct ?? 0)).passed).toBe(false);
  const revisedItem = items[0];
  if (!revisedItem) throw new Error('Expected a quiz item to revise');
  const revisedAnswer = correctAnswer(revisedItem.exerciseId, revisedItem.seed);
  expect((await answerQuizItem(revisedItem.id, revisedAnswer)).status).toBe(200);

  storedItems = await db
    .select()
    .from(lessonQuizItems)
    .where(eq(lessonQuizItems.quizAttemptId, started.quiz.current.attemptId))
    .orderBy(lessonQuizItems.position);
  expect(storedItems[0]?.answer).toEqual(revisedAnswer);
  expect(storedItems[0]?.correct).toBe(1);
  expect(scoreLessonQuiz(storedItems.map((item) => item.correct ?? 0)).passed).toBe(true);

  const itemToRegrade = storedItems.find((item) => item.correct === 1);
  if (!itemToRegrade) throw new Error('Expected a correct answer to regrade at submission');
  await db
    .update(lessonQuizItems)
    .set({ correct: 0 })
    .where(eq(lessonQuizItems.id, itemToRegrade.id));
  const beforeSubmitItems = await db
    .select()
    .from(lessonQuizItems)
    .where(eq(lessonQuizItems.quizAttemptId, started.quiz.current.attemptId))
    .orderBy(lessonQuizItems.position);
  expect(scoreLessonQuiz(beforeSubmitItems.map((item) => item.correct ?? 0)).passed).toBe(false);

  const submitted = await submitQuiz();
  expect(submitted.status).toBe(200);
  expect((await submitted.json()).run.quiz.last.passed).toBe(true);
  const finalItems = await db
    .select()
    .from(lessonQuizItems)
    .where(eq(lessonQuizItems.quizAttemptId, started.quiz.current.attemptId));
  expect(finalItems.find((item) => item.id === itemToRegrade.id)?.correct).toBe(1);
  expect(finalItems.filter((item) => item.attemptId !== null)).toHaveLength(items.length);
  const finalAttemptIds = finalItems.flatMap((item) => (item.attemptId ? [item.attemptId] : []));
  expect(
    await db.select().from(attempts).where(inArray(attempts.id, finalAttemptIds)),
  ).toHaveLength(items.length);
  expect(
    (await answerQuizItem(revisedItem.id, wrongAnswer(revisedItem.exerciseId, revisedItem.seed)))
      .status,
  ).toBe(409);
});

test('legacy quiz answers stay locked and submission does not duplicate their attempt', async () => {
  await finishLessonSteps();
  const started = (await (await startQuiz()).json()).run;
  const items = await db
    .select()
    .from(lessonQuizItems)
    .where(eq(lessonQuizItems.quizAttemptId, started.quiz.current.attemptId))
    .orderBy(lessonQuizItems.position);
  const legacyItem = items[0];
  if (!legacyItem) throw new Error('Expected a quiz item');
  const [legacyAttempt] = await db
    .select()
    .from(attempts)
    .where(eq(attempts.userId, userId))
    .limit(1);
  if (!legacyAttempt) throw new Error('Expected a prior attempt for the legacy fixture');
  const legacyAnswer = correctAnswer(legacyItem.exerciseId, legacyItem.seed);
  await db
    .update(lessonQuizItems)
    .set({
      answer: legacyAnswer,
      correct: 1,
      attemptId: legacyAttempt.id,
      answeredAt: new Date(headers['X-Now']),
    })
    .where(eq(lessonQuizItems.id, legacyItem.id));
  const legacyRun = await getCurrentRun();
  const legacyPayloadItem = legacyRun.quiz.current.items.find(
    (item: { id: string }) => item.id === legacyItem.id,
  );
  expect(legacyPayloadItem).toMatchObject({
    answered: true,
    answer: legacyAnswer,
    locked: true,
  });
  expect(legacyPayloadItem).not.toHaveProperty('correct');
  expect(
    (await answerQuizItem(legacyItem.id, wrongAnswer(legacyItem.exerciseId, legacyItem.seed)))
      .status,
  ).toBe(409);

  const attemptsBeforeSubmit = await db.select().from(attempts).where(eq(attempts.userId, userId));
  for (const item of items.slice(1)) {
    expect((await answerQuizItem(item.id, correctAnswer(item.exerciseId, item.seed))).status).toBe(
      200,
    );
  }
  const submitted = await submitQuiz();
  expect(submitted.status).toBe(200);

  const finalItems = await db
    .select()
    .from(lessonQuizItems)
    .where(eq(lessonQuizItems.quizAttemptId, started.quiz.current.attemptId));
  expect(finalItems.every((item) => item.attemptId !== null)).toBe(true);
  expect(await db.select().from(attempts).where(eq(attempts.userId, userId))).toHaveLength(
    attemptsBeforeSubmit.length + items.length - 1,
  );
  expect(await db.select().from(attempts).where(eq(attempts.id, legacyAttempt.id))).toHaveLength(1);
  expect((await answerQuizItem(legacyItem.id, legacyAnswer)).status).toBe(409);
});

test('passing and retaking a quiz awards quiz XP only once and enables review', async () => {
  await finishLessonSteps();
  expect(await db.select().from(reviewCards).where(eq(reviewCards.userId, userId))).toHaveLength(0);
  const started = (await (await startQuiz()).json()).run;
  const quizRows = await db
    .select()
    .from(lessonQuizItems)
    .where(eq(lessonQuizItems.quizAttemptId, started.quiz.current.attemptId))
    .orderBy(lessonQuizItems.position);
  const dimensions = new Set(
    quizRows.map((item) => content.exercisesById.get(item.exerciseId)?.dimension),
  );
  expect(dimensions.size).toBeGreaterThan(1);
  expect(quizRows.length).toBeGreaterThanOrEqual(5);
  const hardDimension = [...dimensions][0];
  const hardItem = quizRows.find(
    (item) => content.exercisesById.get(item.exerciseId)?.dimension === hardDimension,
  );
  if (!hardItem) throw new Error('Expected an item for the dimension rated Hard');
  for (const item of quizRows) {
    const answer =
      item.id === hardItem.id
        ? wrongAnswer(item.exerciseId, item.seed)
        : correctAnswer(item.exerciseId, item.seed);
    expect((await answerQuizItem(item.id, answer)).status).toBe(200);
  }
  const firstItems = quizRows;
  const passedResponse = await submitQuiz();
  expect(passedResponse.status).toBe(200);
  let result = await passedResponse.json();
  expect(result.run.quiz).toMatchObject({
    status: 'passed',
    bestPassed: true,
    last: { passed: true, total: firstItems.length },
  });
  expect(result.xpAwarded).toBe(firstItems.length);
  const quizXp = await db
    .select()
    .from(xpEvents)
    .where(and(eq(xpEvents.userId, userId), eq(xpEvents.kind, 'quiz')));
  expect(quizXp).toHaveLength(1);
  expect(quizXp[0]?.amount).toBe(firstItems.length);
  const firstPassCards = await db.select().from(reviewCards).where(eq(reviewCards.userId, userId));
  expect(firstPassCards.map((card) => card.dimension).sort()).toEqual([...dimensions].sort());
  for (const card of firstPassCards) {
    const [log] = await db.select().from(reviewLogs).where(eq(reviewLogs.cardId, card.id));
    expect(log?.rating).toBe(String(card.dimension === hardDimension ? Rating.Hard : Rating.Good));
  }
  const firstPassLogCount = (await db.select().from(reviewLogs)).length;
  const review = await app.request(
    `/api/lessons/${conceptId}/quiz/${result.run.quiz.last.attemptId}/review`,
    { headers },
  );
  expect(review.status).toBe(200);
  const reviewBody = await review.json();
  expect(reviewBody.items).toHaveLength(firstItems.length);
  expect(reviewBody.items[0]).toMatchObject({
    exercise: { prompt: expect.any(String) },
    yourAnswer: expect.any(String),
    correctAnswer: expect.any(String),
    solution: expect.any(String),
  });
  expect(reviewBody.items.some((item: { correct: number }) => item.correct === 0)).toBe(true);
  expect(reviewBody.items.some((item: { correct: number }) => item.correct === 1)).toBe(true);

  const retake = (await (await startQuiz()).json()).run;
  await answerQuizAttempt(retake.quiz);
  const secondPass = await submitQuiz();
  expect(secondPass.status).toBe(200);
  result = await secondPass.json();
  expect(result.xpAwarded).toBe(0);
  expect(result.run.quiz.bestPassed).toBe(true);
  expect(await db.select().from(reviewCards).where(eq(reviewCards.userId, userId))).toHaveLength(
    firstPassCards.length,
  );
  expect(await db.select().from(reviewLogs)).toHaveLength(firstPassLogCount);
  expect(
    await db
      .select()
      .from(xpEvents)
      .where(and(eq(xpEvents.userId, userId), eq(xpEvents.kind, 'quiz'))),
  ).toHaveLength(1);
});

test('an all-correct quiz credits hard prerequisites and leaves soft prerequisites alone', async () => {
  const hardCards = await Promise.all(['dot-product'].map(createDuePrerequisiteCard));
  const softCard = await createDuePrerequisiteCard('linear-regression');
  const { result, items } = await submitQuizForConcept('perceptron');

  expect(items.length).toBeGreaterThan(0);
  expect(result.run.quiz.last.passed).toBe(true);
  for (const prerequisiteCard of hardCards) {
    const [updated] = await db
      .select()
      .from(reviewCards)
      .where(eq(reviewCards.id, prerequisiteCard.id));
    if (!updated) throw new Error('Expected a credited hard-prerequisite card');
    expect(updated.dueAt.getTime()).toBeGreaterThan(prerequisiteCard.dueAt.getTime());
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

test('a passed quiz with a Hard dimension credits hard prerequisites', async () => {
  const hardCards = await Promise.all(
    ['linear-regression', 'gradient-descent', 'probability-basics'].map(createDuePrerequisiteCard),
  );
  const { result, items } = await submitQuizForConcept('logistic-regression', 0);

  expect(items.length).toBeGreaterThan(1);
  expect(result.run.quiz.last.passed).toBe(true);
  const firstItem = items[0];
  if (!firstItem) throw new Error('Expected a quiz item');
  const hardDimension = content.exercisesById.get(firstItem.exerciseId)?.dimension;
  if (!hardDimension) throw new Error('Expected the wrong answer to have a dimension');
  const [dimensionCard] = await db
    .select()
    .from(reviewCards)
    .where(
      and(
        eq(reviewCards.userId, userId),
        eq(reviewCards.conceptId, 'logistic-regression'),
        eq(reviewCards.dimension, hardDimension),
      ),
    );
  if (!dimensionCard) throw new Error('Expected a card for the Hard quiz dimension');
  const [dimensionLog] = await db
    .select()
    .from(reviewLogs)
    .where(eq(reviewLogs.cardId, dimensionCard.id));
  expect(dimensionLog?.rating).toBe(String(Rating.Hard));
  for (const prerequisiteCard of hardCards) {
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
  }
});

test('a passed quiz with any Again dimension does not credit hard prerequisites', async () => {
  const runConceptId = 'activation-functions';
  const prereqs =
    content.conceptsById
      .get(runConceptId)
      ?.prereqs.filter((prereq) => prereq.strength === 'hard') ?? [];
  const prerequisiteCards = await Promise.all(
    prereqs.map((prereq) => createDuePrerequisiteCard(prereq.id)),
  );
  const run = await finishLessonSteps(undefined, runConceptId);
  expect(run.status).toBe('quiz');
  const started = await startQuiz(undefined, runConceptId);
  expect(started.status).toBe(200);
  const startedRun = (await started.json()).run;
  const items = await db
    .select()
    .from(lessonQuizItems)
    .where(eq(lessonQuizItems.quizAttemptId, startedRun.quiz.current.attemptId))
    .orderBy(lessonQuizItems.position);
  const byDimension = new Map<string, typeof items>();
  for (const item of items) {
    const dimension = content.exercisesById.get(item.exerciseId)?.dimension;
    if (!dimension) throw new Error(`Missing dimension for ${item.exerciseId}`);
    byDimension.set(dimension, [...(byDimension.get(dimension) ?? []), item]);
  }
  const againDimension = [...byDimension].sort(
    (left, right) => left[1].length - right[1].length,
  )[0]?.[0];
  if (!againDimension) throw new Error('Expected at least one quiz dimension');
  const [againItem] = byDimension.get(againDimension) ?? [];
  if (!againItem) throw new Error('Expected an item for the Again-rated dimension');
  for (const item of items) {
    const answer =
      item.id === againItem.id
        ? wrongAnswer(item.exerciseId, item.seed)
        : correctAnswer(item.exerciseId, item.seed);
    const response = await answerQuizItem(item.id, answer, undefined, runConceptId);
    expect(response.status).toBe(200);
  }
  const submitted = await submitQuiz(undefined, runConceptId);
  expect(submitted.status).toBe(200);
  const result = await submitted.json();
  expect(result.run.quiz.last.passed).toBe(true);
  const [againCard] = await db
    .select()
    .from(reviewCards)
    .where(
      and(
        eq(reviewCards.userId, userId),
        eq(reviewCards.conceptId, runConceptId),
        eq(reviewCards.dimension, againDimension),
      ),
    );
  if (!againCard) throw new Error('Expected the Again-rated quiz dimension');
  const [againLog] = await db.select().from(reviewLogs).where(eq(reviewLogs.cardId, againCard.id));
  expect(againLog?.rating).toBe(String(Rating.Again));
  for (const prerequisiteCard of prerequisiteCards) {
    const [unchanged] = await db
      .select()
      .from(reviewCards)
      .where(eq(reviewCards.id, prerequisiteCard.id));
    if (!unchanged) throw new Error('Expected the prerequisite card');
    expect(unchanged.dueAt).toEqual(prerequisiteCard.dueAt);
  }
});

test('a slow correct lesson quiz answer rates its dimension Hard and stores its duration', async () => {
  await finishLessonSteps();
  const started = (await (await startQuiz()).json()).run;
  const quizRows = await db
    .select()
    .from(lessonQuizItems)
    .where(eq(lessonQuizItems.quizAttemptId, started.quiz.current.attemptId))
    .orderBy(lessonQuizItems.position);
  const targetItem = quizRows[0];
  if (!targetItem) throw new Error('Expected a lesson quiz item');
  const originalExercise = content.exercisesById.get(targetItem.exerciseId);
  if (!originalExercise) throw new Error(`Missing exercise ${targetItem.exerciseId}`);
  content.exercisesById.set(targetItem.exerciseId, {
    ...originalExercise,
    target_seconds: 30,
  });

  try {
    for (const item of quizRows) {
      const response = await answerQuizItem(
        item.id,
        correctAnswer(item.exerciseId, item.seed),
        undefined,
        conceptId,
        item.id === targetItem.id ? 30_001 : 1_000,
      );
      expect(response.status).toBe(200);
    }

    const submitted = await submitQuiz();
    expect(submitted.status).toBe(200);

    const [storedTargetItem] = await db
      .select()
      .from(lessonQuizItems)
      .where(eq(lessonQuizItems.id, targetItem.id));
    expect(storedTargetItem?.durationMs).toBe(30_001);
    if (!storedTargetItem?.attemptId) throw new Error('Expected an attempt for the slow answer');

    const [attempt] = await db
      .select()
      .from(attempts)
      .where(eq(attempts.id, storedTargetItem.attemptId));
    expect(attempt?.durationMs).toBe(30_001);

    const [card] = await db
      .select()
      .from(reviewCards)
      .where(
        and(
          eq(reviewCards.userId, userId),
          eq(reviewCards.conceptId, conceptId),
          eq(reviewCards.dimension, originalExercise.dimension),
        ),
      );
    if (!card) throw new Error('Expected a review card for the slow-answer dimension');
    const [log] = await db.select().from(reviewLogs).where(eq(reviewLogs.cardId, card.id));
    expect(log?.rating).toBe(String(Rating.Hard));
  } finally {
    content.exercisesById.set(targetItem.exerciseId, originalExercise);
  }
});

test('an all-correct quiz with a slow target answer credits hard prerequisites as Hard', async () => {
  const hardCards = await Promise.all(
    ['linear-regression', 'gradient-descent'].map(createDuePrerequisiteCard),
  );
  const run = await finishLessonSteps(undefined, 'logistic-regression');
  expect(run.status).toBe('quiz');
  const started = await startQuiz(undefined, 'logistic-regression');
  expect(started.status).toBe(200);
  const startedRun = (await started.json()).run;
  const quizRows = await db
    .select()
    .from(lessonQuizItems)
    .where(eq(lessonQuizItems.quizAttemptId, startedRun.quiz.current.attemptId))
    .orderBy(lessonQuizItems.position);
  const targetItem = quizRows[0];
  if (!targetItem) throw new Error('Expected a lesson quiz item');
  const originalExercise = content.exercisesById.get(targetItem.exerciseId);
  if (!originalExercise) throw new Error(`Missing exercise ${targetItem.exerciseId}`);
  content.exercisesById.set(targetItem.exerciseId, {
    ...originalExercise,
    target_seconds: 30,
  });

  try {
    for (const item of quizRows) {
      const response = await answerQuizItem(
        item.id,
        correctAnswer(item.exerciseId, item.seed),
        undefined,
        'logistic-regression',
        item.id === targetItem.id ? 30_001 : 1_000,
      );
      expect(response.status).toBe(200);
    }

    const submitted = await submitQuiz(undefined, 'logistic-regression');
    expect(submitted.status).toBe(200);
    const result = await submitted.json();
    expect(result.run.quiz.last.passed).toBe(true);

    const submittedItems = await db
      .select()
      .from(lessonQuizItems)
      .where(eq(lessonQuizItems.quizAttemptId, startedRun.quiz.current.attemptId))
      .orderBy(lessonQuizItems.position);
    expect(submittedItems.every((item) => item.correct !== null && item.correct >= 1)).toBe(true);
    expect(submittedItems.find((item) => item.id === targetItem.id)?.durationMs).toBe(30_001);

    const [dimensionCard] = await db
      .select()
      .from(reviewCards)
      .where(
        and(
          eq(reviewCards.userId, userId),
          eq(reviewCards.conceptId, 'logistic-regression'),
          eq(reviewCards.dimension, originalExercise.dimension),
        ),
      );
    if (!dimensionCard) throw new Error('Expected a review card for the slow-answer dimension');
    const [dimensionLog] = await db
      .select()
      .from(reviewLogs)
      .where(eq(reviewLogs.cardId, dimensionCard.id));
    expect(dimensionLog?.rating).toBe(String(Rating.Hard));

    for (const prerequisiteCard of hardCards) {
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
    }
  } finally {
    content.exercisesById.set(targetItem.exerciseId, originalExercise);
  }
});

test('quiz submission completes its attached learn activity after pass or fail', async () => {
  const activities = await activityFixture();
  const run = await finishLessonSteps(activities.learn.id);
  const started = (await (await startQuiz(activities.learn.id)).json()).run;
  await answerQuizAttempt(started.quiz, true, activities.learn.id);
  const submitted = await submitQuiz(activities.learn.id);
  expect(submitted.status).toBe(200);
  const [completedActivity] = await db
    .select()
    .from(sessionActivities)
    .where(eq(sessionActivities.id, activities.learn.id));
  const [nextActivity] = await db
    .select()
    .from(sessionActivities)
    .where(eq(sessionActivities.id, activities.next.id));
  expect(completedActivity?.status).toBe('completed');
  expect(nextActivity?.status).toBe('in_progress');
  expect(run.status).toBe('quiz');
});

test('template guards and tutor threads safely support unanswered lesson problems', async () => {
  const template = content.exercises.find((exercise) => isTemplate(exercise));
  if (!template) throw new Error('Expected a template exercise');
  const getTemplate = await app.request(`/api/exercises/${template.id}`, { headers });
  expect(getTemplate.status).toBe(400);
  const attemptTemplate = await app.request('/api/attempts', {
    method: 'POST',
    headers,
    body: JSON.stringify({ exerciseId: template.id, answer: 1, mode: 'practice' }),
  });
  expect(attemptTemplate.status).toBe(400);
  const run = (await (await startRun()).json()).run;
  const chat = await app.request('/api/tutor/threads', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      question: 'Can you help?',
      lessonProblemId: run.pending.id,
    }),
  });
  expect(chat.status).toBe(200);
});

test('test answer endpoint is absent unless ACADEMY_E2E is enabled', async () => {
  const previous = process.env.ACADEMY_E2E;
  delete process.env.ACADEMY_E2E;
  try {
    const withoutHook = createApp({ db, content, tutorProvider: new FakeProvider() });
    const response = await withoutHook.request(
      '/api/test/lesson-problems/00000000-0000-4000-8000-000000000001/answer',
      { headers },
    );
    expect(response.status).toBe(404);
  } finally {
    if (previous === undefined) delete process.env.ACADEMY_E2E;
    else process.env.ACADEMY_E2E = previous;
  }
});
