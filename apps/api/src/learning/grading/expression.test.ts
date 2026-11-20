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

test('normalizes adjacent factors as implicit multiplication', () => {
  const groupedExercise: ExpressionExercise = {
    ...exercise,
    answer: 'r*(d+k)',
    variables: { r: [0.1, 0.9], d: [1, 3], k: [1, 3] },
  };
  expect(gradeExpression(groupedExercise, 'r(d+k)')).toMatchObject({
    status: 'graded',
    correct: 1,
  });

  const numericExercise: ExpressionExercise = {
    ...exercise,
    answer: '2*x+1',
    variables: { x: [-2, 2] },
  };
  expect(gradeExpression(numericExercise, '2x+1')).toMatchObject({
    status: 'graded',
    correct: 1,
  });

  const conjugateExercise: ExpressionExercise = {
    ...exercise,
    answer: 'a^2-b^2',
    variables: { a: [-3, 3], b: [-3, 3] },
  };
  expect(gradeExpression(conjugateExercise, '(a+b)(a-b)')).toMatchObject({
    status: 'graded',
    correct: 1,
  });
});

test('inserts implicit multiplication after complete scientific-notation numbers', () => {
  const smallNumberExercise: ExpressionExercise = {
    ...exercise,
    answer: '0.001*x',
    variables: { x: [0.1, 2] },
  };
  expect(gradeExpression(smallNumberExercise, '1e-3*x')).toMatchObject({
    status: 'graded',
    correct: 1,
  });

  const largeNumberExercise: ExpressionExercise = {
    ...exercise,
    answer: '2500*x',
    variables: { x: [0.1, 2] },
  };
  expect(gradeExpression(largeNumberExercise, '2.5e3*x')).toMatchObject({
    status: 'graded',
    correct: 1,
  });

  const exponentExercise: ExpressionExercise = {
    ...exercise,
    answer: '100*x',
    variables: { x: [0.1, 2] },
  };
  expect(gradeExpression(exponentExercise, '1E+2x')).toMatchObject({
    status: 'graded',
    correct: 1,
  });
});

test('multiplies Euler’s constant after a number', () => {
  const eulerExercise: ExpressionExercise = {
    ...exercise,
    answer: '2*e',
    variables: {},
  };
  expect(gradeExpression(eulerExercise, '2e')).toMatchObject({
    status: 'graded',
    correct: 1,
  });
});

test('preserves function calls and variables that resemble function prefixes', () => {
  const logarithmExercise: ExpressionExercise = {
    ...exercise,
    answer: 'log(p)',
    variables: { p: [0.1, 0.9] },
  };
  expect(gradeExpression(logarithmExercise, 'log(p)')).toMatchObject({
    status: 'graded',
    correct: 1,
  });

  const prefixExercise: ExpressionExercise = {
    ...exercise,
    answer: 'r*log(p)',
    variables: { r: [0.1, 0.9], p: [0.1, 0.9] },
  };
  expect(gradeExpression(prefixExercise, 'rlog(p)')).toMatchObject({
    status: 'graded',
    correct: 1,
  });

  const variableNameExercise: ExpressionExercise = {
    ...exercise,
    answer: 'rlog*p',
    variables: { rlog: [0.1, 0.9], p: [0.1, 0.9] },
  };
  expect(gradeExpression(variableNameExercise, 'rlog(p)')).toMatchObject({
    status: 'graded',
    correct: 1,
  });
});

test('keeps calls to unknown functions invalid', () => {
  const exerciseWithVariables: ExpressionExercise = {
    ...exercise,
    answer: 'm+n',
    variables: { m: [1, 2], n: [1, 2] },
  };
  expect(gradeExpression(exerciseWithVariables, 'k(m+n)')).toMatchObject({
    status: 'invalid',
  });
});

test('samples discrete expression variables from their listed values', () => {
  const binaryCrossEntropyExercise: ExpressionExercise = {
    ...exercise,
    answer: '-(y*log(p)+(1-y)*log(1-p))',
    variables: { y: { values: [0, 1] }, p: [0.05, 0.95] },
  };
  const random = () => {
    const draws = [0.1, 0.9, 0.9, 0.1];
    let index = 0;
    return () => draws[index++ % draws.length] ?? 0.5;
  };

  expect(
    gradeExpression(binaryCrossEntropyExercise, '-log(y*p+(1-y)*(1-p))', {
      random: random(),
    }),
  ).toMatchObject({ status: 'graded', correct: 1 });
  expect(
    gradeExpression(binaryCrossEntropyExercise, '-log(p)', { random: () => 0.1 }),
  ).toMatchObject({ status: 'graded', correct: 0 });
});

test('grades log2 of a reciprocal as equivalent to a natural-log ratio', () => {
  const logarithmExercise: ExpressionExercise = {
    ...exercise,
    answer: '-log(r)/log(2)',
    variables: { r: [0.1, 0.9] },
  };

  expect(gradeExpression(logarithmExercise, 'log2(1/r)', { random: () => 0.5 })).toMatchObject({
    status: 'graded',
    correct: 1,
  });
});

test('normalizes stored natural-log expressions before grading', () => {
  const logarithmExercise: ExpressionExercise = {
    ...exercise,
    answer: '-(ln(p)+ln(q))/2',
    variables: { p: [0.1, 0.9], q: [0.1, 0.9] },
  };

  expect(
    gradeExpression(logarithmExercise, '-(log(p)+log(q))/2', { random: () => 0.5 }),
  ).toMatchObject({ status: 'graded', correct: 1 });
  expect(gradeExpression(logarithmExercise, '-ln(p*q)/2', { random: () => 0.5 })).toMatchObject({
    status: 'graded',
    correct: 1,
  });
});

test('grades the y-only derp-log-base answer and equivalent expressions', async () => {
  const content = await loadContent('content');
  const logarithmExercise = content.exercises.find((item) => item.id === 'derp-log-base');
  if (logarithmExercise?.type !== 'expression') {
    throw new Error('Expected derp-log-base to be an expression exercise');
  }

  for (const answer of ['2^y+log(2)*y', 'exp(y*log(2))+y*log(2)', '2^y + y*log(2)']) {
    expect(gradeExpression(logarithmExercise, answer), answer).toMatchObject({
      status: 'graded',
      correct: 1,
    });
  }
  expect(gradeExpression(logarithmExercise, 'x+log(2)*y')).toMatchObject({
    status: 'invalid',
  });
});
