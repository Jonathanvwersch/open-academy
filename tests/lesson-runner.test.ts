import { expect, test } from 'vitest';
import { ExerciseSchema } from '../src/server/content/schemas.js';
import {
  deriveLessonState,
  type LessonProblemRow,
  selectNextProblem,
  xpForPassedPoint,
} from '../src/server/learning/lesson-runner.js';

const point = (id: string, problems: string[]) => ({
  id,
  title: id,
  explain: 'Explain',
  worked: 'Worked',
  problems: [`${id}-basics`, ...problems],
});
const lesson = { knowledge_points: [point('kp', ['a', 'b', 'c', 'd', 'e'])] };

function row(position: number, correct: number | null, kpId = 'kp', round = 1): LessonProblemRow {
  const servedAt = new Date(position * 1000 + round * 100_000);
  return {
    knowledgePointId: kpId,
    round,
    position,
    exerciseId: position === 1 ? `${kpId}-basics` : `problem-${kpId}-${round}-${position}`,
    seed: null,
    servedAt,
    answeredAt: correct === null ? null : servedAt,
    correct,
  };
}

function derive(
  lesson: { knowledge_points?: readonly ReturnType<typeof point>[] },
  problems: readonly LessonProblemRow[],
) {
  const exercises = new Map(
    problems.map((problem) => [
      problem.exerciseId,
      {
        role: problem.exerciseId.endsWith('-basics') ? ('basics' as const) : ('practice' as const),
      },
    ]),
  );
  return deriveLessonState(lesson, problems, exercises);
}

test('matches an independent reference for every right/wrong sequence of lengths 1–6', () => {
  function reference(sequence: number[]) {
    let streak = 0;
    let answered = 0;
    for (const correct of sequence.slice(1)) {
      answered += 1;
      streak = correct === 1 ? streak + 1 : 0;
      if (streak === 2) return { status: 'passed', answered, streak: 2 };
      if (answered === 4 && correct !== 1) {
        return { status: 'failed', answered, streak };
      }
    }
    if (answered === 5) return { status: 'failed', answered, streak };
    return { status: 'active', answered, streak };
  }

  for (let length = 1; length <= 6; length += 1) {
    for (let bits = 0; bits < 2 ** length; bits += 1) {
      const sequence = Array.from({ length }, (_, index) => ((bits & (1 << index)) === 0 ? 0 : 1));
      const state = derive(
        lesson,
        sequence.map((correct, index) => row(index + 1, correct)),
      );
      expect(state.points[0]).toMatchObject(reference(sequence));
      expect(state.points[0]?.status).toBe(reference(sequence).status);
      expect(state.status).toBe(
        reference(sequence).status === 'failed'
          ? 'needs_retry'
          : reference(sequence).status === 'passed'
            ? 'completed'
            : 'in_progress',
      );
    }
  }
});

test('basics answers do not increment, reset, or pass the streak', () => {
  const wrongBasics = derive(lesson, [row(1, 0), row(2, 1), row(3, 1)]);
  expect(wrongBasics.points[0]).toMatchObject({
    status: 'passed',
    answered: 2,
    streak: 2,
  });

  const correctBasics = derive(lesson, [row(1, 1), row(2, 1)]);
  expect(correctBasics.points[0]).toMatchObject({
    status: 'active',
    answered: 1,
    streak: 1,
  });
});

test('lesson state excludes basics by role rather than by problem position', () => {
  const nonBasicsFirst = {
    knowledge_points: [{ ...point('kp', ['a', 'b']), problems: ['first-practice', 'a', 'b'] }],
  };
  const firstPractice = { ...row(1, 0), exerciseId: 'first-practice' };
  expect(derive(nonBasicsFirst, [firstPractice]).points[0]).toMatchObject({
    status: 'active',
    answered: 1,
    streak: 0,
  });
});

test('only a score of exactly one contributes to the streak', () => {
  const state = derive(lesson, [row(1, 1), row(2, 0.5)]);
  expect(state.points[0]).toMatchObject({ status: 'active', answered: 1, streak: 0 });
});

test('last answered uses answer time, then authored point order, round and position', () => {
  const tiedAt = new Date('2026-01-01T12:00:00.000Z');
  const tiedRow = (knowledgePointId: string, round: number, position: number) => ({
    ...row(position, 1, knowledgePointId, round),
    servedAt: tiedAt,
    answeredAt: tiedAt,
  });
  const state = derive({ knowledge_points: [point('first', ['a']), point('second', ['b'])] }, [
    tiedRow('first', 9, 99),
    tiedRow('second', 1, 1),
    tiedRow('second', 2, 1),
    tiedRow('second', 2, 2),
  ]);
  expect(state.lastAnswered).toMatchObject({
    knowledgePointId: 'second',
    round: 2,
    position: 2,
  });
});

test('problem selection follows authored order, cycles templates with fresh seeds, and caps at five', () => {
  const fixed = (id: string) =>
    ExerciseSchema.parse({
      id,
      dimension: 'math',
      type: 'numeric',
      role: 'practice',
      difficulty: 1,
      est_minutes: 1,
      prompt: 'Fixed',
      hints: [],
      solution: 'Fixed solution',
      answer: 1,
      tolerance: { abs: 0.001 },
    });
  const template = (id: string) =>
    ExerciseSchema.parse({
      id,
      dimension: 'math',
      type: 'numeric',
      role: 'practice',
      difficulty: 1,
      est_minutes: 1,
      prompt: 'Template {{=x}}',
      hints: [],
      solution: 'Template solution',
      answer_expr: 'x',
      params: { x: { min: 1, max: 5 } },
      tolerance: { abs: 0.001 },
    });
  const basics = ExerciseSchema.parse({
    id: 'kp-basics',
    dimension: 'conceptual',
    type: 'mc',
    role: 'basics',
    difficulty: 1,
    est_minutes: 1,
    prompt: 'What is the idea?',
    hints: [],
    solution: 'The idea is defined.',
    options: [
      { id: 'yes', text: 'The idea', correct: true, feedback: 'This matches the definition.' },
      { id: 'no', text: 'Another idea', correct: false, feedback: 'That describes another idea.' },
    ],
  });
  const exercises = new Map([
    ['kp-basics', basics],
    ['fixed-a', fixed('fixed-a')],
    ['template-a', template('template-a')],
    ['fixed-b', fixed('fixed-b')],
    ['template-b', template('template-b')],
  ]);
  const kp = point('kp', ['fixed-a', 'template-a', 'fixed-b', 'template-b']);
  const served: Array<{ exerciseId: string; seed: number | null; position: number }> = [];
  const take = (seed: number) => {
    const selected = selectNextProblem(kp, exercises, served, seed);
    if (selected) served.push(selected);
    return selected;
  };
  expect(take(100)).toEqual({ exerciseId: 'kp-basics', seed: null, position: 1 });
  expect(take(101)).toEqual({ exerciseId: 'fixed-a', seed: null, position: 2 });
  expect(take(102)).toEqual({ exerciseId: 'template-a', seed: 102, position: 3 });
  expect(take(103)).toEqual({ exerciseId: 'fixed-b', seed: null, position: 4 });
  expect(take(104)).toEqual({ exerciseId: 'template-b', seed: 104, position: 5 });
  expect(take(105)).toEqual({ exerciseId: 'template-a', seed: 105, position: 6 });
  expect(take(106)).toBeUndefined();
  expect(
    new Set(served.filter((problem) => problem.seed !== null).map((item) => item.seed)).size,
  ).toBe(3);
  expect(served.filter((problem) => problem.seed === null).map((item) => item.exerciseId)).toEqual([
    'kp-basics',
    'fixed-a',
    'fixed-b',
  ]);

  const retryProblems: Array<{ exerciseId: string; seed: number | null; position: number }> = [];
  const usedSeeds = new Set([101, 103, 104]);
  const retryTake = (seed: number) => {
    const selected = selectNextProblem(kp, exercises, retryProblems, seed, usedSeeds);
    if (selected) retryProblems.push(selected);
    return selected;
  };
  expect(retryTake(101)).toEqual({ exerciseId: 'kp-basics', seed: null, position: 1 });
  expect(retryTake(101)).toEqual({ exerciseId: 'fixed-a', seed: null, position: 2 });
  expect(retryTake(101)).toEqual({ exerciseId: 'template-a', seed: 102, position: 3 });

  const fixedOnly = point('kp', ['fixed-a', 'fixed-b']);
  const fixedOnlyRows: Array<{ exerciseId: string; seed: number | null; position: number }> = [];
  for (const seed of [200, 201, 202]) {
    const selected = selectNextProblem(fixedOnly, exercises, fixedOnlyRows, seed);
    if (selected) fixedOnlyRows.push(selected);
  }
  expect(fixedOnlyRows.map((problem) => problem.exerciseId)).toEqual([
    'kp-basics',
    'fixed-a',
    'fixed-b',
  ]);
  expect(selectNextProblem(fixedOnly, exercises, fixedOnlyRows, 203)).toBeUndefined();
});

test('basics does not use one of the five problem slots', () => {
  const basics = ExerciseSchema.parse({
    id: 'kp-basics',
    dimension: 'conceptual',
    type: 'mc',
    role: 'basics',
    difficulty: 1,
    est_minutes: 1,
    prompt: 'What is the idea?',
    hints: [],
    solution: 'The idea is defined.',
    options: [
      { id: 'yes', text: 'The idea', correct: true, feedback: 'This matches the definition.' },
      { id: 'no', text: 'Another idea', correct: false, feedback: 'That describes another idea.' },
    ],
  });
  const fixed = (id: string) =>
    ExerciseSchema.parse({
      id,
      dimension: 'math',
      type: 'numeric',
      role: 'practice',
      difficulty: 1,
      est_minutes: 1,
      prompt: 'Fixed',
      hints: [],
      solution: 'Fixed solution',
      answer: 1,
      tolerance: { abs: 0.001 },
    });
  const exercises = new Map([
    ['kp-basics', basics],
    ...['a', 'b', 'c', 'd', 'e'].map((id) => [id, fixed(id)] as const),
  ]);
  const kp = point('kp', ['a', 'b', 'c', 'd', 'e']);
  const fourNonBasics = [
    { exerciseId: 'kp-basics', seed: null, position: 1 },
    ...['a', 'b', 'c', 'd'].map((exerciseId, index) => ({
      exerciseId,
      seed: null,
      position: index + 2,
    })),
  ];
  expect(selectNextProblem(kp, exercises, fourNonBasics, 10)).toEqual({
    exerciseId: 'e',
    seed: null,
    position: 6,
  });
  expect(
    selectNextProblem(
      kp,
      exercises,
      [...fourNonBasics, { exerciseId: 'e', seed: null, position: 6 }],
      11,
    ),
  ).toBeUndefined();
});

test('retry uses only the latest round and resumes the failed knowledge point', () => {
  const multiPointLesson = {
    knowledge_points: [point('first', ['a', 'b']), point('second', ['c', 'd'])],
  };
  const rows = [
    row(1, 1, 'first'),
    row(2, 1, 'first'),
    row(3, 1, 'first'),
    row(1, 0, 'second'),
    row(2, 0, 'second'),
    row(3, 0, 'second'),
    row(4, 0, 'second'),
    row(5, 0, 'second'),
    row(1, null, 'second', 2),
  ];
  const state = derive(multiPointLesson, rows);
  expect(state).toMatchObject({
    status: 'in_progress',
    currentPointId: 'second',
    points: [
      { status: 'passed', round: 1 },
      { status: 'active', round: 2, answered: 0 },
    ],
    pending: { knowledgePointId: 'second', round: 2, position: 1 },
  });
});

test('stale knowledge-point rows are ignored and a lesson without points is safe', () => {
  const stale = derive({ knowledge_points: [point('current', ['a'])] }, [row(1, 1, 'removed')]);
  expect(stale).toMatchObject({
    status: 'in_progress',
    currentPointId: 'current',
    points: [{ id: 'current', status: 'active', answered: 0 }],
  });
  expect(stale.lastAnswered).toBeUndefined();
  expect(derive({}, [row(1, 1)])).toMatchObject({
    status: 'completed',
    points: [],
  });
});

test('passed-point XP follows the exported hypothesis table', () => {
  expect([2, 3, 4, 5].map(xpForPassedPoint)).toEqual([10, 9, 8, 7]);
  expect(xpForPassedPoint(1)).toBe(0);
});
