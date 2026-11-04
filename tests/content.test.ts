import { resolve } from 'node:path';
import { expect, test } from 'vitest';
import { loadContent } from '../src/server/content/load.js';
import { ExerciseSchema, LessonSchema, normalizeLesson } from '../src/server/content/schemas.js';
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

  expect(content.concepts).toHaveLength(9);
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
  expect(content.exercisesByRole.get('diagnostic')?.length).toBe(8);
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
  expect(safeExplain).not.toHaveProperty('solution');
  expect(safeExplain).not.toHaveProperty('exemplar');
});

test('explain exercises can use their exemplar without a separate solution', async () => {
  const content = await loadContent('tests/fixtures/content');
  const explain = required(content.exercisesById.get('derivatives-explain'), 'explain exercise');
  const input = Object.fromEntries(
    Object.entries(explain).filter(
      ([key]) => key !== 'solution' && key !== 'concept' && key !== 'contentVersion',
    ),
  );
  const parsed = ExerciseSchema.parse(input);
  expect(parsed).toMatchObject({ type: 'explain', exemplar: expect.any(String) });
  expect(parsed).not.toHaveProperty('solution');
});

test('client-safe template views hide expressions and sampling ranges', async () => {
  const content = await loadContent();
  const template = required(content.exercisesById.get('slp-predict'), 'parameterised exercise');
  const serialized = serializeExercise(template);
  expect(serialized).not.toHaveProperty('answer_expr');
  expect(serialized).not.toHaveProperty('params');
  expect(serialized).not.toHaveProperty('constraints');
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

test('knowledge-point Markdown participates in notation checks', async () => {
  const data = await notationFixture();
  addNotationTerm(data);
  const concept = data.concepts.find(({ value }) => value.id === 'derivatives');
  const lesson = data.lessons.find(({ value }) => value.concept === 'derivatives');
  if (!concept || !lesson) throw new Error('Missing derivatives fixture');
  concept.value.prereqs = [];
  lesson.value.knowledge_points = [
    {
      id: 'kp-needle-use',
      title: 'Rates',
      explain: 'This uses needle notation.',
      worked: 'Work.',
      problems: [],
    },
  ];
  expect(validateContent(data)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: 'kp-needle-use',
        message: expect.stringContaining('uses needle notation'),
      }),
    ]),
  );
});

test('an introducing lesson may teach notation in a knowledge point', async () => {
  const data = await notationFixture();
  addNotationTerm(data, false);
  const lesson = data.lessons.find(({ value }) => value.concept === 'vectors');
  if (!lesson) throw new Error('Missing vectors fixture');
  lesson.value.knowledge_points = [
    {
      id: 'kp-needle-intro',
      title: 'Needle notation',
      explain: 'A definition.',
      worked: 'An example.',
      problems: [],
    },
  ];
  expect(validateContent(data)).not.toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: 'vectors',
        message: 'introducing lesson does not teach needle notation',
      }),
    ]),
  );
});

test('knowledge-point lessons derive the legacy block shape', () => {
  const input = LessonSchema.parse({
    concept: 'vectors',
    version: 3,
    objective: 'Learn the idea.',
    knowledge_points: [
      {
        id: 'kp-one',
        title: 'First',
        explain: 'Explain.',
        worked: 'Work.',
        problems: ['template', 'fixed'],
      },
      { id: 'kp-two', title: 'Second', explain: 'Explain.', worked: 'Work.', problems: ['fixed'] },
    ],
    summary: 'Finish.',
  });
  const lesson = normalizeLesson(input, (id) => id === 'template');
  expect(lesson.blocks).toEqual([
    { kind: 'objective', md: 'Learn the idea.' },
    { kind: 'intuition', md: '### First\n\nExplain.' },
    { kind: 'worked', md: 'Work.' },
    { kind: 'check', exercise: 'fixed' },
    { kind: 'intuition', md: '### Second\n\nExplain.' },
    { kind: 'worked', md: 'Work.' },
    { kind: 'check', exercise: 'fixed' },
    { kind: 'summary', md: 'Finish.' },
  ]);
  expect(lesson.fast_path).toEqual(['objective', 'summary']);
  expect(lesson.knowledge_points).toHaveLength(2);
});

test('knowledge-point lesson schema requires between two and four points', () => {
  const point = {
    id: 'kp-one',
    title: 'Title',
    explain: 'Explain.',
    worked: 'Work.',
    problems: [],
  };
  const base = {
    concept: 'vectors',
    version: 3,
    objective: 'Goal.',
    summary: 'Summary.',
  };
  expect(LessonSchema.safeParse({ ...base, knowledge_points: [point] }).success).toBe(false);
  expect(
    LessonSchema.safeParse({
      ...base,
      knowledge_points: [
        point,
        { ...point, id: 'kp-two' },
        { ...point, id: 'kp-three' },
        { ...point, id: 'kp-four' },
        { ...point, id: 'kp-five' },
      ],
    }).success,
  ).toBe(false);
});

test('a valid knowledge-point lesson with a parameterised practice problem passes validation', async () => {
  const data = await notationFixture();
  const lesson = data.lessons.find(({ value }) => value.concept === 'vectors');
  if (!lesson) throw new Error('Missing vectors lesson');
  const fixedExercises = ['kp-fixed-one', 'kp-fixed-two', 'kp-fixed-three', 'kp-fixed-four'].map(
    (id) =>
      ExerciseSchema.parse({
        id,
        dimension: 'conceptual',
        type: 'mc',
        role: 'practice',
        difficulty: 1,
        est_minutes: 1,
        prompt: 'Which answer is correct?',
        hints: [],
        solution: 'This answer matches the definition.',
        options: [
          { id: `${id}-yes`, text: 'Correct', correct: true },
          { id: `${id}-no`, text: 'Incorrect', correct: false },
        ],
      }),
  );
  const template = (id: string) =>
    ExerciseSchema.parse({
      id,
      dimension: 'math',
      type: 'numeric',
      role: 'practice',
      difficulty: 1,
      est_minutes: 1,
      prompt: 'Compute {{=x}}.',
      hints: [],
      solution: 'The answer is {{=x}}.',
      answer_expr: 'x',
      params: { x: { min: 1, max: 3 } },
      tolerance: { abs: 0.000001 },
    });
  const templates = [template('kp-template-one'), template('kp-template-two')];
  data.exercises.push(
    ...[...fixedExercises, ...templates].map((value) => ({
      value,
      concept: 'vectors',
      file: 'exercises/vectors.yaml',
    })),
  );
  lesson.value.knowledge_points = [
    {
      id: 'kp-valid-one',
      title: 'A valid point',
      explain: 'A concise explanation.',
      worked: 'A complete worked example.',
      problems: ['kp-template-one', 'kp-fixed-one', 'kp-fixed-two'],
    },
    {
      id: 'kp-valid-two',
      title: 'Another valid point',
      explain: 'A concise explanation.',
      worked: 'A complete worked example.',
      problems: ['kp-template-two', 'kp-fixed-three', 'kp-fixed-four'],
    },
  ];
  expect(validateContent(data).filter((issue) => issue.id.startsWith('kp-'))).toEqual([]);
});

test('knowledge-point rules reject short, duplicate, missing, non-practice, and shared problems', async () => {
  const data = await notationFixture();
  const lesson = data.lessons.find(({ value }) => value.concept === 'vectors');
  if (!lesson) throw new Error('Missing vectors lesson');
  const fixed = (id: string) =>
    ExerciseSchema.parse({
      id,
      dimension: 'conceptual',
      type: 'mc',
      role: 'practice',
      difficulty: 1,
      est_minutes: 1,
      prompt: 'Which is correct?',
      hints: [],
      solution: 'This option is correct because it matches the definition.',
      options: [
        { id: `${id}-yes`, text: 'Correct', correct: true },
        { id: `${id}-no`, text: 'Incorrect', correct: false },
      ],
    });
  data.exercises.push(
    ...['practice-one', 'practice-two', 'practice-three'].map((id) => ({
      value: fixed(id),
      concept: 'vectors',
      file: 'exercises/vectors.yaml',
    })),
    { value: fixed('orphaned-practice'), concept: 'vectors', file: 'exercises/vectors.yaml' },
  );
  lesson.value.knowledge_points = [
    {
      id: 'duplicate-id',
      title: ' ',
      explain: '',
      worked: '',
      problems: [
        'practice-one',
        'practice-one',
        'missing',
        'vectors-magnitude',
        'derivatives-explain',
      ],
    },
    {
      id: 'second-point',
      title: 'Second',
      explain: 'Explain.',
      worked: 'Work.',
      problems: ['practice-two', 'practice-three'],
    },
    {
      id: 'duplicate-id',
      title: 'Third',
      explain: 'Explain.',
      worked: 'Work.',
      problems: ['practice-one'],
    },
  ];
  const issues = validateContent(data);
  expect(issues.map((issue) => issue.message)).toEqual(
    expect.arrayContaining([
      'duplicate knowledge-point id',
      'knowledge-point title must not be empty',
      'knowledge-point explain must not be empty',
      'knowledge-point worked must not be empty',
      'knowledge point must reference at least 3 problems',
      expect.stringContaining('problem "practice-one" is listed more than once'),
      expect.stringContaining('references missing problem "missing"'),
      expect.stringContaining('problem "vectors-magnitude" must have practice role'),
      expect.stringContaining('problem "derivatives-explain" belongs to "derivatives"'),
      expect.stringContaining(
        'problem "practice-one" is listed more than once across knowledge points',
      ),
      expect.stringContaining('knowledge point needs 5 fixed problems or at least 1 template'),
      'practice exercise is not referenced by a knowledge point',
      expect.stringContaining(
        'practice exercise must be referenced by exactly one knowledge point',
      ),
    ]),
  );
});

test('template validation reports unsatisfied constraints, unresolved text, constant answers, collisions, and bad expressions', async () => {
  const data = await notationFixture();
  const lesson = data.lessons.find(({ value }) => value.concept === 'vectors');
  if (!lesson) throw new Error('Missing vectors lesson');
  const template = (id: string, changes: Record<string, unknown> = {}) =>
    ExerciseSchema.parse({
      id,
      dimension: 'math',
      type: 'numeric',
      role: 'practice',
      difficulty: 1,
      est_minutes: 1,
      prompt: 'Compute {{=x}}.',
      hints: [],
      solution: 'The answer is {{=x}}.',
      answer_expr: 'x',
      params: { x: { min: 1, max: 3 } },
      tolerance: { abs: 0.000001 },
      ...changes,
    });
  const templates = [
    template('template-role', { role: 'core' }),
    template('template-unsat', { constraints: ['x > 10'] }),
    template('template-leftover', { prompt: 'Unclosed placeholder {{=x' }),
    template('template-constant', { answer_expr: '2' }),
    template('template-collision', {
      common_wrong: [{ answer_expr: 'x', category: 'math_error', feedback: 'Try again.' }],
    }),
    template('template-malformed', { answer_expr: 'x + unknown' }),
  ];
  data.exercises.push(
    ...templates.map((value) => ({ value, concept: 'vectors', file: 'exercises/vectors.yaml' })),
  );
  lesson.value.knowledge_points = [
    {
      id: 'template-kp',
      title: 'Templates',
      explain: 'Explain.',
      worked: 'Work.',
      problems: templates.map(({ id }) => id),
    },
  ];
  const issues = validateContent(data);
  for (const [id, text] of [
    ['template-role', 'templates must have practice role'],
    ['template-unsat', 'could not satisfy constraints'],
    ['template-leftover', 'unresolved {{= placeholder'],
    ['template-constant', 'at least 3 distinct answers'],
    ['template-collision', 'common-wrong answer is within tolerance'],
    ['template-malformed', 'unknown identifier'],
  ]) {
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id, message: expect.stringContaining(text) }),
      ]),
    );
  }
  expect(issues).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: 'template-kp',
        message: 'knowledge point must include at least 1 fixed problem',
      }),
    ]),
  );
});

test('template validator rejects answers that are not accepted when displayed', async () => {
  const data = await notationFixture();
  const exercise = ExerciseSchema.parse({
    id: 'template-rounded-answer',
    dimension: 'math',
    type: 'numeric',
    role: 'practice',
    difficulty: 1,
    est_minutes: 1,
    prompt: 'Compute {{=x}} divided by 3.',
    hints: [],
    solution: 'The result is {{=x/3}}.',
    answer_expr: 'x / 3',
    params: { x: { min: 10, max: 12 } },
    tolerance: { abs: 0.000001 },
  });
  data.exercises.push({
    value: exercise,
    concept: 'vectors',
    file: 'exercises/vectors.yaml',
  });

  expect(validateContent(data)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: 'template-rounded-answer',
        message: expect.stringContaining('answer shown as 3.33333 is not accepted'),
      }),
    ]),
  );
});

test('template validator rejects adjacent negative signs but allows parenthesised negatives', async () => {
  const data = await notationFixture();
  const template = (id: string, solution: string) =>
    ExerciseSchema.parse({
      id,
      dimension: 'math',
      type: 'numeric',
      role: 'practice',
      difficulty: 1,
      est_minutes: 1,
      prompt: 'Compute {{=x}}.',
      hints: [],
      solution,
      answer_expr: 'x',
      params: { x: { min: 1, max: 3 } },
      tolerance: { abs: 0.000001 },
    });
  const placeholder = '{{=x}}';
  data.exercises.push(
    {
      value: template('template-adjacent-signs', `Compute $${placeholder} + -${placeholder}$.`),
      concept: 'vectors',
      file: 'exercises/vectors.yaml',
    },
    {
      value: template('template-parenthesised-negative', `The value is $(-${placeholder})$.`),
      concept: 'vectors',
      file: 'exercises/vectors.yaml',
    },
  );

  const issues = validateContent(data);
  expect(issues).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: 'template-adjacent-signs',
        message: expect.stringContaining('instantiated text contains adjacent signs'),
      }),
    ]),
  );
  expect(
    issues.some(
      (issue) =>
        issue.id === 'template-parenthesised-negative' &&
        issue.message.includes('instantiated text contains adjacent signs'),
    ),
  ).toBe(false);
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
