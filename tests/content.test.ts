import { resolve } from 'node:path';
import { expect, test } from 'vitest';
import { loadContent } from '../src/server/content/load.js';
import { serializeExercise } from '../src/server/content/serialize.js';
import { validateContent } from '../src/server/content/validate.js';

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new Error(`Missing fixture ${label}`);
  }
  return value;
}

test('loads the fixture graph and builds lookup indexes', async () => {
  const content = await loadContent('tests/fixtures/content');

  expect(content.concepts).toHaveLength(8);
  expect(new Set(content.concepts.map((concept) => concept.domain))).toEqual(
    new Set(['math', 'ml']),
  );
  expect(content.conceptsById.get('matrix-products')?.status).toBe('stub');
  expect(content.projectsById.has('linreg-numpy')).toBe(true);
  expect(content.diagnostic?.domains).toHaveLength(2);
  expect(content.edges).toContainEqual({
    conceptId: 'gradient-descent',
    prerequisiteId: 'gradients',
    strength: 'hard',
  });
  expect(content.exercisesByConcept.get('vectors')).toHaveLength(4);
  expect(content.exercisesByDimension.get('math')?.length).toBeGreaterThan(0);
  expect(content.exercisesByRole.get('diagnostic')?.length).toBe(7);
  expect(new Set(content.exercises.map((exercise) => exercise.type))).toEqual(
    new Set([
      'mc',
      'numeric',
      'expression',
      'text',
      'code_read',
      'code_complete',
      'debug',
      'explain',
    ]),
  );
  expect(content.concepts[0]?.contentVersion).toMatch(/^[a-f0-9]{12}$/);
});

test('client-safe exercise views omit keys, hints, and rubric weights', async () => {
  const content = await loadContent('tests/fixtures/content');
  const numeric = required(content.exercisesById.get('vectors-magnitude'), 'numeric exercise');
  const choice = required(content.exercisesById.get('dx-vectors'), 'choice exercise');
  const explain = required(content.exercisesById.get('derivatives-explain'), 'explain exercise');

  const safeNumeric = serializeExercise(numeric);
  const safeChoice = serializeExercise(choice);
  const safeExplain = serializeExercise(explain);
  expect(safeNumeric).not.toHaveProperty('answer');
  expect(safeNumeric).not.toHaveProperty('solution');
  expect(safeNumeric).not.toHaveProperty('hints');
  expect(safeChoice.options).toEqual([
    { id: 'euclidean-norm', text: 'Euclidean norm' },
    { id: 'coordinate-count', text: 'A product like $32 \\times 10$' },
  ]);
  expect(safeExplain.rubric).toEqual([
    { id: 'local-rate', criterion: 'Names the local rate of change', required: true },
    { id: 'tangent-slope', criterion: 'Connects it to tangent slope', required: false },
  ]);
  expect(safeExplain).not.toHaveProperty('exemplar');
});

test('an empty content directory is valid', async () => {
  const content = await loadContent(resolve('tests/fixtures/empty-content'));
  expect(content.concepts).toEqual([]);
  expect(content.exercises).toEqual([]);
  expect(content.conceptsById.size).toBe(0);
});

test('lessons start with an objective and end with a summary', () => {
  const issues = validateContent({
    concepts: [],
    lessons: [
      {
        file: 'lessons/example.yaml',
        value: {
          concept: 'example',
          version: 1,
          blocks: [
            { kind: 'summary', md: 'Takeaways.' },
            { kind: 'objective', md: 'Goal.' },
          ],
          fast_path: [],
        },
      },
    ],
    exercises: [],
    projects: [],
  });

  expect(issues).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: 'example',
        message: 'lesson must start with an objective block',
      }),
      expect.objectContaining({
        id: 'example',
        message: 'lesson must end with a summary block',
      }),
    ]),
  );
});
