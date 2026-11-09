import { resolve } from 'node:path';
import { expect, test } from 'vitest';
import { loadContent } from '../src/server/content/load.js';
import {
  ExerciseSchema,
  LessonSchema,
  normalizeLesson,
  PaperSchema,
} from '../src/server/content/schemas.js';
import { serializeExercise } from '../src/server/content/serialize.js';
import type { ContentIndex, ContentSourceData } from '../src/server/content/types.js';
import { validateContent } from '../src/server/content/validate.js';

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new Error(`Missing fixture ${label}`);
  }
  return value;
}

function firstPaper(data: ContentSourceData) {
  const [paper] = data.papers;
  if (!paper) throw new Error('Missing paper fixture');
  return paper;
}

test('loads the fixture graph and builds lookup indexes', async () => {
  const content = await loadContent('tests/fixtures/content');

  expect(content.concepts).toHaveLength(9);
  expect(new Set(content.concepts.map((concept) => concept.domain))).toEqual(
    new Set(['math', 'ml']),
  );
  expect(content.conceptsById.get('matrix-products')?.status).toBe('stub');
  expect(content.projectsById.has('linreg-numpy')).toBe(true);
  expect(content.papersByWeek.get(1)).toHaveLength(2);
  expect(content.diagnostic?.domains).toHaveLength(2);
  expect(content.edges).toContainEqual({
    conceptId: 'gradient-descent',
    prerequisiteId: 'gradients',
    strength: 'hard',
  });
  expect(content.exercisesByConcept.get('vectors')).toHaveLength(15);
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

test('real authored paper content loads and indexes by ID and week', async () => {
  const content = await loadContent('content');

  expect(content.papers.length).toBeGreaterThan(0);
  expect(content.papersById.size).toBe(content.papers.length);
  expect([...content.papersByWeek.values()].flat()).toHaveLength(content.papers.length);
});

test('every real lesson knowledge point has non-basics problems at difficulties one through three', async () => {
  const content = await loadContent('content');
  const missingDifficulties: string[] = [];

  for (const lesson of content.lessons) {
    for (const point of lesson.knowledge_points ?? []) {
      const difficulties = new Set(
        point.problems.flatMap((id) => {
          const exercise = content.exercisesById.get(id);
          return exercise && exercise.role !== 'basics' ? [exercise.difficulty] : [];
        }),
      );
      const missing = [1, 2, 3].filter((difficulty) => !difficulties.has(difficulty));
      if (missing.length > 0) {
        missingDifficulties.push(`${lesson.concept}/${point.id}: missing ${missing.join(', ')}`);
      }
    }
  }

  expect(missingDifficulties).toEqual([]);
});

test('paper validation rejects unsafe sources, malformed identifiers, invalid question sets, and unknown references', async () => {
  const data = await notationFixture();
  const base = data.papers[0];
  if (!base) throw new Error('Missing paper fixture');
  expect(PaperSchema.safeParse({ ...base.value, source: { arxiv: 'bad-id' } }).success).toBe(false);

  const invalidUrl = structuredClone(data);
  firstPaper(invalidUrl).value.source = { url: 'http://example.com/paper.pdf' };
  expect(
    validateContent(invalidUrl).some((issue) => issue.message.includes('paper URL must be')),
  ).toBe(true);

  const wrongHost = structuredClone(data);
  firstPaper(wrongHost).value.source = { url: 'https://example.com/paper.pdf' };
  expect(
    validateContent(wrongHost).some((issue) => issue.message.includes('paper URL must be')),
  ).toBe(true);

  const missingKind = structuredClone(data);
  firstPaper(missingKind).value.questions.pop();
  expect(
    validateContent(missingKind).some((issue) =>
      issue.message.includes('exactly one "limitations"'),
    ),
  ).toBe(true);

  const duplicateKind = structuredClone(data);
  const duplicateQuestions = firstPaper(duplicateKind).value.questions;
  const fourthQuestion = duplicateQuestions[3];
  if (!fourthQuestion) throw new Error('Missing fourth paper question');
  fourthQuestion.kind = 'claim';
  expect(
    validateContent(duplicateKind).some((issue) =>
      issue.message.includes('exactly one "limitations"'),
    ),
  ).toBe(true);

  const unknownConcept = structuredClone(data);
  firstPaper(unknownConcept).value.concepts = ['missing-concept'];
  expect(
    validateContent(unknownConcept).some((issue) => issue.message.includes('unknown concept')),
  ).toBe(true);

  const missingWeek = structuredClone(data);
  firstPaper(missingWeek).value.week = 99;
  expect(
    validateContent(missingWeek).some((issue) =>
      issue.message.includes('week 99 is not in the curriculum'),
    ),
  ).toBe(true);

  const duplicateId = structuredClone(data);
  duplicateId.papers.push({ ...firstPaper(duplicateId), file: 'papers/duplicate.yaml' });
  expect(validateContent(duplicateId).some((issue) => issue.message === 'duplicate paper id')).toBe(
    true,
  );
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
    papers: [],
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
      expect.objectContaining({
        id: 'example',
        message: 'authored lessons must use knowledge_points',
      }),
    ]),
  );
});

test('knowledge-point lesson opening counts words after removing math and fenced blocks', async () => {
  const data = await notationFixture();
  const lesson = data.lessons.find(({ value }) => value.concept === 'derivatives');
  if (!lesson) throw new Error('Missing derivatives fixture');
  const fencedWords = Array.from({ length: 100 }, () => 'ignored').join(' ');
  lesson.value.where_this_fits = `${Array.from({ length: 28 }, () => 'word').join(' ')} $x + 1$ \n\`\`\`text\n${fencedWords}\n\`\`\``;

  expect(validateContent(data)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: 'derivatives',
        message: 'lesson where_this_fits has 29 words; expected 30–130',
      }),
    ]),
  );
});

test('knowledge-point lesson summary requires the Next line', async () => {
  const data = await notationFixture();
  const lesson = data.lessons.find(({ value }) => value.concept === 'derivatives');
  if (!lesson) throw new Error('Missing derivatives fixture');
  lesson.value.summary = 'A summary without the required application line.';

  expect(validateContent(data)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: 'derivatives',
        message: 'lesson summary must contain a line starting with "**Next:**"',
      }),
    ]),
  );
});

test('knowledge-point prose does not require boilerplate openings', async () => {
  const data = await notationFixture();
  const lesson = data.lessons.find(({ value }) => value.concept === 'derivatives');
  const point = lesson?.value.knowledge_points?.[0];
  if (!point) throw new Error('Missing derivatives knowledge point');
  point.explain = 'A definition without a boilerplate application line.';
  point.worked = 'Find the gradient at the stated point.';

  const issues = validateContent(data);
  expect(
    issues.some(
      (issue) =>
        issue.id === point.id &&
        (issue.message.includes('Why this is useful') ||
          issue.message.includes('worked must start')),
    ),
  ).toBe(false);
});

test('knowledge-point lessons may include check-role exercises', async () => {
  const data = await notationFixture();
  const lesson = data.lessons.find(({ value }) => value.concept === 'vectors');
  const point = lesson?.value.knowledge_points?.[0];
  const exercise = point
    ? data.exercises.find(({ value }) => value.id === point.problems[0])?.value
    : undefined;
  if (!point || !exercise) throw new Error('Missing vectors exercise fixture');
  exercise.role = 'check';

  expect(validateContent(data)).not.toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: point.id,
        message: expect.stringContaining('must have practice or check role'),
      }),
    ]),
  );
});

test('hard prerequisites must precede concepts in the curriculum outline', async () => {
  const data = await notationFixture();
  const week = data.curriculum?.value.weeks[0];
  if (!week) throw new Error('Missing fixture curriculum week');
  week.concepts = [
    'derivatives',
    'vectors',
    ...week.concepts.filter((id) => !['vectors', 'derivatives'].includes(id)),
  ];

  expect(validateContent(data)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: 'derivatives',
        message: 'hard prerequisite "vectors" appears later in the curriculum outline',
      }),
    ]),
  );
});

test('an outlined concept requires its hard prerequisites in the outline', async () => {
  const data = await notationFixture();
  const week = data.curriculum?.value.weeks[0];
  if (!week) throw new Error('Missing fixture curriculum week');
  week.concepts = week.concepts.filter((id) => id !== 'vectors');

  expect(validateContent(data)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: 'derivatives',
        message: 'hard prerequisite "vectors" is missing from the curriculum outline',
      }),
    ]),
  );
});

test('a concept cannot appear in multiple curriculum weeks', async () => {
  const data = await notationFixture();
  const curriculum = data.curriculum?.value;
  const firstWeek = curriculum?.weeks[0];
  if (!curriculum || !firstWeek?.concepts.includes('vectors')) {
    throw new Error('Missing fixture curriculum week');
  }
  curriculum.weeks.push({
    ...firstWeek,
    week: firstWeek.week + 1,
    concepts: ['vectors'],
  });

  expect(validateContent(data)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: 'vectors',
        message: `concept listed more than once in the curriculum (weeks ${firstWeek.week} and ${firstWeek.week + 1})`,
      }),
    ]),
  );
});

test('an outlined concept must match its week field', async () => {
  const data = await notationFixture();
  const concept = data.concepts.find(({ value }) => value.id === 'vectors');
  const week = data.curriculum?.value.weeks.find(({ concepts }) => concepts.includes('vectors'));
  if (!concept || !week) throw new Error('Missing fixture vectors concept or curriculum week');
  concept.value.week = week.week + 1;

  expect(validateContent(data)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: 'vectors',
        message: `concept week field (${week.week + 1}) does not match curriculum week (${week.week})`,
      }),
    ]),
  );
});

test('real content has no duplicate or mismatched curriculum weeks', async () => {
  const content = await loadContent('content');
  expect(content.curriculum).toBeDefined();
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
        id: 'derivatives-fixture-practice-1',
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
        id: 'linear-models-fixture-practice-1',
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
      explain:
        'This uses needle notation.\n\n**Why this is useful.** It connects the idea to the next calculation.',
      worked: 'Work.',
      problems: [],
    },
  ];
  addFinalExercise(data, 'derivatives');
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
      explain: 'A definition.\n\n**Why this is useful.** It helps recognize the notation.',
      worked: 'An example.',
      problems: [],
    },
  ];
  addFinalExercise(data, 'vectors');
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
    where_this_fits: 'This explains where the idea fits.',
    final: 'final-explain',
    knowledge_points: [
      {
        id: 'kp-one',
        title: 'First',
        explain: 'Explain.\n\n**Why this is useful.** It supports the next calculation.',
        worked: 'Work.',
        problems: ['kp-one-basics', 'template', 'fixed'],
      },
      {
        id: 'kp-two',
        title: 'Second',
        explain: 'Explain.\n\n**Why this is useful.** It supports the next calculation.',
        worked: 'Work.',
        problems: ['kp-two-basics', 'fixed'],
      },
    ],
    summary: 'Finish.',
  });
  if (!('knowledge_points' in input)) throw new Error('Expected a KP lesson fixture');
  const lesson = normalizeLesson(input, (id) => id === 'template');
  expect(lesson.blocks).toEqual([
    { kind: 'objective', md: 'Learn the idea.' },
    {
      kind: 'intuition',
      md: '### First\n\nExplain.\n\n**Why this is useful.** It supports the next calculation.',
    },
    { kind: 'worked', md: 'Work.' },
    { kind: 'check', exercise: 'fixed' },
    {
      kind: 'intuition',
      md: '### Second\n\nExplain.\n\n**Why this is useful.** It supports the next calculation.',
    },
    { kind: 'worked', md: 'Work.' },
    { kind: 'check', exercise: 'fixed' },
    { kind: 'check', exercise: 'final-explain' },
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
    final: 'final-explain',
    summary: 'Summary.',
  };
  expect(LessonSchema.safeParse({ ...base, knowledge_points: [point] }).success).toBe(false);
  expect(
    LessonSchema.safeParse({
      ...base,
      final: undefined,
      knowledge_points: [point, { ...point, id: 'kp-two' }],
    }).success,
  ).toBe(false);
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
          {
            id: `${id}-no`,
            text: 'Incorrect',
            correct: false,
            feedback: 'That choice does not match the explanation for this exercise.',
          },
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
  const basics = (id: string) =>
    ExerciseSchema.parse({
      id,
      dimension: 'conceptual',
      type: 'mc',
      role: 'basics',
      difficulty: 1,
      est_minutes: 1,
      prompt: 'What is the idea?',
      hints: [],
      solution: 'The idea is stated.',
      options: [
        { id: `${id}-yes`, text: 'The idea', correct: true, feedback: 'This states the idea.' },
        {
          id: `${id}-no`,
          text: 'A different idea',
          correct: false,
          feedback: 'That describes another idea.',
        },
      ],
    });
  const basicsExercises = [basics('kp-valid-one-basics'), basics('kp-valid-two-basics')];
  const templates = [template('kp-template-one'), template('kp-template-two')];
  data.exercises.push(
    ...[...basicsExercises, ...fixedExercises, ...templates].map((value) => ({
      value,
      concept: 'vectors',
      file: 'exercises/vectors.yaml',
    })),
  );
  lesson.value.knowledge_points = [
    {
      id: 'kp-valid-one',
      title: 'A valid point',
      explain: 'A concise explanation.\n\n**Why this is useful.** It supports the next step.',
      worked: 'This example shows a complete worked example.',
      problems: ['kp-valid-one-basics', 'kp-template-one', 'kp-fixed-one', 'kp-fixed-two'],
    },
    {
      id: 'kp-valid-two',
      title: 'Another valid point',
      explain: 'A concise explanation.\n\n**Why this is useful.** It supports the next step.',
      worked: 'This example shows another complete worked example.',
      problems: ['kp-valid-two-basics', 'kp-template-two', 'kp-fixed-three', 'kp-fixed-four'],
    },
  ];
  addFinalExercise(data, 'vectors');
  expect(validateContent(data).filter((issue) => issue.id.startsWith('kp-'))).toEqual([]);
});

test('knowledge-point lessons require a basics exercise first', async () => {
  const data = await notationFixture();
  const lesson = data.lessons.find(({ value }) => value.concept === 'vectors');
  if (!lesson?.value.knowledge_points) throw new Error('Missing vectors knowledge-point lesson');
  const point = lesson.value.knowledge_points[0];
  point.problems[0] = 'vectors-fixture-practice-1';
  expect(validateContent(data)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: point.id,
        message: 'knowledge point first problem must have basics role',
      }),
    ]),
  );
});

test('multiple-choice exercises reject option texts duplicated by case or whitespace', async () => {
  const data = await notationFixture();
  const exercise = data.exercises.find(({ value }) => value.type === 'mc');
  if (exercise?.value.type !== 'mc') throw new Error('Missing MC exercise fixture');
  const first = exercise.value.options[0];
  const second = exercise.value.options[1];
  if (!first || !second) throw new Error('Missing MC options');
  second.text = ` ${first.text.toUpperCase()} `;
  expect(validateContent(data)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: exercise.value.id,
        message: 'multiple-choice option texts must be unique',
      }),
    ]),
  );
});

test('non-diagnostic multiple-choice distractors require feedback', async () => {
  const data = await notationFixture();
  const exercise = data.exercises.find(
    ({ value }) => value.id === 'gradient-descent-fixture-review',
  );
  if (exercise?.value.type !== 'mc') throw new Error('Missing review multiple-choice fixture');
  const incorrectOption = exercise.value.options.find((option) => !option.correct);
  if (!incorrectOption) throw new Error('Missing incorrect option');
  incorrectOption.feedback = undefined;

  expect(validateContent(data)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: exercise.value.id,
        message: `incorrect option "${incorrectOption.id}" must include feedback`,
      }),
    ]),
  );
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
        {
          id: `${id}-no`,
          text: 'Incorrect',
          correct: false,
          feedback: 'That choice does not match the explanation for this exercise.',
        },
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
  addFinalExercise(data, 'vectors');
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
      expect.stringContaining('problem "vectors-magnitude" must have practice or check role'),
      expect.stringContaining('problem "derivatives-explain" belongs to "derivatives"'),
      expect.stringContaining(
        'problem "practice-one" is listed more than once across knowledge points',
      ),
      expect.stringContaining('knowledge point needs 3 fixed problems or at least 1 template'),
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
  addFinalExercise(data, 'vectors');
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
    ...(content.curriculum
      ? { curriculum: { value: content.curriculum, file: 'curriculum.yaml' } }
      : {}),
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
    papers: content.papers.map(({ contentVersion, ...value }) => ({
      value,
      file: `papers/${value.id}.yaml`,
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

function addFinalExercise(data: ContentSourceData, concept: string) {
  const lesson = data.lessons.find((entry) => entry.value.concept === concept);
  if (!lesson) throw new Error(`Missing ${concept} lesson fixture`);
  const id = `${concept}-final-explain`;
  const value = ExerciseSchema.parse({
    id,
    dimension: 'conceptual',
    type: 'explain',
    role: 'core',
    difficulty: 1,
    est_minutes: 1,
    prompt: 'Explain the idea.',
    solution: 'An explanation of the idea.',
    rubric: [{ id: 'criterion', criterion: 'Names the main idea.', weight: 1, required: true }],
    exemplar: 'The main idea is explained.',
  });
  data.exercises.push({ value, concept, file: `exercises/${concept}.yaml` });
  lesson.value.final = id;
}

test('knowledge-point final exercise rules and lesson format are validated', async () => {
  const data = await notationFixture();
  const lesson = data.lessons.find(({ value }) => value.concept === 'supervised-learning');
  if (!lesson) throw new Error('Missing supervised-learning fixture');
  expect(lesson.value.final).toBe('sl-explain-setup');
  expect(validateContent(data).some((issue) => issue.message.includes('final exercise'))).toBe(
    false,
  );

  lesson.value.final = 'vectors-magnitude';
  expect(validateContent(data).some((issue) => issue.message.includes('belong to'))).toBe(true);
  lesson.value.final = 'missing-final';
  expect(validateContent(data).some((issue) => issue.message.includes('does not exist'))).toBe(
    true,
  );
  lesson.value.final = 'dx-ml-1';
  expect(validateContent(data).some((issue) => issue.message.includes('type explain'))).toBe(true);
  expect(validateContent(data).some((issue) => issue.message.includes('core role'))).toBe(true);
  lesson.value.final = 'sl-explain-setup';
  lesson.value.knowledge_points?.[0]?.problems.push('sl-explain-setup');
  expect(validateContent(data).some((issue) => issue.message.includes('must not be listed'))).toBe(
    true,
  );

  const legacy = await notationFixture();
  const legacyLesson = legacy.lessons.find(({ value }) => value.concept === 'vectors');
  if (!legacyLesson) throw new Error('Missing vectors lesson');
  const legacyInput = LessonSchema.parse({
    concept: 'vectors',
    version: 1,
    blocks: [
      { kind: 'objective', md: 'Compute vector magnitudes.' },
      { kind: 'summary', md: 'Magnitude measures length.' },
    ],
  });
  if (!('blocks' in legacyInput)) throw new Error('Expected a legacy lesson fixture');
  legacyLesson.value = legacyInput;
  expect(
    validateContent(legacy).some(
      (issue) =>
        issue.id === 'vectors' && issue.message === 'authored lessons must use knowledge_points',
    ),
  ).toBe(true);
});

test('knowledge-point style rules count prose, math spans, and fenced code correctly', async () => {
  const data = await notationFixture();
  const lesson = data.lessons.find(({ value }) => value.concept === 'supervised-learning');
  const [invalid, valid] = lesson?.value.knowledge_points ?? [];
  if (!lesson || !invalid || !valid) throw new Error('Missing supervised-learning points');

  invalid.title = 'Rate $r$';
  invalid.explain = Array.from({ length: 301 }, () => 'word').join(' ');
  invalid.worked = 'A worked example.';
  valid.title = 'A plain title';
  valid.explain = `${Array.from({ length: 249 }, () => 'word').join(' ')} $2x$ \`\`\`txt\nignored words\n\`\`\``;
  valid.worked = 'At the stated point, compute the gradient.';

  const issues = validateContent(data);
  expect(issues).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: invalid.id,
        message: 'knowledge-point title must not contain "$"',
      }),
      expect.objectContaining({
        id: invalid.id,
        message: 'knowledge-point explain has 301 words; maximum is 300',
      }),
    ]),
  );
  expect(
    issues.some((issue) => issue.id === valid.id && issue.message.includes('explain has')),
  ).toBe(false);
});

test('lesson review dimensions require a non-template schedulable exercise', async () => {
  const data = await notationFixture();
  const mathExercises = data.exercises.filter(
    (entry) => entry.concept === 'vectors' && entry.value.dimension === 'math',
  );
  expect(mathExercises.some((entry) => 'answer_expr' in entry.value)).toBe(true);
  for (const entry of mathExercises) {
    if (!('answer_expr' in entry.value)) entry.value.role = 'diagnostic';
  }

  expect(validateContent(data)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: 'vectors',
        message: 'dimension "math" has exercises but no non-template review-compatible exercise',
      }),
    ]),
  );
});

test('SVG fences reject malformed, unsafe, inaccessible, and non-hex SVG', async () => {
  const invalidSvg = [
    '<svg viewBox="0 0 10 10" aria-label="Diagram"><rect></svg>',
    '<svg aria-label="Diagram"></svg>',
    '<svg viewBox="0 0 10 10" aria-label=""><rect/></svg>',
    '<svg viewBox="0 0 10 10" aria-label="Diagram"><script/></svg>',
    '<svg viewBox="0 0 10 10" aria-label="Diagram"><foreignObject/></svg>',
    '<svg viewBox="0 0 10 10" aria-label="Diagram"><rect onclick="go()"/></svg>',
    '<svg viewBox="0 0 10 10" aria-label="Diagram"><use href="https://example.com/a.svg"/></svg>',
    '<svg viewBox="0 0 10 10" aria-label="Diagram"><rect fill="red"/></svg>',
    '<svg viewBox="0 0 10 10" aria-label="Diagram"><rect fill="var(--brand)"/></svg>',
  ];
  for (const svg of invalidSvg) {
    const data = await notationFixture();
    const exercise = data.exercises.find(({ concept }) => concept === 'vectors');
    if (!exercise) throw new Error('Missing vector fixture exercise');
    const lesson = data.lessons.find(({ value }) => value.concept === 'vectors');
    if (!lesson) throw new Error('Missing vectors lesson fixture');
    const block = lesson.value.blocks.find((candidate) => 'md' in candidate);
    if (!block || !('md' in block)) throw new Error('Missing vectors lesson Markdown block');
    const markdown = `Diagram:\n\`\`\`svg\n${svg}\n\`\`\``;
    exercise.value.prompt = markdown;
    block.md = markdown;
    const issues = validateContent(data).filter((issue) => issue.message.startsWith('invalid SVG'));
    expect(issues.some((issue) => issue.id === exercise.value.id)).toBe(true);
    expect(issues.some((issue) => issue.id === lesson.value.concept)).toBe(true);
  }
  const valid = await notationFixture();
  const exercise = valid.exercises.find(({ concept }) => concept === 'vectors');
  if (!exercise) throw new Error('Missing vector fixture exercise');
  exercise.value.prompt =
    'Diagram:\n```svg\n<svg viewBox="0 0 10 10" aria-label="Diagram"><rect fill="#abc"/></svg>\n```';
  expect(validateContent(valid).some((issue) => issue.message.startsWith('invalid SVG'))).toBe(
    false,
  );
});

test('currency dollar markers are rejected without flagging inline math', async () => {
  const data = await notationFixture();
  const exercise = data.exercises.find(({ concept }) => concept === 'vectors');
  if (!exercise) throw new Error('Missing vector fixture exercise');
  const lesson = data.lessons.find(({ value }) => value.concept === 'vectors');
  if (!lesson) throw new Error('Missing vectors lesson fixture');
  const block = lesson.value.blocks.find((candidate) => 'md' in candidate);
  if (!block || !('md' in block)) throw new Error('Missing vectors lesson Markdown block');

  const currencyTemplate = '$' + '{{=price}}';
  for (const text of [
    'The price is $220 thousand.',
    `The price is ${currencyTemplate} thousand.`,
  ]) {
    exercise.value.prompt = text;
    block.md = text;
    const issues = validateContent(data).filter((issue) =>
      issue.message.includes('currency prices'),
    );
    expect(issues.some((issue) => issue.id === exercise.value.id)).toBe(true);
    expect(issues.some((issue) => issue.id === lesson.value.concept)).toBe(true);
  }

  const templateMath = '$' + '{{=x}}' + '$';
  exercise.value.prompt = `The expressions $2x$, $$2x$$, and ${templateMath} are valid math.`;
  block.md = `The expressions $2x$, $$2x$$, and ${templateMath} are valid math.`;
  expect(validateContent(data).some((issue) => issue.message.includes('currency prices'))).toBe(
    false,
  );
});
