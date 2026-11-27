import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { loadContentFromDirectory } from './load.js';
import { seededOrder } from './option-order.js';

const content = loadContentFromDirectory(
  fileURLToPath(new URL('../../../../content', import.meta.url)),
);

test('seededOrder is deterministic, returns a permutation, and does not mutate its input', () => {
  const items = ['alpha', 'beta', 'gamma', 'delta'];
  const original = [...items];
  const first = seededOrder(items, 'exercise-42');
  const second = seededOrder(items, 'exercise-42');

  expect(first).toEqual(second);
  expect(first).not.toBe(items);
  expect(items).toEqual(original);
  expect([...first].sort()).toEqual([...items].sort());
});

test('real single-answer MC content has fewer than 40% correct options displayed first', async () => {
  const index = await content;
  const questions = index.exercises.filter(
    (exercise) => exercise.type === 'mc' && exercise.multi !== true,
  );
  expect(questions.length).toBeGreaterThan(0);

  const authoredFirst = questions.filter(
    (exercise) => exercise.type === 'mc' && exercise.options[0]?.correct === true,
  ).length;
  const shuffledFirst = questions.filter(
    (exercise) =>
      exercise.type === 'mc' && seededOrder(exercise.options, exercise.id)[0]?.correct === true,
  ).length;
  const beforePercentage = (100 * authoredFirst) / questions.length;
  const afterPercentage = (100 * shuffledFirst) / questions.length;

  console.log(
    `Correct-at-first-position for real single-answer MC: before ${beforePercentage.toFixed(2)}% (${authoredFirst}/${questions.length}); after ${afterPercentage.toFixed(2)}% (${shuffledFirst}/${questions.length})`,
  );
  expect(afterPercentage).toBeLessThan(40);
}, 15_000);
