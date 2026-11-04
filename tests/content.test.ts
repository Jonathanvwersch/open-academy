import { resolve } from 'node:path';
import { expect, test } from 'vitest';
import { loadContent } from '../src/server/content/load.js';
import { serializeExercise } from '../src/server/content/serialize.js';
import type { ContentIndex, ContentSourceData } from '../src/server/content/types.js';
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

test('notation used without an introducing hard prerequisite is an issue', async () => {
  const data = await notationFixture();
  addNotationTerm(data);
  const derivatives = data.concepts.find(({ value }) => value.id === 'derivatives');
  if (!derivatives) throw new Error('Missing fixture derivatives concept');
  derivatives.value.prereqs = [];
  addOwnedText(data, 'derivatives', 'needle');

  expect(validateContent(data)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: 'dx-derivatives',
        message: expect.stringContaining(
          'uses needle notation but none of vectors is a hard prerequisite',
        ),
      }),
    ]),
  );
});

test('notation from a hard prerequisite is allowed', async () => {
  const data = await notationFixture();
  addNotationTerm(data);
  addOwnedText(data, 'linear-models', 'needle');

  expect(validateContent(data)).not.toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        message: expect.stringContaining('uses needle notation'),
      }),
    ]),
  );
});

test('a soft prerequisite does not allow notation use', async () => {
  const data = await notationFixture();
  addNotationTerm(data);
  const linearModels = data.concepts.find(({ value }) => value.id === 'linear-models');
  if (!linearModels) throw new Error('Missing fixture linear-models concept');
  linearModels.value.prereqs = [{ id: 'vectors', strength: 'soft' }];
  addOwnedText(data, 'linear-models', 'needle');

  expect(validateContent(data)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: 'dx-linear-models',
        message: expect.stringContaining(
          'uses needle notation but none of vectors is a hard prerequisite',
        ),
      }),
    ]),
  );
});

test('an authored introducer lesson must teach its notation term', async () => {
  const data = await notationFixture();
  addNotationTerm(data, false);

  expect(validateContent(data)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        file: 'lessons/vectors.yaml',
        id: 'vectors',
        message: 'introducing lesson does not teach needle notation',
      }),
    ]),
  );
});

async function notationFixture(): Promise<ContentSourceData> {
  const content = await loadContent('tests/fixtures/content');
  return sourceDataFromIndex(content);
}

function sourceDataFromIndex(content: ContentIndex): ContentSourceData {
  return {
    concepts: content.concepts.map(({ domain, contentVersion, ...value }) => ({
      value,
      domain,
      file: 'concepts/fixture.yaml',
    })),
    lessons: content.lessons.map(({ contentVersion, ...value }) => ({
      value,
      file: `lessons/${value.concept}.yaml`,
    })),
    exercises: content.exercises.map(({ concept, contentVersion, ...value }) => ({
      value,
      concept,
      file: `exercises/${concept}.yaml`,
    })),
    projects: content.projects.map(({ contentVersion, ...value }) => ({
      value,
      file: `projects/${value.id}.yaml`,
    })),
  };
}

function addNotationTerm(data: ContentSourceData, teachIntro = true) {
  if (teachIntro) {
    const vectorLesson = data.lessons.find(({ value }) => value.concept === 'vectors');
    const firstBlock = vectorLesson?.value.blocks.find((block) => 'md' in block);
    if (!firstBlock || !('md' in firstBlock)) {
      throw new Error('Missing vectors lesson Markdown');
    }
    firstBlock.md = `${firstBlock.md}\nThe notation needle marks this term.`;
  }
  data.notation = {
    file: 'notation.yaml',
    value: {
      terms: [
        {
          id: 'needle',
          label: 'needle notation',
          match: ['needle'],
          introduced_by: ['vectors'],
        },
      ],
    },
  };
}

function addOwnedText(data: ContentSourceData, concept: string, text: string) {
  const exercise = data.exercises.find((entry) => entry.concept === concept);
  if (!exercise) throw new Error(`Missing fixture exercise for ${concept}`);
  exercise.value.prompt = `A prompt mentions ${text}.`;
}
