import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { loadContentFromDirectory } from '../course/load.js';
import { newReviewCard } from '../memory/fsrs.js';
import { initialMastery } from '../memory/types.js';
import { memoryStore } from '../store/memory-store.js';
import { applyPlacementGrantOutcome } from './grant-commands.js';

test('placement withdrawal rolls back edits made before a mastery write fails', async () => {
  const content = await loadContentFromDirectory(
    fileURLToPath(new URL('../../../../tests/fixtures/content', import.meta.url)),
  );
  const exercise = content.exercisesByConcept.get('vectors')?.[0];
  if (!exercise) throw new Error('Missing vectors exercise');
  const store = memoryStore();
  const userId = 'learner';
  const now = new Date('2026-01-17T12:00:00Z');
  const attemptId = 'failed-review';
  const conceptId = exercise.concept;
  const dimension = exercise.dimension;
  const run = await store.insertDiagnosticRun(userId, {
    courseId: 'maths',
    kind: 'placement',
    status: 'completed',
    state: { courseId: 'maths' },
    startedAt: now,
    completedAt: now,
    summary: {},
  });
  await store.insertPlacementGrantsOnce(userId, [
    {
      runId: run.id,
      conceptId,
      origin: 'direct',
      state: 'conditional',
      reason: 'slow',
      evidenceAttemptIds: [],
      createdAt: now,
      updatedAt: now,
      confirmedAt: null,
      confirmedByAttemptId: null,
      withdrawnAt: null,
      withdrawnByAttemptId: null,
    },
  ]);
  await store.insertAttempt(userId, {
    id: attemptId,
    conceptId,
    dimension,
    activityId: null,
    sessionId: null,
    exerciseId: exercise.id,
    exerciseVersion: exercise.contentVersion,
    mode: 'review',
    answer: 'wrong',
    correct: 0,
    credit: 0,
    hintsUsed: 0,
    attemptNo: 1,
    gradedBy: 'deterministic',
    feedback: {},
    mistakeCategory: null,
    durationMs: null,
    createdAt: now,
  });
  const mastery = {
    ...initialMastery(conceptId, dimension),
    state: 'independent' as const,
    provisional: true,
  };
  await store.saveMastery(userId, mastery);
  const card = await store.insertReviewCard(userId, {
    conceptId,
    dimension,
    fsrs: newReviewCard(now),
    dueAt: now,
    lastReviewAt: null,
    reps: 0,
    lapses: 0,
  });
  const transaction = store.transaction.bind(store);
  store.transaction = (callback) =>
    transaction((tx) => {
      tx.saveMastery = async () => {
        expect(await tx.listPlacementGrants(userId)).toMatchObject([{ state: 'withdrawn' }]);
        throw new Error('interrupted withdrawal');
      };
      return callback(tx);
    });
  const input = {
    store,
    content,
    userId,
    attemptId,
    exerciseId: exercise.id,
    mode: 'review',
    correct: 0,
    hintsUsed: 0,
    attemptNo: 1,
    gradedBy: 'deterministic',
    now,
  };
  await expect(applyPlacementGrantOutcome(input)).rejects.toThrow('interrupted withdrawal');
  expect(await store.listPlacementGrants(userId)).toMatchObject([{ state: 'conditional' }]);
  expect(await store.listMastery(userId)).toEqual([mastery]);
  expect(await store.getReviewCard(userId, conceptId, dimension)).toEqual(card);

  store.transaction = transaction;
  expect(await applyPlacementGrantOutcome(input)).toMatchObject({ withdrawn: [conceptId] });
  expect(await store.listPlacementGrants(userId)).toMatchObject([{ state: 'withdrawn' }]);
  expect(await store.getReviewCard(userId, conceptId, dimension)).toMatchObject({
    suspendedAt: now,
  });
});
