import { type Exercise, ExerciseSchema } from '@academy/aesop/course/schemas';
import { instantiateExercise } from '@academy/aesop/course/templates';
import {
  quizQuestionsPerStep,
  scoreLessonQuiz,
  selectQuizItems,
} from '@academy/aesop/lessons/lesson-quiz';
import { expect, test } from 'vitest';
import { loadContent } from '../../src/content/load.js';

function exercise(id: string, difficulty: number, template = false): Exercise {
  return ExerciseSchema.parse({
    id,
    dimension: 'math',
    type: 'numeric',
    role: 'practice',
    difficulty,
    est_minutes: 1,
    prompt: template ? 'Calculate {{=x}}.' : `Calculate ${id}.`,
    hints: [],
    solution: 'Work it out.',
    ...(template ? { answer_expr: 'x', params: { x: { min: 1, max: 9 } } } : { answer: 1 }),
    tolerance: { abs: 0.001 },
  });
}

function point(id: string, exerciseIds: string[]) {
  return { id, title: id, explain: 'Explain', worked: 'Worked', problems: exerciseIds };
}

function makeSteps(count: number, each = 6) {
  const exercises = new Map<string, Exercise>();
  const points = Array.from({ length: count }, (_, pointIndex) => {
    const ids = Array.from({ length: each }, (_, itemIndex) => {
      const id = `p${pointIndex + 1}-e${itemIndex + 1}`;
      exercises.set(id, exercise(id, (itemIndex % 3) + 1));
      return id;
    });
    return point(`p${pointIndex + 1}`, ids);
  });
  return { lesson: { knowledge_points: points }, exercises };
}

function select(
  lesson: ReturnType<typeof makeSteps>['lesson'],
  exercises: ReadonlyMap<string, Exercise>,
  options: Partial<Parameters<typeof selectQuizItems>[0]> = {},
) {
  return selectQuizItems({
    lesson,
    exercises,
    servedProblems: [],
    previousAttemptItems: [],
    usedSeeds: new Set(),
    seed: 1234,
    ...options,
  });
}

test('uses the specified per-step quotas for one through four steps', () => {
  expect([1, 2, 3, 4].map(quizQuestionsPerStep)).toEqual([6, 3, 2, 2]);
  for (let stepCount = 1; stepCount <= 4; stepCount += 1) {
    const { lesson, exercises } = makeSteps(stepCount);
    const items = select(lesson, exercises);
    expect(items).toHaveLength(stepCount * quizQuestionsPerStep(stepCount));
    for (const item of lesson.knowledge_points ?? []) {
      expect(items.filter((selected) => selected.pointId === item.id)).toHaveLength(
        quizQuestionsPerStep(stepCount),
      );
    }
  }
});

test('quiz recovery can use a new instance of a template already in the quiz', () => {
  const template = exercise('template', 1, true);
  const fixed = exercise('fixed', 1);
  const items = select(
    { knowledge_points: [point('step', [fixed.id, template.id])] },
    new Map([
      [fixed.id, fixed],
      [template.id, template],
    ]),
    {
      recoveryItems: [
        { exerciseId: fixed.id, seed: null },
        { exerciseId: template.id, seed: 0 },
      ],
    },
  );
  expect(items.length).toBeGreaterThan(0);
  expect(items.every((item) => item.exerciseId === template.id && item.seed !== null)).toBe(true);
  expect(new Set(items.map((item) => item.seed)).size).toBe(items.length);
});

test('quiz recovery excludes the same generated prompt even when every seed is fresh', () => {
  const template = { ...exercise('template', 1, true), prompt: 'Calculate 1 + 1.' };
  const items = select(
    { knowledge_points: [point('step', [template.id])] },
    new Map([[template.id, template]]),
    { recoveryItems: [{ exerciseId: template.id, seed: 15 }] },
  );
  expect(items).toEqual([]);
});

test('quiz recovery samples again if the first six seeds repeat an existing prompt', () => {
  const template = ExerciseSchema.parse({
    ...exercise('template', 1, true),
    params: { x: { min: 1, max: 2 } },
  });
  const items = select(
    { knowledge_points: [point('step', [template.id])] },
    new Map([[template.id, template]]),
    { seed: 31, recoveryItems: [{ exerciseId: template.id, seed: 0 }] },
  );
  const prompts = new Set(
    items.map((item) => instantiateExercise(template, item.seed ?? 0).exercise.prompt),
  );
  expect(prompts).toEqual(new Set(['Calculate 2.']));
});

test('the selector skips a used seed that it would otherwise generate', () => {
  const template = exercise('template', 1, true);
  const lesson = { knowledge_points: [point('step', [template.id])] };
  const exercises = new Map([[template.id, template]]);
  const blockedSeed = 166292415;
  expect(select(lesson, exercises).map((item) => item.seed)).toContain(blockedSeed);
  expect(
    select(lesson, exercises, { usedSeeds: new Set([blockedSeed]) }).map((item) => item.seed),
  ).not.toContain(blockedSeed);
});

test('spreads two-question steps across lowest and highest difficulty', () => {
  const { lesson, exercises } = makeSteps(3);
  const items = select(lesson, exercises);
  for (const step of lesson.knowledge_points ?? []) {
    expect(items.filter((item) => item.pointId === step.id).map((item) => item.difficulty)).toEqual(
      [1, 3],
    );
  }
});

test('round-robins three-question steps across available difficulties', () => {
  const { lesson, exercises } = makeSteps(2);
  const items = select(lesson, exercises);
  expect(items.filter((item) => item.pointId === 'p1').map((item) => item.difficulty)).toEqual([
    1, 2, 3,
  ]);
});

test('prefers items not served in the run or previous quiz attempt', () => {
  const { lesson, exercises } = makeSteps(2);
  const items = select(lesson, exercises, {
    servedProblems: [{ exerciseId: 'p1-e1', seed: null }],
    previousAttemptItems: [{ exerciseId: 'p1-e2', seed: null }],
  });
  const selected = items.filter((item) => item.pointId === 'p1');
  expect(selected.map((item) => item.exerciseId)).not.toContain('p1-e1');
  expect(selected.map((item) => item.exerciseId)).not.toContain('p1-e2');
});

test('uses fresh deterministic template seeds', () => {
  const template = exercise('template', 1, true);
  const lesson = { knowledge_points: [point('p1', ['template'])] };
  const exercises = new Map([[template.id, template]]);
  const input = {
    lesson,
    exercises,
    servedProblems: [{ exerciseId: 'template', seed: 11 }],
    previousAttemptItems: [{ exerciseId: 'template', seed: 12 }],
    usedSeeds: new Set([11, 12]),
    seed: 99,
  };
  const first = selectQuizItems(input);
  expect(first).toHaveLength(6);
  expect(new Set(first.map((item) => item.seed)).size).toBe(6);
  expect(first.every((item) => item.seed !== null && ![11, 12].includes(item.seed))).toBe(true);
  expect(selectQuizItems(input)).toEqual(first);
});

test('returns the available fixed questions when a step pool is smaller than its quota', () => {
  const lesson = {
    knowledge_points: [point('p1', ['only-one']), point('p2', ['two-a', 'two-b', 'two-c'])],
  };
  const exercises = new Map<string, Exercise>([
    ['only-one', exercise('only-one', 2)],
    ['two-a', exercise('two-a', 1)],
    ['two-b', exercise('two-b', 2)],
    ['two-c', exercise('two-c', 3)],
  ]);
  expect(select(lesson, exercises)).toHaveLength(4);
});

test('lesson-only problems are not included in the lesson quiz', () => {
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
  const quizEligible = exercise('quiz-eligible', 2);
  const lesson = { knowledge_points: [point('p1', [lessonOnly.id, quizEligible.id])] };
  const items = select(
    lesson,
    new Map([
      [lessonOnly.id, lessonOnly],
      [quizEligible.id, quizEligible],
    ]),
  );

  expect(items.map((item) => item.exerciseId)).toEqual([quizEligible.id]);
});

test('recall exercises are not included in lesson quizzes', () => {
  const recall = ExerciseSchema.parse({
    ...exercise('quiz-recall', 2),
    role: 'recall',
    knowledge_point: 'p1',
  });
  const quizEligible = exercise('quiz-eligible', 2);
  const lesson = { knowledge_points: [point('p1', [recall.id, quizEligible.id])] };
  const items = select(
    lesson,
    new Map([
      [recall.id, recall],
      [quizEligible.id, quizEligible],
    ]),
  );

  expect(items.map((item) => item.exerciseId)).toEqual([quizEligible.id]);
});

test('information-theory quiz excludes its worked-example self-explanations', async () => {
  const content = await loadContent('content');
  const lesson = content.lessonsByConcept.get('information-theory');
  if (!lesson) throw new Error('Missing information-theory lesson');

  const items = selectQuizItems({
    lesson,
    exercises: content.exercisesById,
    servedProblems: [],
    previousAttemptItems: [],
    usedSeeds: new Set(),
    seed: 1234,
  });

  expect(items.map((item) => item.exerciseId)).not.toEqual(
    expect.arrayContaining(['it-surprise-why', 'it-entropy-why', 'it-cross-why', 'it-kl-why']),
  );
});

test('is deterministic for a fixed seed', () => {
  const { lesson, exercises } = makeSteps(1);
  expect(select(lesson, exercises, { seed: 77 })).toEqual(select(lesson, exercises, { seed: 77 }));
});

test('passes exactly at the 80% threshold, including partial credit', () => {
  expect(scoreLessonQuiz([1, 1, 1, 1, 1, 1])).toMatchObject({
    score: 1,
    passed: true,
  });
  expect(scoreLessonQuiz([1, 1, 1, 1, 1, 0])).toMatchObject({
    score: 5 / 6,
    passed: true,
  });
  expect(scoreLessonQuiz([1, 1, 1, 1, 0, 0])).toMatchObject({
    score: 4 / 6,
    passed: false,
  });
  expect(scoreLessonQuiz(Array(8).fill(1).slice(0, 7).concat(0))).toMatchObject({
    score: 7 / 8,
    passed: true,
  });
  expect(scoreLessonQuiz([1, 1, 1, 1, 1, 1, 0, 0])).toMatchObject({
    score: 6 / 8,
    passed: false,
  });
  const partialCredit = scoreLessonQuiz(Array(6).fill(0.8));
  expect(partialCredit.passed).toBe(true);
  expect(partialCredit.score).toBeCloseTo(0.8, 12);
});
