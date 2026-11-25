import { fileURLToPath } from 'node:url';
import { Rating } from 'ts-fsrs';
import { expect, test, vi } from 'vitest';
import { loadContentFromDirectory } from '../course/load.js';
import { activityRow, sessionRow } from '../store/learner-store.contract.js';
import { memoryStore } from '../store/memory-store.js';
import { prepareExerciseAttempt, recordExerciseAttempt } from './exercise-attempts.js';
import { newReviewCard } from './fsrs.js';
import { recordRecoveredReviewRatings } from './review-completion.js';

const content = loadContentFromDirectory(
  fileURLToPath(new URL('../../../../tests/fixtures/content', import.meta.url)),
);
const userId = 'learner';
const now = new Date('2026-01-17T12:00:00Z');

test('a graded review updates mastery, records one schedule and completes the activity once', async () => {
  const index = await content;
  const exercise = index.exercisesByConcept
    .get('supervised-learning')
    ?.find(({ type }) => type === 'mc');
  if (!exercise) throw new Error('No review exercise fixture');
  const store = memoryStore();
  const session = await store.insertSession(userId, sessionRow(now));
  const [review, next] = await store.insertActivities(userId, session.id, [
    activityRow(0, {
      kind: 'review',
      status: 'in_progress',
      exerciseIds: [exercise.id],
      conceptId: exercise.concept,
    }),
    activityRow(1),
  ]);
  const card = await store.insertReviewCard(userId, {
    conceptId: exercise.concept,
    dimension: exercise.dimension,
    fsrs: newReviewCard(now),
    dueAt: now,
    lastReviewAt: null,
    reps: 0,
    lapses: 0,
  });
  const runtime = {
    now: () => now,
    newId: () => 'review-attempt',
    enableFsrsFuzz: false,
    session: async () => ({
      ...session,
      activities: await store.listActivities(userId, { sessionIds: [session.id] }),
    }),
    schedulerState: async () => {
      throw new Error('No prerequisite reset expected');
    },
    linkTimedQuizFollowUp: vi.fn(async () => {}),
  };
  const prepared = await prepareExerciseAttempt(
    store,
    userId,
    index,
    exercise,
    {
      activityId: review.id,
      mode: 'review',
      answer: 'submitted answer',
    },
    runtime.session,
  );
  if (prepared.kind !== 'ready') throw new Error('Review submission was rejected');
  const recorded = await recordExerciseAttempt(
    store,
    runtime,
    prepared,
    {
      correct: 1,
      feedback: 'Correct',
      gradedBy: 'deterministic',
    },
    'UTC',
  );
  expect(recorded).toMatchObject({ attemptNo: 1, activityCompleted: true, hintsUsed: 0 });
  expect(await store.listTopicSpeedEvidence(userId, [exercise.concept])).toMatchObject([
    { answers: 1, successes: 1 },
  ]);
  expect(await store.listReviewLogs(userId, { activityId: review.id })).toMatchObject([
    {
      cardId: card.id,
      attemptId: recorded.attemptId,
      rating: Rating.Good,
      speed: 1,
      rawDueAt: expect.any(Date),
      fsrsLog: { effectiveDueAt: expect.any(Date) },
    },
  ]);
  expect(await store.listActivities(userId, { ids: [review.id, next.id] })).toMatchObject([
    { id: review.id, status: 'completed' },
    { id: next.id, status: 'in_progress' },
  ]);
  expect(await store.listXpEvents(userId, {})).toMatchObject([
    { sourceKey: `activity:${review.id}`, amount: review.plannedMinutes },
  ]);
  expect(runtime.linkTimedQuizFollowUp).toHaveBeenCalledWith(userId, review.id, [exercise.concept]);

  await recordRecoveredReviewRatings(
    store,
    runtime,
    { index, userId, timeZone: 'UTC', now },
    review,
  );
  expect(await store.listReviewLogs(userId, { activityId: review.id })).toHaveLength(1);
});
