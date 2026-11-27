import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import type { TutorTurn } from '../api/tutor.js';
import { loadContentFromDirectory } from '../course/load.js';
import type { IndexedExercise } from '../course/types.js';
import { createEngine } from '../engine/create-engine.js';
import type { Attempt } from '../store/core-store.js';
import { activityRow, sessionRow } from '../store/learner-store.contract.js';
import { memoryStore } from '../store/memory-store.js';

const content = loadContentFromDirectory(
  fileURLToPath(new URL('../../../../content', import.meta.url)),
);
const learnerId = 'learner';
const now = new Date('2026-01-17T12:00:00Z');

function learnerFor(index: Awaited<typeof content>, store: ReturnType<typeof memoryStore>) {
  return createEngine({ content: async () => index, store, fsrsFuzz: false }).learner({
    id: learnerId,
    timeZone: 'UTC',
    now: () => now,
    random: () => 0.5,
  });
}

function attemptFor(
  exercise: IndexedExercise,
  activityId: string,
  attemptNo: number,
  createdAt: Date,
): Attempt {
  return {
    id: `attempt-${attemptNo}`,
    sessionId: null,
    activityId,
    exerciseId: exercise.id,
    exerciseVersion: exercise.contentVersion,
    conceptId: exercise.concept,
    dimension: exercise.dimension,
    mode: 'practice',
    answer: '__wrong__',
    correct: 0,
    credit: 0,
    hintsUsed: 0,
    attemptNo,
    gradedBy: 'deterministic',
    feedback: { message: 'Try again.' },
    mistakeCategory: null,
    durationMs: null,
    createdAt,
  };
}

test('recall exercises are not available to the tutor', async () => {
  const index = await content;
  const exercise = index.exercises.find(
    (candidate) =>
      candidate.role === 'recall' && !(candidate.type === 'numeric' && 'answer_expr' in candidate),
  );
  if (!exercise) throw new Error('Missing recall exercise fixture');
  const store = memoryStore();
  const session = await store.insertSession(learnerId, sessionRow(now));
  const [activity] = await store.insertActivities(learnerId, session.id, [
    activityRow(0, {
      kind: 'practice',
      conceptId: exercise.concept,
      exerciseIds: [exercise.id],
    }),
  ]);
  if (!activity) throw new Error('Practice activity did not insert');
  const learner = learnerFor(index, store);

  expect(
    await learner.tutorContext({ activityId: activity.id, exerciseId: exercise.id }),
  ).toMatchObject({
    status: 403,
    body: { error: 'Review recall exercises are not available to the tutor.' },
  });
});

test('tutor context hides solutions until a final answer', async () => {
  const index = await content;
  const exercise = index.exercises.find(
    (candidate) =>
      candidate.role !== 'recall' &&
      candidate.role !== 'diagnostic' &&
      candidate.hints.length > 0 &&
      (candidate.type === 'explain'
        ? (candidate.solution ?? candidate.exemplar).trim()
        : candidate.solution?.trim()) &&
      !(candidate.type === 'numeric' && 'answer_expr' in candidate),
  );
  if (!exercise) throw new Error('Missing hinted exercise fixture');

  const store = memoryStore();
  const session = await store.insertSession(learnerId, sessionRow(now));
  const [activity] = await store.insertActivities(learnerId, session.id, [
    activityRow(0, {
      kind: 'practice',
      conceptId: exercise.concept,
      exerciseIds: [exercise.id],
    }),
  ]);
  if (!activity) throw new Error('Practice activity did not insert');
  const learner = learnerFor(index, store);

  const unanswered = await learner.tutorContext({
    activityId: activity.id,
    exerciseId: exercise.id,
  });
  expect(unanswered.status).toBe(200);
  const nudge = unanswered.body as TutorTurn;
  expect(nudge.level).toBe('nudge');
  expect(nudge.prompt.solution).toBe('');
  expect(nudge.prompt.authoredHints).toEqual(exercise.hints);

  await store.insertAttempt(
    learnerId,
    attemptFor(exercise, activity.id, 1, new Date(now.getTime() + 1_000)),
  );
  await store.insertAttempt(learnerId, attemptFor(exercise, activity.id, 2, now));

  const answered = await learner.tutorContext({
    activityId: activity.id,
    exerciseId: exercise.id,
  });
  expect(answered.status).toBe(200);
  const workedStep = answered.body as TutorTurn;
  expect(workedStep.level).toBe('worked_step');
  expect(workedStep.prompt.solution).not.toBe('');
  expect(workedStep.prompt.learnerAnswer).not.toBe('');
  expect(workedStep.prompt.authoredHints).toEqual([]);
});
