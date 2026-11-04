import { beforeAll, expect, test } from 'vitest';
import { loadContent } from '../src/server/content/load.js';
import type { ContentIndex } from '../src/server/content/types.js';
import { gradeExercise } from '../src/server/grading/index.js';
import type { NumericExercise } from '../src/server/grading/types.js';

let content: ContentIndex;

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new Error(`Missing fixture ${label}`);
  }
  return value;
}

beforeAll(async () => {
  content = await loadContent('tests/fixtures/content');
});

test('multiple choice requires an exact option set and returns option feedback', async () => {
  const exercise = required(content.exercisesById.get('dx-vectors'), 'multiple choice exercise');
  expect(await gradeExercise(exercise, 'euclidean-norm')).toMatchObject({
    status: 'graded',
    correct: 1,
  });
  expect(await gradeExercise(exercise, 'coordinate-count')).toMatchObject({
    correct: 0,
    mistake_category: 'misunderstood_definition',
  });
});

test('numeric accepts fractions, scientific notation, tolerance, and common wrong answers', async () => {
  const exercise = required(content.exercisesById.get('vectors-magnitude'), 'numeric exercise');
  expect(await gradeExercise(exercise, '10/2')).toMatchObject({ correct: 1 });
  expect(await gradeExercise(exercise, '5e0')).toMatchObject({ correct: 1 });
  expect(await gradeExercise(exercise, '5.0000001')).toMatchObject({ correct: 1 });
  expect(await gradeExercise(exercise, 'not a number')).toMatchObject({ correct: 0 });
  expect(await gradeExercise(exercise, '1/0')).toMatchObject({ correct: 0 });
  const withCommonWrong = {
    ...(exercise as NumericExercise),
    common_wrong: [
      {
        answer: 4,
        category: 'math_error' as const,
        feedback: 'Check the square root after summing the squares.',
      },
    ],
  };
  expect(await gradeExercise(withCommonWrong, '4')).toMatchObject({
    correct: 0,
    mistake_category: 'math_error',
  });
});

test('expression grading checks sampled equivalence and rejects parse errors', async () => {
  const expression = required(
    content.exercises.find((item) => item.type === 'expression'),
    'expression exercise',
  );
  expect(await gradeExercise(expression, 'x + x', { random: () => 0.37 })).toMatchObject({
    correct: 1,
  });
  expect(await gradeExercise(expression, 'x +', { random: () => 0.37 })).toMatchObject({
    status: 'invalid',
  });
  const nonFiniteKey = {
    ...expression,
    answer: '1/x',
    variables: { x: [-1, 1] as [number, number] },
  };
  let draw = 0;
  expect(
    await gradeExercise(nonFiniteKey, '1 / x', {
      random: () => (draw++ === 0 ? 0.5 : 0.75),
    }),
  ).toMatchObject({ correct: 1 });
  expect(await gradeExercise({ ...expression, answer: 'sqrt(-1)' }, 'sqrt(-1)')).toMatchObject({
    status: 'invalid',
  });
  expect(
    await gradeExercise(
      {
        ...expression,
        common_wrong: [
          {
            answer: 'x',
            category: 'misunderstood_definition',
            feedback: 'Check the rule.',
          },
        ],
      },
      'x',
      { random: () => 0.37 },
    ),
  ).toMatchObject({ correct: 0, mistake_category: 'misunderstood_definition' });
});

test('text accepts normalized answers and regular-expression matches', async () => {
  const exercise = required(content.exercisesById.get('vectors-dot-product'), 'text exercise');
  expect(await gradeExercise(exercise, '  ORTHOGONAL  ')).toMatchObject({ correct: 1 });
  expect(await gradeExercise(exercise, 'unrelated')).toMatchObject({ correct: 0 });
});

test('code reading delegates to numeric grading', async () => {
  const exercise = required(
    content.exercisesById.get('gradients-code-read'),
    'code-reading exercise',
  );
  expect(await gradeExercise(exercise, '4')).toMatchObject({ correct: 1 });
  expect(await gradeExercise(exercise, '5')).toMatchObject({ correct: 0 });
});

test('code completion ignores whitespace and quote style', async () => {
  const exercise = required(
    content.exercisesById.get('linear-algebra-code-complete'),
    'code-completion exercise',
  );
  expect(await gradeExercise(exercise, '  @  ')).toMatchObject({ correct: 1 });
  const stringExercise = {
    ...exercise,
    accept: ["model['weight']"],
  } as typeof exercise;
  expect(await gradeExercise(stringExercise, 'model[ "weight" ]')).toMatchObject({ correct: 1 });
});

test('debug grading gives partial credit for one correct part', async () => {
  const exercise = required(content.exercisesById.get('linear-algebra-debug'), 'debug exercise');
  expect(await gradeExercise(exercise, { line: 3, fixId: 'dot-product' })).toMatchObject({
    correct: 1,
  });
  expect(await gradeExercise(exercise, { line: 3, fixId: 'concatenate' })).toMatchObject({
    correct: 0.5,
  });
  expect(await gradeExercise(exercise, { line: 2, fixId: 'concatenate' })).toMatchObject({
    correct: 0,
  });
});

test('explanation self-check requires rubric selection and caps credit at assisted', async () => {
  const exercise = required(content.exercisesById.get('derivatives-explain'), 'explain exercise');
  const request = await gradeExercise(exercise, { text: 'A local rate.' });
  expect(request).toMatchObject({ status: 'self_check_required', graded_by: 'self' });
  const partial = await gradeExercise(exercise, {
    text: 'A local rate.',
    metCriteria: ['local-rate'],
  });
  expect(partial).toMatchObject({ status: 'graded', correct: 0.5, credit: 0.5, graded_by: 'self' });
  const full = await gradeExercise(exercise, {
    text: 'Local rate and tangent slope.',
    metCriteria: ['local-rate', 'tangent-slope'],
  });
  expect(full).toMatchObject({ correct: 1, credit: 0.5, graded_by: 'self' });
});
