import { ExerciseSchema } from '@open-academy/engine/course/schemas';
import {
  formatTemplateNumber,
  instantiateExercise,
  isTemplate,
} from '@open-academy/engine/course/templates';
import { expect, test } from 'vitest';
import { loadContent } from '../../src/content/load.js';

test('template instantiation is deterministic and samples different seeds', async () => {
  const content = await loadContent();
  const template = content.exercisesById.get('slp-predict');
  if (!template || !isTemplate(template)) throw new Error('Missing prediction template');
  expect(instantiateExercise(template, 13)).toEqual(instantiateExercise(template, 13));
  expect(instantiateExercise(template, 13).params).not.toEqual(
    instantiateExercise(template, 14).params,
  );
});

test('template constraints hold for sampled seeds', async () => {
  const content = await loadContent();
  const template = content.exercisesById.get('slp-error-sum');
  if (!template || !isTemplate(template)) throw new Error('Missing constrained template');
  for (let seed = 0; seed < 20; seed += 1) {
    const instance = instantiateExercise(template, seed);
    expect(instance.params.e1 + instance.params.e2 + instance.params.e3).toBe(0);
  }
});

test('template placeholder numbers use stable decimal formatting', () => {
  expect(formatTemplateNumber(0.1 + 0.2)).toBe('0.3');
  expect(formatTemplateNumber(1234567)).toBe('1234570');
  expect(formatTemplateNumber(-0)).toBe('0');
  expect(formatTemplateNumber(42)).toBe('42');
});

test('unsatisfiable template constraints throw a clear error', () => {
  const template = ExerciseSchema.parse({
    id: 'test-unsatisfiable',
    dimension: 'math',
    type: 'numeric',
    role: 'practice',
    difficulty: 1,
    est_minutes: 1,
    prompt: 'Compute {{=x}}.',
    hints: [],
    solution: 'The answer is {{=x}}.',
    answer_expr: 'x',
    params: { x: { min: 1, max: 2 } },
    constraints: ['x > 10'],
    tolerance: { abs: 0.000001 },
  });
  expect(() => instantiateExercise(template, 0)).toThrow(
    /could not satisfy constraints.*200 attempts/,
  );
});
