import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { loadContentFromDirectory } from '../course/load.js';
import { activityRow, sessionRow } from '../store/learner-store.contract.js';
import { memoryStore } from '../store/memory-store.js';
import { createEngine } from './create-engine.js';

const content = loadContentFromDirectory(
  fileURLToPath(new URL('../../../../content', import.meta.url)),
);

test('hints and quiz reviews accept memory-issued activity and attempt IDs', async () => {
  const index = await content;
  const exercise = index.exercises.find(
    ({ hints, role }) => hints.length > 0 && role !== 'diagnostic',
  );
  const lessonEntry = [...index.lessonsByConcept.entries()].find(
    ([, lesson]) => lesson.knowledge_points?.length,
  );
  if (!exercise || !lessonEntry) throw new Error('Missing lesson or hinted exercise fixture');
  const [conceptId, lesson] = lessonEntry;
  const pointId = lesson.knowledge_points?.[0]?.id;
  if (!pointId) throw new Error('Missing lesson knowledge point fixture');

  const learnerId = 'learner';
  const now = new Date('2026-01-17T12:00:00Z');
  const store = memoryStore();
  const session = await store.insertSession(learnerId, {
    ...sessionRow(now),
    status: 'completed',
    endedAt: now,
  });
  const [activity] = await store.insertActivities(learnerId, session.id, [
    activityRow(0, { exerciseIds: [exercise.id] }),
  ]);
  if (!activity) throw new Error('Activity did not insert');

  const run = await store.insertLessonRunIfAbsent(learnerId, {
    conceptId,
    status: 'completed',
    startedAt: now,
    updatedAt: now,
    completedAt: now,
    quizPassedAt: now,
    attempt: 1,
    haltedAt: null,
    retryAfter: null,
    haltedPointIndex: null,
    haltCount: 0,
  });
  if (!run) throw new Error('Lesson run did not insert');
  const attempt = await store.insertLessonQuiz(
    learnerId,
    run.id,
    { attemptNo: 1, startedAt: now, submittedAt: now, score: 1, passed: true },
    [
      {
        position: 0,
        knowledgePointId: pointId,
        exerciseId: exercise.id,
        seed: 0,
        answer: '',
        evidence: null,
        correct: 1,
        durationMs: 1_000,
        attemptId: null,
        answeredAt: now,
      },
    ],
  );

  const learner = createEngine({
    content: async () => index,
    store,
    fsrsFuzz: false,
  }).learner({
    id: learnerId,
    timeZone: 'UTC',
    now: () => now,
    random: () => 0.5,
  });
  expect(activity.id).toMatch(/^activity-/);
  expect(attempt.id).toMatch(/^lesson-quiz-/);
  expect(
    await learner.hint({ body: { exerciseId: exercise.id, activityId: activity.id } }),
  ).toMatchObject({
    status: 200,
    body: { level: 1, text: exercise.hints[0] },
  });
  expect(await learner.lessonQuizReview({ conceptId, attemptId: attempt.id })).toMatchObject({
    status: 200,
    body: {
      attemptId: attempt.id,
      items: [{ position: 0, pointId, exercise: { id: exercise.id } }],
    },
  });
});

test('session uses the derived lesson run status after the lesson gains a knowledge point', async () => {
  const originalIndex = await content;
  const fixture = [...originalIndex.lessonsByConcept.entries()].flatMap(([conceptId, lesson]) =>
    (lesson.knowledge_points ?? []).flatMap((point) => {
      const exercises = point.problems.flatMap((id) => {
        const exercise = originalIndex.exercisesById.get(id);
        return exercise && exercise.role !== 'recall' ? [exercise] : [];
      });
      return exercises.length >= 2
        ? [{ conceptId, lesson, point, exercises: exercises.slice(0, 2) }]
        : [];
    }),
  )[0];
  if (!fixture) throw new Error('Missing lesson point with two progression problems');
  const [firstProblem, secondProblem] = fixture.exercises;
  if (!firstProblem || !secondProblem) throw new Error('Missing lesson progression problems');
  const { conceptId, lesson, point } = fixture;
  const knowledgePoints = lesson.knowledge_points ?? [];
  const expandedIndex = {
    ...originalIndex,
    lessonsByConcept: new Map(originalIndex.lessonsByConcept),
  };
  expandedIndex.lessonsByConcept.set(conceptId, {
    ...lesson,
    knowledge_points: [
      ...knowledgePoints,
      { ...point, id: `${point.id}-added`, title: `${point.title} added` },
    ],
  });

  const learnerId = 'learner';
  const now = new Date('2026-01-17T12:00:00Z');
  const store = memoryStore();
  const session = await store.insertSession(learnerId, {
    ...sessionRow(now),
    status: 'completed',
    endedAt: now,
  });
  const [completedActivity, nextActivity] = await store.insertActivities(learnerId, session.id, [
    activityRow(0, {
      conceptId,
      exerciseIds: [lesson.final ?? firstProblem.id],
      status: 'completed',
      progress: {
        lessonRunnerContinued: true,
        finalQuestionContinued: true,
        completedExerciseIds: [lesson.final ?? firstProblem.id],
      },
      startedAt: now,
      completedAt: now,
    }),
    activityRow(1, {
      conceptId,
      kind: 'practice',
      exerciseIds: [firstProblem.id],
      status: 'in_progress',
      startedAt: now,
      progress: {},
    }),
  ]);
  if (!completedActivity || !nextActivity) throw new Error('Session activities did not insert');
  const run = await store.insertLessonRunIfAbsent(learnerId, {
    conceptId,
    status: 'completed',
    startedAt: now,
    updatedAt: now,
    completedAt: now,
    quizPassedAt: now,
    attempt: 1,
    haltedAt: null,
    retryAfter: null,
    haltedPointIndex: null,
    haltCount: 0,
  });
  if (!run) throw new Error('Lesson run did not insert');
  for (const [position, exercise] of [firstProblem, secondProblem].entries()) {
    await store.insertLessonProblem(learnerId, run.id, {
      knowledgePointId: point.id,
      round: 1,
      position,
      exerciseId: exercise.id,
      seed: null,
      practiceOnly: false,
      assisted: false,
      servedAt: new Date(now.getTime() + position),
      answeredAt: new Date(now.getTime() + position),
      correct: 1,
      attemptId: null,
    });
  }

  const learner = createEngine({
    content: async () => expandedIndex,
    store,
    fsrsFuzz: false,
  }).learner({
    id: learnerId,
    timeZone: 'UTC',
    now: () => now,
    random: () => 0.5,
  });
  const result = await learner.session({ sessionId: session.id });
  expect(result.status).toBe(200);
  const body = result.body as {
    current: { activityId?: string; openableIds: string[] };
    activities: Array<{ id: string; lessonRunner?: boolean; lessonQuiz?: boolean }>;
  };
  expect(body.current).toEqual({
    activityId: nextActivity.id,
    openableIds: [completedActivity.id, nextActivity.id],
  });
  expect(body.activities.find(({ id }) => id === completedActivity.id)).toMatchObject({
    lessonRunner: true,
    lessonQuiz: false,
  });
  expect(await store.getLessonRun(learnerId, { runId: run.id })).toMatchObject({
    status: 'completed',
  });
});
