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
