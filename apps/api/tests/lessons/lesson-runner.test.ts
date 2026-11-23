import { expect, test } from 'vitest';
import { type Exercise, ExerciseSchema } from '../../src/content/schemas.js';
import {
  deriveLessonState,
  type LessonProblemRow,
  selectNextProblem,
  xpForPassedPoint,
} from '../../src/learning/lesson-runner.js';

const point = (id: string, problems: string[]) => ({
  id,
  title: id,
  explain: 'Explain',
  worked: 'Worked',
  problems: [`${id}-basics`, ...problems],
});
const lesson = { knowledge_points: [point('kp', ['a', 'b', 'c', 'd', 'e'])] };

function row(
  position: number,
  correct: number | null,
  kpId = 'kp',
  round = 1,
  assisted = false,
): LessonProblemRow {
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
    assisted,
  };
}

function numericExercise(id: string, difficulty: number, template = false) {
  return ExerciseSchema.parse({
    id,
    dimension: 'math',
    type: 'numeric',
    role: 'practice',
    difficulty,
    est_minutes: 1,
    prompt: template ? 'Template {{=x}}' : 'Fixed',
    hints: [],
    solution: 'Solution',
    ...(template ? { answer_expr: 'x', params: { x: { min: 1, max: 5 } } } : { answer: 1 }),
    tolerance: { abs: 0.001 },
  });
}

function selectionRow(
  exerciseId: string,
  position: number,
  correct: number | null = null,
  seed: number | null = null,
) {
  return { exerciseId, position, correct, seed, servedAt: new Date(position * 1000) };
}

function derive(
  lesson: { knowledge_points?: readonly ReturnType<typeof point>[] },
  problems: readonly LessonProblemRow[],
  attempt = 1,
) {
  const exercises = new Map(
    problems.map((problem) => [
      problem.exerciseId,
      {
        role: problem.exerciseId.endsWith('-basics') ? ('basics' as const) : ('practice' as const),
      },
    ]),
  );
  return deriveLessonState(lesson, problems, exercises, undefined, attempt);
}

test('basics-inclusive streaks match the reference for every right/wrong sequence of lengths 1–6', () => {
  function reference(sequence: number[]) {
    let streak = 0;
    let answered = 0;
    let misses = 0;
    for (const correct of sequence) {
      answered += 1;
      streak = correct === 1 ? streak + 1 : 0;
      if (streak === 2) return { status: 'passed', answered, streak: 2 };
      if (correct < 1) misses += 1;
    }
    return {
      status: 'active',
      answered,
      streak,
      ...(misses >= 3 ? { halted: true } : {}),
    };
  }

  for (let length = 1; length <= 6; length += 1) {
    for (let bits = 0; bits < 2 ** length; bits += 1) {
      const sequence = Array.from({ length }, (_, index) => ((bits & (1 << index)) === 0 ? 0 : 1));
      const state = derive(
        lesson,
        sequence.map((correct, index) => row(index + 1, correct)),
      );
      const { halted, ...pointExpectation } = reference(sequence);
      expect(state.points[0]).toMatchObject(pointExpectation);
      expect(state.points[0]?.status).toBe(pointExpectation.status);
      expect(state.status).toBe(pointExpectation.status === 'passed' ? 'quiz' : 'in_progress');
      expect(Boolean(state.halted)).toBe(halted ?? false);
    }
  }
});

test('basics answers count toward the streak and can finish the step', () => {
  const wrongBasics = derive(lesson, [row(1, 0), row(2, 1), row(3, 1)]);
  expect(wrongBasics.points[0]).toMatchObject({
    status: 'passed',
    answered: 3,
    streak: 2,
  });

  const correctBasics = derive(lesson, [row(1, 1), row(2, 1)]);
  expect(correctBasics.points[0]).toMatchObject({
    status: 'passed',
    answered: 2,
    streak: 2,
  });
});

test('correct answers advance the streak whether or not the tutor helped', () => {
  const assisted = row(2, 1, 'kp', 1, true);
  expect(derive(lesson, [row(1, 1), assisted]).points[0]).toMatchObject({
    status: 'passed',
    answered: 2,
    streak: 2,
  });
  expect(derive(lesson, [row(1, 1), assisted, row(3, 1)]).points[0]).toMatchObject({
    status: 'passed',
    answered: 2,
    streak: 2,
  });
  expect(derive(lesson, [row(1, 1), row(2, 1)]).points[0]).toMatchObject({
    status: 'passed',
    answered: 2,
    streak: 2,
  });
  const helpedSequence = [
    row(1, 1),
    row(2, 1, 'kp', 1, true),
    row(3, 1, 'kp', 1, true),
    row(4, 1, 'kp', 1, true),
  ];
  expect(derive(lesson, helpedSequence).points[0]).toMatchObject({
    status: 'passed',
    answered: 2,
    streak: 2,
  });
  expect(derive(lesson, [...helpedSequence, row(5, 1)]).points[0]).toMatchObject({
    status: 'passed',
    streak: 2,
  });
  expect(
    derive(lesson, [row(1, 1, 'kp', 1, true), row(2, 1, 'kp', 1, true)]).points[0],
  ).toMatchObject({ status: 'passed', streak: 2 });
  expect(derive(lesson, [row(1, 1, 'kp', 1, true), row(2, 0), row(3, 1)]).points[0]).toMatchObject({
    status: 'active',
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
  expect(state.points[0]).toMatchObject({ status: 'active', answered: 2, streak: 0 });
});

test('the third miss halts an active step', () => {
  const state = derive(lesson, [row(1, 0), row(2, 0), row(3, 0)]);
  expect(state).toMatchObject({
    status: 'in_progress',
    halted: { pointId: 'kp', index: 0 },
    points: [{ status: 'active', round: 1, answered: 3, streak: 0 }],
  });
});

test('three misses followed by two correct answers pass without a halt', () => {
  const state = derive(lesson, [row(1, 0), row(2, 0), row(3, 0), row(4, 1), row(5, 1)]);
  expect(state).toMatchObject({
    status: 'quiz',
    points: [{ status: 'passed', answered: 5, streak: 2 }],
  });
  expect(state.halted).toBeUndefined();
});

test('one miss followed by two correct answers passes without a halt', () => {
  const state = derive(lesson, [row(1, 0), row(2, 1), row(3, 1)]);
  expect(state).toMatchObject({
    status: 'quiz',
    points: [{ status: 'passed', answered: 3, streak: 2 }],
  });
  expect(state.halted).toBeUndefined();
});

test('a new attempt ignores all prior-attempt problem rows', () => {
  const state = derive(lesson, [row(1, 1, 'kp', 1), row(2, 1, 'kp', 1), row(1, 0, 'kp', 2)], 2);
  expect(state).toMatchObject({
    status: 'in_progress',
    points: [{ status: 'active', round: 2, answered: 1, streak: 0 }],
  });
  expect(state.halted).toBeUndefined();
});

test('practice-only and recall misses never halt a lesson step', () => {
  const practiceRows = [row(1, 0), row(2, 0), row(3, 0)].map((problem) => ({
    ...problem,
    practiceOnly: true,
  }));
  expect(derive(lesson, practiceRows).halted).toBeUndefined();

  const recallRows = [row(1, 0), row(2, 0), row(3, 0)];
  const recallExercises = new Map(
    recallRows.map((problem) => [problem.exerciseId, { role: 'recall' as const }]),
  );
  expect(deriveLessonState(lesson, recallRows, recallExercises).halted).toBeUndefined();
});

test('last answered uses answer time, then authored point order, round and position', () => {
  const tiedAt = new Date('2026-01-01T12:00:00.000Z');
  const tiedRow = (knowledgePointId: string, round: number, position: number) => ({
    ...row(position, 1, knowledgePointId, round),
    servedAt: tiedAt,
    answeredAt: tiedAt,
  });
  const state = derive(
    { knowledge_points: [point('first', ['a']), point('second', ['b'])] },
    [
      tiedRow('first', 9, 99),
      tiedRow('second', 1, 1),
      tiedRow('second', 2, 1),
      tiedRow('second', 2, 2),
    ],
    2,
  );
  expect(state.lastAnswered).toMatchObject({
    knowledgePointId: 'second',
    round: 2,
    position: 2,
  });
});

test('problem selection keeps authored order for equal difficulty and continues serving templates', () => {
  const fixed = (id: string) => numericExercise(id, 1);
  const template = (id: string) => numericExercise(id, 1, true);
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
  const exercises = new Map<string, Exercise>([
    ['kp-basics', basics],
    ['fixed-a', fixed('fixed-a')],
    ['template-a', template('template-a')],
    ['fixed-b', fixed('fixed-b')],
    ['template-b', template('template-b')],
  ]);
  const kp = point('kp', ['fixed-a', 'template-a', 'fixed-b', 'template-b']);
  const served: Array<ReturnType<typeof selectionRow>> = [];
  const take = (seed: number) => {
    const selected = selectNextProblem(kp, exercises, served, seed);
    if (selected) served.push({ ...selected, correct: null, servedAt: new Date(seed * 1000) });
    return selected;
  };
  expect(take(100)).toEqual({ exerciseId: 'kp-basics', seed: null, position: 1 });
  expect(take(101)).toEqual({ exerciseId: 'fixed-a', seed: null, position: 2 });
  expect(take(102)).toEqual({ exerciseId: 'template-a', seed: 102, position: 3 });
  expect(take(103)).toEqual({ exerciseId: 'fixed-b', seed: null, position: 4 });
  expect(take(104)).toEqual({ exerciseId: 'template-b', seed: 104, position: 5 });
  expect(take(105)).toEqual({ exerciseId: 'template-a', seed: 105, position: 6 });
  expect(take(106)).toEqual({ exerciseId: 'template-b', seed: 106, position: 7 });
  expect(
    new Set(served.filter((problem) => problem.seed !== null).map((item) => item.seed)).size,
  ).toBe(4);
  expect(served.filter((problem) => problem.seed === null).map((item) => item.exerciseId)).toEqual([
    'kp-basics',
    'fixed-a',
    'fixed-b',
  ]);

  const retryProblems: Array<ReturnType<typeof selectionRow>> = [];
  const usedSeeds = new Set([101, 103, 104]);
  const retryTake = (seed: number) => {
    const selected = selectNextProblem(kp, exercises, retryProblems, seed, usedSeeds);
    if (selected) {
      retryProblems.push({ ...selected, correct: null, servedAt: new Date(seed * 1000) });
    }
    return selected;
  };
  expect(retryTake(101)).toEqual({ exerciseId: 'kp-basics', seed: null, position: 1 });
  expect(retryTake(101)).toEqual({ exerciseId: 'fixed-a', seed: null, position: 2 });
  expect(retryTake(101)).toEqual({ exerciseId: 'template-a', seed: 102, position: 3 });

  const fixedOnly = point('kp', ['fixed-a', 'fixed-b']);
  const fixedOnlyRows: Array<ReturnType<typeof selectionRow>> = [];
  for (const seed of [200, 201, 202]) {
    const selected = selectNextProblem(fixedOnly, exercises, fixedOnlyRows, seed);
    if (selected) {
      fixedOnlyRows.push({ ...selected, correct: null, servedAt: new Date(seed * 1000) });
    }
  }
  expect(fixedOnlyRows.map((problem) => problem.exerciseId)).toEqual([
    'kp-basics',
    'fixed-a',
    'fixed-b',
  ]);
  expect(selectNextProblem(fixedOnly, exercises, fixedOnlyRows, 203)).toMatchObject({
    exerciseId: 'fixed-a',
    position: 4,
  });
});

test('step practice can serve a lesson-only exercise', () => {
  const lessonOnly = ExerciseSchema.parse({
    id: 'lesson-only',
    dimension: 'math',
    type: 'numeric',
    role: 'practice',
    lesson_only: true,
    difficulty: 2,
    est_minutes: 1,
    prompt: 'Why does the worked example use this value?',
    hints: [],
    solution: 'It is used in the worked example.',
    answer: 1,
    tolerance: { abs: 0.001 },
  });

  expect(
    selectNextProblem(
      { problems: [lessonOnly.id] },
      new Map([[lessonOnly.id, lessonOnly]]),
      [],
      10,
    ),
  ).toEqual({ exerciseId: lessonOnly.id, seed: null, position: 1 });
});

test('basics is served first and exhausted fixed pools reuse a previously served item', () => {
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
    selectionRow('kp-basics', 1),
    ...['a', 'b', 'c', 'd'].map((exerciseId, index) => ({
      exerciseId,
      seed: null,
      position: index + 2,
      correct: null,
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
      [...fourNonBasics, { exerciseId: 'e', seed: null, position: 6, correct: null }],
      11,
    ),
  ).toMatchObject({ exerciseId: 'a', position: 7 });
});

test('an exhausted basics-only pool still serves another question', () => {
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
  const selected = selectNextProblem(
    point('kp', [basics.id]),
    new Map([[basics.id, basics]]),
    [{ ...selectionRow(basics.id, 1), correct: 1 }],
    10,
  );
  expect(selected).toEqual({ exerciseId: basics.id, seed: null, position: 2 });
});

test('a correct answer at difficulty one or two moves to the next higher level', () => {
  const exercises = new Map<string, Exercise>([
    ['d1', numericExercise('d1', 1)],
    ['d2', numericExercise('d2', 2)],
    ['d3', numericExercise('d3', 3)],
  ]);
  const kp = point('kp', ['d1', 'd2', 'd3']);

  expect(selectNextProblem(kp, exercises, [selectionRow('d1', 1, 1)], 10)?.exerciseId).toBe('d2');
  expect(selectNextProblem(kp, exercises, [selectionRow('d2', 1, 1)], 10)?.exerciseId).toBe('d3');
});

test('an unstarted knowledge point begins with its lowest difficulty', () => {
  const exercises = new Map<string, Exercise>([
    ['d1', numericExercise('d1', 1)],
    ['d2', numericExercise('d2', 2)],
    ['d3', numericExercise('d3', 3)],
  ]);

  expect(selectNextProblem(point('kp', ['d3', 'd2', 'd1']), exercises, [], 10)?.exerciseId).toBe(
    'd1',
  );
});

test('a wrong answer moves down, or repeats the same difficulty when there is no lower level', () => {
  const exercises = new Map<string, Exercise>([
    ['d1', numericExercise('d1', 1)],
    ['d1-repeat', numericExercise('d1-repeat', 1)],
    ['d2', numericExercise('d2', 2)],
    ['d3', numericExercise('d3', 3)],
  ]);

  expect(
    selectNextProblem(
      point('kp', ['d1', 'd1-repeat', 'd2', 'd3']),
      exercises,
      [selectionRow('d2', 1, 0)],
      10,
    )?.exerciseId,
  ).toBe('d1');
  expect(
    selectNextProblem(
      point('kp', ['d1', 'd1-repeat', 'd2', 'd3']),
      exercises,
      [selectionRow('d1', 1, 0)],
      10,
    )?.exerciseId,
  ).toBe('d1-repeat');
});

test('a correct answer at difficulty three repeats that level or falls back to the highest lower level', () => {
  const exercises = new Map<string, Exercise>([
    ['d1', numericExercise('d1', 1)],
    ['d2', numericExercise('d2', 2)],
    ['d3', numericExercise('d3', 3)],
    ['d3-repeat', numericExercise('d3-repeat', 3)],
  ]);

  expect(
    selectNextProblem(
      point('kp', ['d3', 'd3-repeat', 'd2']),
      exercises,
      [selectionRow('d3', 1, 1)],
      10,
    )?.exerciseId,
  ).toBe('d3-repeat');
  expect(
    selectNextProblem(point('kp', ['d3', 'd1', 'd2']), exercises, [selectionRow('d3', 1, 1)], 10)
      ?.exerciseId,
  ).toBe('d2');
});

test('difficulty ties keep authored order', () => {
  const exercises = new Map<string, Exercise>([
    ['d1', numericExercise('d1', 1)],
    ['d2-later', numericExercise('d2-later', 2)],
    ['d2-earlier', numericExercise('d2-earlier', 2)],
  ]);

  expect(
    selectNextProblem(
      point('kp', ['d1', 'd2-later', 'd2-earlier']),
      exercises,
      [selectionRow('d1', 1, 1)],
      10,
    )?.exerciseId,
  ).toBe('d2-later');
});

test('an unserved basics problem takes priority over authored non-basics problems', () => {
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
  const exercises = new Map<string, Exercise>([
    ['non-basics', numericExercise('non-basics', 1)],
    ['kp-basics', basics],
  ]);

  expect(
    selectNextProblem({ problems: ['non-basics', 'kp-basics'] }, exercises, [], 10),
  ).toMatchObject({ exerciseId: 'kp-basics', seed: null, position: 1 });
});

test('template fallback follows difficulty and favors the least-served tied template', () => {
  const exercises = new Map<string, Exercise>([
    ['template-d1', numericExercise('template-d1', 1, true)],
    ['template-d2-first', numericExercise('template-d2-first', 2, true)],
    ['template-d2-second', numericExercise('template-d2-second', 2, true)],
  ]);
  const roundProblems = [
    selectionRow('template-d2-first', 1, null, 101),
    selectionRow('template-d2-first', 2, null, 102),
    selectionRow('template-d2-second', 3, null, 103),
    selectionRow('template-d1', 4, 1, 104),
  ];

  expect(
    selectNextProblem(
      point('kp', ['template-d1', 'template-d2-first', 'template-d2-second']),
      exercises,
      roundProblems,
      100,
      new Set([100]),
    ),
  ).toEqual({ exerciseId: 'template-d2-second', seed: 105, position: 5 });
});

test('legacy rows halt after three misses in the current attempt', () => {
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
  ];
  const state = derive(multiPointLesson, rows);
  expect(state).toMatchObject({
    status: 'in_progress',
    currentPointId: 'second',
    points: [
      { status: 'passed', round: 1 },
      { status: 'active', round: 1, answered: 3 },
    ],
    halted: { pointId: 'second', index: 1 },
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
    status: 'quiz',
    points: [],
  });
});

test('passed-point XP follows the specified problems-used table', () => {
  expect([2, 3, 4, 5, 8].map(xpForPassedPoint)).toEqual([10, 9, 8, 7, 7]);
  expect(xpForPassedPoint(1)).toBe(0);
});

test('practice-only answers do not affect step progress or run status', () => {
  const practice = { ...row(2, 0, 'kp'), practiceOnly: true };
  expect(derive(lesson, [row(1, 1), practice])).toMatchObject({
    status: 'in_progress',
    points: [{ status: 'active', answered: 1, streak: 1 }],
  });
});

test('all steps enter quiz until quiz_passed_at is set', () => {
  const rows = [row(1, 1), row(2, 1)];
  const exercises = new Map(rows.map((item) => [item.exerciseId, { role: 'practice' as const }]));
  expect(deriveLessonState(lesson, rows, exercises).status).toBe('quiz');
  expect(deriveLessonState(lesson, rows, exercises, new Date()).status).toBe('completed');
});
