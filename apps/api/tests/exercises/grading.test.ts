import type { ContentIndex } from '@open-academy/engine/internal/course/types';
import { normalizeLearnerExpression } from '@open-academy/engine/internal/lessons/grading/expression';
import { gradeExercise } from '@open-academy/engine/internal/lessons/grading/index';
import { MULTIPLE_CHOICE_FALLBACK_FEEDBACK } from '@open-academy/engine/internal/lessons/grading/multiple-choice';
import type {
  ExpressionExercise,
  NumericExercise,
} from '@open-academy/engine/internal/lessons/grading/types';
import { beforeAll, expect, test } from 'vitest';
import { loadContent } from '../../src/content/load.js';

let content: ContentIndex;

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new Error(`Missing fixture ${label}`);
  }
  return value;
}

function expressionExercise(
  answer: string,
  variables: ExpressionExercise['variables'],
  common_wrong: NonNullable<ExpressionExercise['common_wrong']> = [],
): ExpressionExercise {
  const source = required(
    content.exercises.find((item) => item.type === 'expression'),
    'expression exercise',
  );
  return { ...source, answer, variables, common_wrong };
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

test('multiple choice explains selected wrong options and counts missed selections', async () => {
  const source = required(content.exercisesById.get('dx-vectors'), 'multiple choice exercise');
  if (source.type !== 'mc') throw new Error('Expected multiple choice exercise');
  const correct = source.options.find((option) => option.correct);
  const wrong = source.options.find((option) => !option.correct);
  if (!correct || !wrong) throw new Error('Missing correct and wrong options');
  const exercise = {
    ...source,
    multi: true,
    options: [
      { ...correct, id: 'correct-a', correct: true },
      { ...correct, id: 'correct-b', correct: true, feedback: undefined },
      { ...wrong, id: 'wrong-a', correct: false, feedback: 'First wrong-option feedback.' },
      { ...wrong, id: 'wrong-b', correct: false, feedback: 'Second wrong-option feedback.' },
    ],
  };
  const result = await gradeExercise(exercise, ['wrong-a', 'wrong-b']);
  expect(result.feedback).toContain('First wrong-option feedback.');
  expect(result.feedback).toContain('Second wrong-option feedback.');
  expect(result.feedback).toContain('You missed 2 correct options.');
});

test('multiple choice uses a concise fallback when a wrong option has no feedback', async () => {
  const source = required(content.exercisesById.get('dx-vectors'), 'multiple choice exercise');
  if (source.type !== 'mc') throw new Error('Expected multiple choice exercise');
  const wrong = source.options.find((option) => !option.correct);
  if (!wrong) throw new Error('Missing incorrect option');
  const exercise = {
    ...source,
    options: source.options.map((option) =>
      option.id === wrong.id ? { ...option, feedback: undefined } : option,
    ),
  };

  expect((await gradeExercise(exercise, wrong.id)).feedback).toBe(
    MULTIPLE_CHOICE_FALLBACK_FEEDBACK,
  );
  expect(MULTIPLE_CHOICE_FALLBACK_FEEDBACK).toBe('Review the options and try again.');
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

test('expression grading accepts implicit multiplication and Unicode notation', async () => {
  const exercise = expressionExercise('2*(w*x+b-y)*x', {
    w: [-2, 2],
    x: [-2, 2],
    b: [-2, 2],
    y: [-2, 2],
  });
  for (const answer of [
    '2w x^2+2bx-2xy',
    '2wx^2+2bx-2xy',
    '2wx²+2bx−2xy',
    '2(wx+b-y)x',
    '2*w*x^2+2*b*x-2*x*y',
  ]) {
    expect(await gradeExercise(exercise, answer, { random: () => 0.37 }), answer).toMatchObject({
      status: 'graded',
      correct: 1,
    });
  }
  expect(await gradeExercise(exercise, '2wx^2+2bx', { random: () => 0.37 })).toMatchObject({
    status: 'graded',
    correct: 0,
  });
  expect(await gradeExercise(exercise, '2qx', { random: () => 0.37 })).toMatchObject({
    status: 'invalid',
    feedback: "Unknown symbol 'q'. Use the variables: w, x, b, y.",
  });
});

test('expression grading accepts the y-hat variable in Unicode and typed forms', async () => {
  const exercise = expressionExercise('2*(yhat-y)', {
    yhat: [-3, 3],
    y: [-3, 3],
  });
  const random = () => {
    let draw = 0;
    return () => (draw++ % 2 === 0 ? 0.25 : 0.75);
  };
  for (const answer of ['2(ŷ - y)', '2*(y\u0302 - y)', '2*(yhat-y)']) {
    expect(await gradeExercise(exercise, answer, { random: random() }), answer).toMatchObject({
      status: 'graded',
      correct: 1,
    });
  }
  expect(await gradeExercise(exercise, '2(y - ŷ)', { random: random() })).toMatchObject({
    status: 'graded',
    correct: 0,
  });
});

test('expression normalization handles function adjacency, Greek sigma, and natural logs', async () => {
  const exponential = expressionExercise('2*b*exp(a) + a', {
    a: [-2, 2],
    b: [-2, 2],
  });
  for (const answer of ['2bexp(a)+a', '2b exp(a) + a']) {
    expect(await gradeExercise(exponential, answer, { random: () => 0.37 }), answer).toMatchObject({
      status: 'graded',
      correct: 1,
    });
  }

  const powers = expressionExercise('x^2 + 12*x*y^2', { x: [-2, 2], y: [-2, 2] });
  expect(await gradeExercise(powers, 'x^2+12xy^2', { random: () => 0.37 })).toMatchObject({
    status: 'graded',
    correct: 1,
  });
  expect(normalizeLearnerExpression('ln(x)', ['x'])).toBe('log(x)');
  expect(normalizeLearnerExpression('σ + x', ['sigma', 'x'])).toBe('sigma + x');
  expect(normalizeLearnerExpression('σ + x', ['x'])).toBe('σ + x');
  expect(normalizeLearnerExpression('w1x', ['w1', 'x'])).toBe('w1*x');
  expect(normalizeLearnerExpression('foo', ['x'])).toBe('foo');
});

test('expression common-wrong answers use the same implicit multiplication normalization', async () => {
  const exercise = expressionExercise(
    '2*(w*x+b-y)*x',
    { w: [-2, 2], x: [-2, 2], b: [-2, 2], y: [-2, 2] },
    [
      {
        answer: '2*w*x^2+2*b*x+2*x*y',
        category: 'math_error',
        feedback: 'Check the sign on the target term.',
      },
    ],
  );
  expect(await gradeExercise(exercise, '2wx^2+2bx+2xy', { random: () => 0.37 })).toMatchObject({
    status: 'graded',
    correct: 0,
    mistake_category: 'math_error',
  });
});

test('every authored expression answer in content is accepted', async () => {
  const realContent = await loadContent('content');
  const expressions = realContent.exercises.filter((exercise) => exercise.type === 'expression');
  expect(expressions.length).toBeGreaterThan(0);

  for (const exercise of expressions) {
    expect(
      await gradeExercise(exercise, exercise.answer, { random: () => 0.37 }),
      exercise.id,
    ).toMatchObject({ status: 'graded', correct: 1 });
  }
});

test('text accepts normalized answers and regular-expression matches', async () => {
  const exercise = required(content.exercisesById.get('vectors-dot-product'), 'text exercise');
  if (exercise.type !== 'text') throw new Error('Expected a text exercise');
  expect(await gradeExercise(exercise, '  ORTHOGONAL  ')).toMatchObject({ correct: 1 });
  expect(await gradeExercise(exercise, 'unrelated')).toMatchObject({ correct: 0 });
  expect(
    await gradeExercise({ ...exercise, accept: ['orthogonal'], regex: undefined }, 'ORTHOGONAL.'),
  ).toMatchObject({ correct: 1 });
  expect(
    await gradeExercise(
      {
        ...exercise,
        accept: ['cross-entropy'],
        regex: String.raw`^\s*h\s*\(\s*p\s*,\s*q\s*\)\s*$`,
      },
      'H( p, q )',
    ),
  ).toMatchObject({ correct: 1 });
});

test('text answers for the vector addition exercise ignore trailing sentence punctuation', async () => {
  const realContent = await loadContent('content');
  const exercise = required(
    realContent.exercisesById.get('vec-recall-points-moves-formula'),
    'vector addition text exercise',
  );
  if (exercise.type !== 'text') throw new Error('Expected a text exercise');

  for (const answer of ['(a₁ + b₁, a₂ + b₂).', '(a1+b1, a2+b2)!']) {
    expect(await gradeExercise(exercise, answer), answer).toMatchObject({ correct: 1 });
  }
  expect(await gradeExercise(exercise, '(a₁ − b₁, a₂ − b₂).')).toMatchObject({ correct: 0 });
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
  if (exercise.type !== 'explain') throw new Error('Expected an explanation exercise');
  const request = await gradeExercise(exercise, { text: 'A local rate.' });
  expect(request).toMatchObject({ status: 'self_check_required', graded_by: 'self' });
  const allRequired = {
    ...exercise,
    rubric: exercise.rubric.map((criterion) => ({ ...criterion, required: true })),
  };
  const partial = await gradeExercise(allRequired, {
    text: 'A local rate.',
    metCriteria: ['local-rate'],
  });
  expect(partial).toMatchObject({ status: 'graded', correct: 0.5, credit: 0.5, graded_by: 'self' });
  const requiredOnly = await gradeExercise(exercise, {
    text: 'A local rate.',
    metCriteria: ['local-rate'],
  });
  expect(requiredOnly).toMatchObject({ correct: 1, credit: 0.5, graded_by: 'self' });
  const full = await gradeExercise(exercise, {
    text: 'Local rate and tangent slope.',
    metCriteria: ['local-rate', 'tangent-slope'],
  });
  expect(full).toMatchObject({ correct: 1, credit: 0.5, graded_by: 'self' });
});
