import { beforeAll, expect, test } from 'vitest';
import { loadContent } from '../../content/load.js';
import { gradeExpression } from './expression.js';
import type { ExpressionExercise } from './types.js';

let exercise: ExpressionExercise;
beforeAll(async () => {
  const content = await loadContent('tests/fixtures/content');
  const source = content.exercises.find((item) => item.type === 'expression');
  if (source?.type !== 'expression') throw new Error('Missing expression fixture');
  exercise = { ...source, answer: '2*x', variables: { x: [-2, 2] } };
});

test.each([
  'zeros(1000000)',
  'range(1, 1000000)',
  'evaluate("2*x")',
  'parse("2*x").evaluate()',
  'x = 1',
  'f(x) = 2*x',
  '[2*x]',
  '1:1000000',
  '1000000!',
])('rejects non-scalar or unsupported expressions before evaluation: %s', (answer) => {
  expect(gradeExpression(exercise, answer)).toMatchObject({ status: 'invalid' });
});

test('bounds expression size and complexity', () => {
  expect(gradeExpression(exercise, 'x+'.repeat(1024))).toMatchObject({ status: 'invalid' });
  expect(gradeExpression(exercise, Array.from({ length: 150 }, () => 'x').join('+'))).toMatchObject(
    {
      status: 'invalid',
    },
  );
});

test('retains scalar functions and implicit multiplication', () => {
  expect(gradeExpression(exercise, '2x')).toMatchObject({ status: 'graded', correct: 1 });
  expect(gradeExpression(exercise, 'max(2*x, 2*x)')).toMatchObject({
    status: 'graded',
    correct: 1,
  });
});
