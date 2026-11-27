import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { loadContentFromDirectory } from '../course/load.js';
import { memoryStore } from '../store/memory-store.js';
import {
  answerPlacement,
  getPlacementRun,
  placementNext,
  preparePlacementAnswer,
  startPlacement,
} from './diagnostic-commands.js';

const content = loadContentFromDirectory(
  fileURLToPath(new URL('../../../../tests/fixtures/content', import.meta.url)),
);

test('placement reuses the active run and rolls back a locked answer with its evidence', async () => {
  const store = memoryStore();
  const userId = 'learner';
  const command = {
    userId,
    timeZone: 'UTC',
    now: () => new Date('2026-01-17T12:00:00Z'),
    newId: () => 'diagnostic-attempt',
    enableFsrsFuzz: false,
  };
  const loadContent = () => content;
  const { id } = await startPlacement(store, command, 'fixture-course', loadContent);
  if (!id) throw new Error('Placement did not start');
  expect(await startPlacement(store, command, 'fixture-course', loadContent)).toEqual({
    kind: 'existing',
    id,
  });
  const run = await getPlacementRun(store, userId, id);
  if (!run) throw new Error('Missing diagnostic run');
  const next = await placementNext(store, userId, run, await content);
  if (next.complete) throw new Error('Missing placement question');
  const answer = { exerciseId: next.exercise.id, dontKnow: true } as const;
  await expect(
    store.transaction(async (tx) => {
      const prepared = await preparePlacementAnswer(tx, userId, id, answer, loadContent);
      if (prepared.kind !== 'ready') throw new Error('Question changed');
      await answerPlacement(tx, command, prepared, {
        status: 'graded',
        correct: 0,
        credit: 0,
        feedback: '',
        graded_by: 'self',
      });
      expect(await tx.listAttempts(userId, {})).toMatchObject([
        { id: 'diagnostic-attempt', mode: 'diagnostic' },
      ]);
      expect(await tx.listTopicSpeedEvidence(userId)).toEqual([]);
      expect(await getPlacementRun(tx, userId, id)).toMatchObject({
        state: { answers: [{ exerciseId: next.exercise.id, attemptId: 'diagnostic-attempt' }] },
      });
      throw new Error('rollback');
    }),
  ).rejects.toThrow('rollback');
  expect(await store.listAttempts(userId, {})).toEqual([]);
  expect(await getPlacementRun(store, userId, id)).toEqual(run);
});
