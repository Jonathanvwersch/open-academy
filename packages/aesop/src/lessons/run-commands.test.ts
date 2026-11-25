import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { loadContentFromDirectory } from '../course/load.js';
import { applyMastery } from '../memory/mastery-service.js';
import { memoryStore } from '../store/memory-store.js';
import { answerLessonProblem, type LessonCommand, startLessonRun } from './run-commands.js';
import { readLessonState } from './run-state.js';

const content = loadContentFromDirectory(
  fileURLToPath(new URL('../../../../tests/fixtures/content', import.meta.url)),
);

async function fixture() {
  const store = memoryStore();
  const index = await content;
  const conceptId = 'supervised-learning';
  const lesson = index.lessonsByConcept.get(conceptId);
  if (!lesson) throw new Error('Missing lesson fixture');
  const command: LessonCommand = {
    userId: 'learner',
    conceptId,
    timeZone: 'UTC',
    resolved: { index, lesson },
  };
  let now = new Date('2026-01-01T15:00:00Z');
  let id = 0;
  const runtime = {
    now: () => now,
    random: () => 0.5,
    newId: () => `test-${++id}`,
    enableFsrsFuzz: false,
  };
  return {
    store,
    command,
    runtime,
    setNow: (value: Date) => {
      now = value;
    },
  };
}

test('start resumes the same pending problem, then recovery replaces it without awarding credit', async () => {
  const { store, command, runtime } = await fixture();
  const result = await startLessonRun(store, runtime, command);
  if (result.kind !== 'ready') throw new Error('Lesson did not start');
  const { userId, resolved } = command;
  const { run } = result;
  const [problem] = await store.listLessonProblems(userId, run.id);
  expect(problem).toBeDefined();
  await startLessonRun(store, runtime, command);
  expect(await store.listLessonProblems(userId, run.id)).toEqual([problem]);
  await store.patchLessonProblem(userId, run.id, problem.id, { exerciseId: 'removed-exercise' });
  const snapshot = await readLessonState(
    store,
    userId,
    run,
    resolved.lesson,
    resolved.index,
    runtime,
  );
  expect(snapshot?.derived.pending?.id).not.toBe(problem.id);
  expect(snapshot?.derived.pending?.exerciseId).toBe(problem.exerciseId);
  expect(snapshot?.xpEarned).toBe(0);
  expect(await store.listAttempts(userId, {})).toEqual([]);
});

test('three misses halt the lesson and retry starts a fresh round on the next local day', async () => {
  const { store, command, runtime, setNow } = await fixture();
  const { userId, conceptId, resolved } = command;
  for (let miss = 0; miss < 3; miss++) {
    const result = await startLessonRun(store, runtime, command);
    if (result.kind !== 'ready') throw new Error('Lesson did not start');
    const snapshot = await readLessonState(
      store,
      userId,
      result.run,
      resolved.lesson,
      resolved.index,
      runtime,
    );
    const problem = snapshot?.derived.pending;
    if (!problem) throw new Error('No pending problem');
    const input = { ...command, problemId: problem.id, answer: 'wrong' };
    const host = {
      applyMastery,
      grade: async () =>
        ({
          status: 'graded',
          correct: 0,
          credit: 0,
          feedback: 'Try again',
          graded_by: 'deterministic',
        }) as const,
      hasTutorReply: async () => false,
      placementGrantStates: async () => new Map(),
    };
    expect((await answerLessonProblem(store, runtime, input, host)).kind).toBe('answered');
    expect((await answerLessonProblem(store, runtime, input, host)).kind).toBe('conflict');
  }
  expect(await store.getLessonRun(userId, { conceptId })).toMatchObject({
    status: 'needs_retry',
    attempt: 1,
    haltCount: 1,
    retryAfter: new Date('2026-01-02T00:00:00Z'),
  });
  expect(await store.listAttempts(userId, {})).toHaveLength(3);
  setNow(new Date('2026-01-02T00:00:00Z'));
  expect(await startLessonRun(store, runtime, command)).toMatchObject({
    kind: 'ready',
    run: { attempt: 2, status: 'in_progress' },
  });
});
