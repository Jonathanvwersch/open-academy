import { resolve } from 'node:path';
import { deserialize, serialize } from 'node:v8';
import { expect, test } from 'vitest';
import { buildContentIndex, subjectForCourse } from '../../src/content/index.js';
import { loadContent } from '../../src/content/load.js';
import {
  CurriculumSchema,
  ExerciseSchema,
  LessonSchema,
  normalizeLesson,
  PaperSchema,
} from '../../src/content/schemas.js';
import { serializeExercise } from '../../src/content/serialize.js';
import type { ContentIndex, ContentSourceData } from '../../src/content/types.js';
import { validateContent } from '../../src/content/validate.js';

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

function recallExerciseFixture(
  data: ContentSourceData,
  options: {
    concept?: string;
    id?: string;
    knowledgePoint?: string;
    lessonOnly?: boolean;
    template?: boolean;
  } = {},
) {
  const concept = options.concept ?? 'derivatives';
  const lesson = data.lessons.find((entry) => entry.value.concept === concept)?.value;
  const point = lesson?.knowledge_points?.[0];
  if (!point) throw new Error(`Missing ${concept} knowledge-point fixture`);
  const source = data.exercises.find(
    (entry) =>
      entry.concept === concept &&
      (options.template
        ? entry.value.type === 'numeric' && 'answer_expr' in entry.value
        : entry.value.type === 'explain'),
  );
  if (!source) throw new Error(`Missing ${options.template ? 'template' : 'explain'} fixture`);
  const value = ExerciseSchema.parse({
    ...source.value,
    id: options.id ?? `recall-${concept}`,
    role: 'recall',
    knowledge_point: options.knowledgePoint ?? point.id,
    lesson_only: options.lessonOnly ?? false,
  });
  return { value, concept, file: `exercises/${concept}.yaml` };
}

test('loads the fixture graph and builds lookup indexes', async () => {
  const content = await loadContent('tests/fixtures/content');

  expect(content.concepts).toHaveLength(10);
  expect(new Set(content.concepts.map((concept) => concept.domain))).toEqual(
    new Set(['math', 'ml']),
  );
  expect(content.conceptsById.get('matrix-products')?.status).toBe('stub');
  expect(content.conceptsById.get('switching-topic')).toMatchObject({
    id: 'switching-topic',
    title: 'Switching topic',
    domain: 'ml',
    status: 'authored',
  });
  expect(content.projectsById.has('linreg-numpy')).toBe(true);
  expect(content.courses.map(({ id }) => id)).toEqual([
    'fixture-course',
    'fixture-switching-course',
    'fixture-third-course',
  ]);
  expect(content.coursesById.get('fixture-third-course')?.units[0]?.concepts).toEqual([
    'switching-topic',
  ]);
  expect(content.coursesById.get('fixture-course')?.units[0]?.papers).toEqual([
    'fixture-paper-one',
  ]);
  expect(content.papersById.has('fixture-paper-two')).toBe(true);
  expect(content.curriculum?.subject).toEqual({
    title: 'Fixture subject',
    tutor_context: 'The learner is working through a fixture course.',
  });
  expect(subjectForCourse(content, 'fixture-course')).toEqual({
    id: 'default',
    title: 'Fixture subject',
  });
  expect(subjectForCourse(content, 'missing-course')).toEqual({
    id: 'default',
    title: 'Fixture subject',
  });
  expect(new Set(content.subjectsByCourseId.keys())).toEqual(new Set(content.coursesById.keys()));
  expect(content.sourceIndex?.sources).toEqual([
    {
      id: 'fixture-notes',
      title: 'Fixture notes',
      file: 'notes-not-present.md',
      kind: 'notes',
      added: '2026-11-14',
    },
  ]);
  expect(content.lessonsByConcept.get('derivatives')?.sources).toEqual([
    { source: 'fixture-notes', section: 'Chapter 1' },
  ]);
  expect(content.edges).toContainEqual({
    conceptId: 'gradient-descent',
    prerequisiteId: 'gradients',
    strength: 'hard',
  });
  expect(content.exercisesByConcept.get('vectors')).toHaveLength(15);
  expect(content.exercisesById.get('vectors-magnitude')?.lesson_only).toBe(false);
  expect(content.exercisesByDimension.get('math')?.length).toBeGreaterThan(0);
  expect(content.exercisesByRole.get('diagnostic')?.length).toBe(9);
  expect(content.exercisesById.get('switching-topic-1')).toMatchObject({
    concept: 'switching-topic',
    role: 'diagnostic',
  });
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

test('confused_with rejects unknown concepts and self-references', async () => {
  const unknownReference = await notationFixture();
  const unknownConcept = unknownReference.concepts.find(({ value }) => value.id === 'vectors');
  if (!unknownConcept) throw new Error('Missing vectors fixture');
  unknownConcept.value.confused_with = ['unknown-concept'];

  expect(validateContent(unknownReference)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: 'vectors',
        message: 'unknown confused-with concept "unknown-concept"',
      }),
    ]),
  );

  const selfReference = await notationFixture();
  const selfConcept = selfReference.concepts.find(({ value }) => value.id === 'vectors');
  if (!selfConcept) throw new Error('Missing vectors fixture');
  selfConcept.value.confused_with = ['vectors'];

  expect(validateContent(selfReference)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: 'vectors',
        message: 'concept cannot be confused with itself',
      }),
    ]),
  );
});

test('confusable topic index is symmetric when only one concept lists the pair', async () => {
  const data = await notationFixture();
  const vectors = data.concepts.find(({ value }) => value.id === 'vectors');
  if (!vectors) throw new Error('Missing vectors fixture');
  vectors.value.confused_with = ['derivatives'];

  const index = buildContentIndex(data);

  expect(index.confusablesById.get('vectors')).toEqual(new Set(['derivatives']));
  expect(index.confusablesById.get('derivatives')).toEqual(new Set(['vectors']));
});

test('exercise target_seconds must be an integer from 5 to 600', () => {
  const exercise = {
    id: 'targeted-question',
    dimension: 'math',
    role: 'core',
    difficulty: 1,
    est_minutes: 1,
    prompt: 'What is 1 + 1?',
    hints: [],
    solution: 'Add the two values.',
    type: 'numeric',
    answer: 2,
    tolerance: {},
  };

  expect(ExerciseSchema.safeParse({ ...exercise, target_seconds: 5 }).success).toBe(true);
  expect(ExerciseSchema.safeParse({ ...exercise, target_seconds: 600 }).success).toBe(true);
  expect(ExerciseSchema.safeParse({ ...exercise, target_seconds: 4 }).success).toBe(false);
  expect(ExerciseSchema.safeParse({ ...exercise, target_seconds: 601 }).success).toBe(false);
  expect(ExerciseSchema.safeParse({ ...exercise, target_seconds: 5.5 }).success).toBe(false);
});

// Loading the full curriculum can exceed Vitest's five-second default on CI runners.
test('real content indexes round-trip with subject and confusable lookups intact', {
  timeout: 30_000,
}, async () => {
  const loadedContent = await loadContent('content');
  const content = buildContentIndex(sourceDataFromIndex(loadedContent));
  const roundTripped = deserialize(serialize(content)) as ContentIndex;
  const expectedPairs = [
    ['backpropagation', 'autodiff'],
    ['determinants', 'rank-span'],
    ['logistic-regression', 'classification-softmax'],
    ['rlhf', 'dpo'],
    ['sgd-minibatch', 'momentum-adam'],
    ['value-functions', 'q-learning'],
  ] as const;
  const listedPairs = loadedContent.concepts.flatMap(({ id, confused_with }) =>
    (confused_with ?? []).map((confusedId) => `${id}:${confusedId}`),
  );

  expect(roundTripped.subjectsByCourseId).toBeInstanceOf(Map);
  expect(roundTripped.confusablesById).toEqual(content.confusablesById);
  expect(listedPairs.sort()).toEqual(
    expectedPairs.map(([conceptId, confusedId]) => `${conceptId}:${confusedId}`).sort(),
  );
  for (const [conceptId, confusedId] of expectedPairs) {
    expect(roundTripped.confusablesById.get(conceptId)).toEqual(new Set([confusedId]));
    expect(roundTripped.confusablesById.get(confusedId)).toEqual(new Set([conceptId]));
  }
  expect(roundTripped.courses.map(({ id }) => id)).toEqual(content.courses.map(({ id }) => id));
  for (const course of loadedContent.courses) {
    expect(subjectForCourse(roundTripped, course.id)).toEqual(
      subjectForCourse(loadedContent, course.id),
    );
  }
});

test('source citations reject duplicate IDs, unknown references, and grounded lessons without citations', async () => {
  const data = await notationFixture();
  expect(validateContent(data)).toEqual([]);

  const duplicateSource = structuredClone(data);
  const source = duplicateSource.sourceIndex?.value.sources[0];
  if (!source || !duplicateSource.sourceIndex) throw new Error('Missing source fixture');
  duplicateSource.sourceIndex.value.sources.push({ ...source });
  expect(validateContent(duplicateSource)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: 'fixture-notes', message: 'duplicate source id' }),
    ]),
  );

  const unknownCitation = structuredClone(data);
  const citedLesson = unknownCitation.lessons.find(({ value }) => value.concept === 'derivatives');
  if (!citedLesson) throw new Error('Missing cited lesson');
  citedLesson.value.sources = [{ source: 'unknown-source' }];
  expect(validateContent(unknownCitation)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: 'derivatives',
        message: 'lesson cites unknown source "unknown-source"',
      }),
    ]),
  );

  const missingCitation = structuredClone(data);
  const groundedLesson = missingCitation.lessons.find(
    ({ value }) => value.concept === 'derivatives',
  );
  if (!groundedLesson || !missingCitation.curriculum) throw new Error('Missing grounded lesson');
  groundedLesson.value.sources = [];
  expect(validateContent(missingCitation)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: 'derivatives',
        message: 'grounded curriculum requires at least one source citation in the "sources" field',
      }),
    ]),
  );
});

test('real authored papers load and every course unit has reading', async () => {
  const content = await loadContent('content');

  expect(content.papers.length).toBeGreaterThan(0);
  expect(content.papersById.size).toBe(content.papers.length);
  const units = content.courses.flatMap((course) => course.units);
  expect(units.every((unit) => (unit.papers?.length ?? 0) > 0)).toBe(true);
  expect(new Set(units.flatMap((unit) => unit.papers ?? []))).toEqual(
    new Set(content.papers.map((paper) => paper.id)),
  );
});

test('a paper can be assigned to multiple course units', async () => {
  const data = await notationFixture();
  const course = required(data.courses[0], 'course');
  const unit = required(course.value.units[0], 'unit');
  const secondUnit = required(course.value.units[1], 'second unit');
  const paperId = required(unit.papers?.[0], 'paper assignment');
  secondUnit.papers = [...(secondUnit.papers ?? []), paperId];
  expect(validateContent(data)).toEqual([]);
});

test('course subjects must match the ordered curriculum subjects when configured', async () => {
  const valid = await notationFixture();
  if (!valid.curriculum) throw new Error('Missing curriculum fixture');
  valid.curriculum.value.subjects = [{ id: 'science', title: 'Science' }];
  for (const course of valid.courses) course.value.subject = 'science';
  expect(validateContent(valid)).toEqual([]);

  const unknownSubject = structuredClone(valid);
  const firstCourse = required(unknownSubject.courses[0], 'course');
  firstCourse.value.subject = 'history';
  expect(validateContent(unknownSubject)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: firstCourse.value.id,
        message: 'course references unknown subject "history"',
      }),
    ]),
  );

  const unexpectedSubject = structuredClone(valid);
  const firstUnexpectedCourse = required(unexpectedSubject.courses[0], 'course');
  if (!unexpectedSubject.curriculum) throw new Error('Missing curriculum fixture');
  delete unexpectedSubject.curriculum.value.subjects;
  expect(validateContent(unexpectedSubject)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: firstUnexpectedCourse.value.id,
        message: 'course subject requires curriculum.subjects',
      }),
    ]),
  );

  const emptySubjects = structuredClone(valid);
  if (!emptySubjects.curriculum) throw new Error('Missing curriculum fixture');
  emptySubjects.curriculum.value.subjects = [];
  delete required(emptySubjects.courses[0], 'course').value.subject;
  expect(validateContent(emptySubjects)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ message: 'course must name a curriculum subject' }),
    ]),
  );

  const duplicateSubjects = CurriculumSchema.safeParse({
    ...valid.curriculum.value,
    subjects: [
      { id: 'science', title: 'Science' },
      { id: 'science', title: 'Science duplicate' },
    ],
  });
  expect(duplicateSubjects.success).toBe(false);
});

test.each([
  'arxiv.org',
  'homes.cs.washington.edu',
  'proceedings.neurips.cc',
  'people.math.harvard.edu',
])('paper validation accepts HTTPS PDFs on %s', async (host) => {
  const data = await notationFixture();
  firstPaper(data).value.source = { url: `https://${host}/paper.pdf` };
  expect(validateContent(data)).toEqual([]);
});

test.each([
  'http://proceedings.neurips.cc/paper.pdf',
  'https://people.math.harvard.edu.example.com/paper.pdf',
  'https://proceedings.neurips.cc/paper.html',
])('paper validation rejects unsafe PDF URL %s', async (url) => {
  const data = await notationFixture();
  firstPaper(data).value.source = { url };
  expect(validateContent(data).some((issue) => issue.message.includes('paper URL must be'))).toBe(
    true,
  );
});

test('authored Gaussian project loads with unit prerequisites and reflection exercises', async () => {
  const content = await loadContent('content');
  const project = required(content.projectsById.get('gaussian-mle'), 'Gaussian project');
  const course = required(
    content.courses.find((candidate) => candidate.id === 'maths-for-ml'),
    'maths course',
  );
  const unit = required(
    course.units.find((candidate) => candidate.project === 'gaussian-mle'),
    'probability unit',
  );

  expect(project.status).toBe('authored');
  expect(project.prereqs).toEqual(unit.concepts);
  expect(project.tests).toHaveLength(11);
  expect(project.reflection).toEqual([
    'lab-gauss-front-factor',
    'lab-gauss-held-out-gap',
    'lab-gauss-forecast-gap',
  ]);
  for (const id of project.reflection) {
    const exercise = required(content.exercisesById.get(id), id);
    expect(exercise.lesson_only).toBeFalsy();
  }
});

test('authored neural-network project loads with its reflection exercises', async () => {
  const content = await loadContent('content');
  const project = required(content.projectsById.get('nn-from-scratch'), 'neural-network project');

  expect(project.status).toBe('authored');
  expect(project.prereqs).toEqual(['mlp-forward-pass', 'backpropagation']);
  expect(project.reflection).toEqual([
    'lab-nn-gradient-check-eps',
    'lab-nn-linear-baseline',
    'lab-nn-zero-initialization',
  ]);
  expect(project.tests).toHaveLength(8);

  const gradientCheck = required(
    content.exercisesById.get('lab-nn-gradient-check-eps'),
    'gradient-check reflection',
  );
  if (gradientCheck.type !== 'mc') {
    throw new Error('Gradient-check reflection must be multiple choice');
  }
  expect(
    gradientCheck.options.filter((option) => option.correct).map((option) => option.id),
  ).toEqual(['a']);

  const linearBaseline = required(
    content.exercisesById.get('lab-nn-linear-baseline'),
    'linear-baseline reflection',
  );
  if (linearBaseline.type !== 'mc') {
    throw new Error('Linear-baseline reflection must be multiple choice');
  }
  expect(
    linearBaseline.options.filter((option) => option.correct).map((option) => option.id),
  ).toEqual(['a']);

  const zeroInitialization = required(
    content.exercisesById.get('lab-nn-zero-initialization'),
    'zero-initialization reflection',
  );
  if (zeroInitialization.type !== 'explain') {
    throw new Error('Zero-initialization reflection must be explain type');
  }
  expect(zeroInitialization.rubric.map((criterion) => criterion.id)).toEqual([
    'inactive-relu',
    'symmetry',
    'output-bias',
  ]);
  expect(zeroInitialization.exemplar).toContain('ReLU output is $0$');
  expect(zeroInitialization.exemplar).toContain(
    'the slope passed back through each hidden ReLU is $0$',
  );
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
    courses: [],
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

test('knowledge-point recap rejects a concept that is not a prerequisite', async () => {
  const data = await notationFixture();
  const lesson = data.lessons.find(({ value }) => value.concept === 'derivatives');
  if (!lesson || !('knowledge_points' in lesson.value))
    throw new Error('Missing derivatives lesson');
  lesson.value.recap = [{ concept: 'gradients', text: 'A recap fact.' }];

  expect(validateContent(data)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: 'derivatives',
        message: 'lesson recap concept "gradients" is not a prerequisite',
      }),
    ]),
  );
});

test('knowledge-point recap requires an authored prerequisite lesson', async () => {
  const data = await notationFixture();
  const lesson = data.lessons.find(({ value }) => value.concept === 'derivatives');
  const concept = data.concepts.find(({ value }) => value.id === 'derivatives');
  if (!lesson || !('knowledge_points' in lesson.value) || !concept) {
    throw new Error('Missing derivatives fixture');
  }
  concept.value.prereqs.push({ id: 'matrix-products', strength: 'soft' });
  lesson.value.recap = [
    { concept: 'vectors', text: 'Vectors have magnitude and direction.' },
    { concept: 'matrix-products', text: 'This prerequisite has no authored lesson.' },
  ];

  expect(validateContent(data)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: 'derivatives',
        message: 'lesson recap concept "matrix-products" has no authored lesson',
      }),
    ]),
  );
});

test('knowledge-point recap rejects duplicate prerequisite concepts', async () => {
  const data = await notationFixture();
  const lesson = data.lessons.find(({ value }) => value.concept === 'derivatives');
  if (!lesson || !('knowledge_points' in lesson.value))
    throw new Error('Missing derivatives lesson');
  lesson.value.recap = [
    { concept: 'vectors', text: 'Vectors have magnitude and direction.' },
    { concept: 'vectors', text: 'A vector is a list of numbers.' },
  ];

  expect(validateContent(data)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: 'derivatives',
        message: 'lesson recap concept "vectors" is listed more than once',
      }),
    ]),
  );
});

test('knowledge-point recap requires an entry for every authored prerequisite', async () => {
  const data = await notationFixture();
  const lesson = data.lessons.find(({ value }) => value.concept === 'derivatives');
  const concept = data.concepts.find(({ value }) => value.id === 'derivatives');
  if (!lesson || !('knowledge_points' in lesson.value) || !concept) {
    throw new Error('Missing derivatives fixture');
  }
  concept.value.prereqs.push({ id: 'linear-models', strength: 'soft' });
  lesson.value.recap = [{ concept: 'vectors', text: 'Vectors have magnitude and direction.' }];

  expect(validateContent(data)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: 'derivatives',
        message: 'lesson recap for prerequisite "linear-models" is missing',
      }),
    ]),
  );
});

test('knowledge-point recap is limited to 40 words', async () => {
  const data = await notationFixture();
  const lesson = data.lessons.find(({ value }) => value.concept === 'derivatives');
  if (!lesson || !('knowledge_points' in lesson.value))
    throw new Error('Missing derivatives lesson');
  lesson.value.recap = [
    { concept: 'vectors', text: Array.from({ length: 41 }, () => 'word').join(' ') },
  ];

  expect(validateContent(data)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: 'derivatives',
        message: 'lesson recap for concept "vectors" has 41 words; maximum is 40',
      }),
    ]),
  );
});

test('knowledge-point lesson accepts recaps for every authored prerequisite', async () => {
  const data = await notationFixture();
  const lesson = data.lessons.find(({ value }) => value.concept === 'derivatives');
  if (!lesson || !('knowledge_points' in lesson.value))
    throw new Error('Missing derivatives lesson');
  lesson.value.recap = [{ concept: 'vectors', text: 'Vectors have magnitude and direction.' }];

  expect(
    validateContent(data).filter(
      (issue) => issue.id === 'derivatives' && issue.message.includes('recap'),
    ),
  ).toEqual([]);
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

test('in-course hard prerequisites must precede concepts in the course outline', async () => {
  const data = await notationFixture();
  const course = data.courses.find(({ value }) => value.id === 'fixture-course')?.value;
  const unit = course?.units[0];
  if (!unit) throw new Error('Missing fixture course unit');
  unit.concepts = [
    'derivatives',
    'vectors',
    ...unit.concepts.filter((id) => !['vectors', 'derivatives'].includes(id)),
  ];

  expect(validateContent(data)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: 'derivatives',
        message: 'hard prerequisite "vectors" appears later in course outline',
      }),
    ]),
  );
});

test('a hard prerequisite outside a course is allowed as a foundation', async () => {
  const data = await notationFixture();
  const course = data.courses.find(({ value }) => value.id === 'fixture-course')?.value;
  if (!course) throw new Error('Missing fixture course');
  course.units = course.units.map((unit) => ({
    ...unit,
    concepts: unit.concepts.filter((id) => id !== 'vectors'),
  }));

  expect(validateContent(data)).not.toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: 'derivatives',
        message: expect.stringContaining('prerequisite'),
      }),
    ]),
  );
});

test('a concept cannot appear more than once within one course', async () => {
  const data = await notationFixture();
  const course = data.courses.find(({ value }) => value.id === 'fixture-course')?.value;
  const unit = course?.units[1];
  if (!unit) throw new Error('Missing fixture second unit');
  unit.concepts.push('vectors');

  expect(validateContent(data)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: 'fixture-course',
        message: 'concept "vectors" appears more than once in this course',
      }),
    ]),
  );
});

test('course files have unique IDs and must be listed by the curriculum', async () => {
  const data = await notationFixture();
  const firstCourse = data.courses.find(({ value }) => value.id === 'fixture-course');
  if (!firstCourse) throw new Error('Missing fixture course');
  data.courses.push({ ...firstCourse, file: 'courses/duplicate.yaml' });
  data.courses.push({
    value: {
      id: 'unlisted-course',
      title: 'Unlisted',
      description: '',
      units: [{ title: 'Unlisted', concepts: ['vectors'] }],
    },
    file: 'courses/unlisted-course.yaml',
  });
  data.curriculum?.value.courses.push('missing-file-course', 'fixture-course');

  const issues = validateContent(data);
  expect(issues).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: 'fixture-course', message: 'duplicate course id' }),
      expect.objectContaining({
        id: 'unlisted-course',
        message: 'course id is not listed in curriculum',
      }),
      expect.objectContaining({
        id: 'missing-file-course',
        message: 'course is listed but has no course file',
      }),
      expect.objectContaining({ id: 'fixture-course', message: 'duplicate course in curriculum' }),
    ]),
  );
});

test('the default course must exist in the listed course files', async () => {
  const data = await notationFixture();
  if (!data.curriculum) throw new Error('Missing fixture curriculum');
  data.curriculum.value.default_course = 'missing-course';
  expect(validateContent(data)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: 'missing-course',
        message: 'default_course is not a listed course',
      }),
    ]),
  );
});

test('course units must reference existing concepts, projects, and papers', async () => {
  const data = await notationFixture();
  const course = data.courses.find(({ value }) => value.id === 'fixture-course')?.value;
  const unit = course?.units[0];
  if (!unit) throw new Error('Missing fixture course unit');
  unit.concepts.push('missing-concept');
  unit.project = 'missing-project';
  unit.papers?.push('missing-paper');

  const messages = validateContent(data).map(({ message }) => message);
  expect(messages).toContain('unit 1 references unknown concept "missing-concept"');
  expect(messages).toContain('unit 1 references unknown project "missing-project"');
  expect(messages).toContain('unit 1 references unknown paper "missing-paper"');
});

test('every concept, project, and paper must appear in at least one course unit', async () => {
  const data = await notationFixture();
  for (const { value } of data.courses) {
    value.units = value.units.map((unit) => ({
      ...unit,
      concepts: unit.concepts.filter((id) => id !== 'vectors'),
      project: unit.project === 'linreg-numpy' ? 'optimization-project' : unit.project,
      papers: (unit.papers ?? []).filter((id) => id !== 'fixture-paper-one'),
    }));
  }
  const issues = validateContent(data);
  expect(issues).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: 'vectors', message: 'concept is not listed in any course' }),
      expect.objectContaining({
        id: 'linreg-numpy',
        message: 'project is not assigned to a course unit',
      }),
      expect.objectContaining({
        id: 'fixture-paper-one',
        message: 'paper is not assigned to a course unit',
      }),
    ]),
  );
});

test('real content has a valid course graph', async () => {
  const content = await loadContent('content');
  expect(content.courses).toHaveLength(6);
});

test.each([
  { requiredCount: 2, totalCount: 2 },
  { requiredCount: 2, totalCount: 4 },
  { requiredCount: 4, totalCount: 4 },
  { requiredCount: 4, totalCount: 6 },
])(
  'explain rubric accepts $requiredCount required and $totalCount total criteria',
  async ({ requiredCount, totalCount }) => {
    const data = await notationFixture();
    const exercise = required(
      data.exercises.find(({ value }) => value.id === 'derivatives-explain'),
      'explain exercise',
    );
    if (exercise.value.type !== 'explain') throw new Error('Expected explain fixture');
    exercise.value.rubric = Array.from({ length: totalCount }, (_, index) => ({
      id: `criterion-${index + 1}`,
      criterion: `Explain point ${index + 1}.`,
      weight: 1,
      required: index < requiredCount,
    }));

    expect(validateContent(data)).toEqual([]);
  },
);

test.each([
  { requiredCount: 5, totalCount: 5 },
  { requiredCount: 4, totalCount: 7 },
  { requiredCount: 5, totalCount: 7 },
  { requiredCount: 0, totalCount: 7 },
])(
  'explain rubric rejects $requiredCount required and $totalCount total criteria',
  async ({ requiredCount, totalCount }) => {
    const data = await notationFixture();
    const exercise = required(
      data.exercises.find(({ value }) => value.id === 'derivatives-explain'),
      'explain exercise',
    );
    if (exercise.value.type !== 'explain') throw new Error('Expected explain fixture');
    exercise.value.rubric = Array.from({ length: totalCount }, (_, index) => ({
      id: `criterion-${index + 1}`,
      criterion: `Explain point ${index + 1}.`,
      weight: 1,
      required: index < requiredCount,
    }));

    expect(validateContent(data)).toEqual([
      {
        file: exercise.file,
        id: exercise.value.id,
        message: `explain rubric has ${requiredCount} required and ${totalCount} total criteria; limits are 4 required and 6 total`,
      },
    ]);
  },
);

test('avoid patterns report prohibited words in learner prompts with their source location', async () => {
  const data = await notationFixture();
  addAvoidPattern(data);
  const exercise = data.exercises.find((entry) => entry.concept === 'derivatives');
  if (!exercise) throw new Error('Missing fixture derivatives exercise');
  exercise.value.prompt = 'Train with lr = 0.1.';

  expect(validateContent(data)).toContainEqual({
    file: exercise.file,
    id: exercise.value.id,
    message: '"lr": write "learning rate" or $\\eta$',
  });
});

test('avoid patterns ignore code spans, fenced code, code fields, and IDs', async () => {
  const data = await notationFixture();
  addAvoidPattern(data);
  const exercise = data.exercises.find((entry) => entry.concept === 'derivatives');
  if (!exercise) throw new Error('Missing fixture derivatives exercise');
  exercise.value.id = 'lr-foo';
  exercise.value.prompt =
    'Use `lr = 0.1` and the value {{=lr}}.\n\n```python\nlr = 0.1\n```\n\n~~~python\nlr = 0.2\n~~~';
  const codeExercise = data.exercises.find(({ value }) => value.type === 'debug');
  if (codeExercise?.value.type !== 'debug') {
    throw new Error('Missing fixture debug exercise');
  }
  codeExercise.value.code = 'lr = 0.1';

  expect(validateContent(data)).not.toContainEqual(
    expect.objectContaining({ message: '"lr": write "learning rate" or $\\eta$' }),
  );
});

test('avoid patterns ignore recall knowledge-point metadata and still inspect prompts', async () => {
  const data = await notationFixture();
  addAvoidPattern(data);
  const lesson = data.lessons.find((entry) => entry.value.concept === 'derivatives')?.value;
  const point = lesson?.knowledge_points?.[0];
  if (!point) throw new Error('Missing derivatives knowledge-point fixture');
  point.id = 'lr-point';
  const recall = recallExerciseFixture(data);
  data.exercises.push(recall);

  expect(validateContent(data).filter((issue) => issue.id === recall.value.id)).toEqual([]);

  recall.value.prompt = 'Train with lr = 0.1.';
  expect(validateContent(data)).toContainEqual({
    file: recall.file,
    id: recall.value.id,
    message: '"lr": write "learning rate" or $\\eta$',
  });
});

test('avoid patterns inspect lesson and project prose', async () => {
  const data = await notationFixture();
  addAvoidPattern(data);
  const lesson = data.lessons.find(({ value }) => value.concept === 'derivatives');
  const lessonBlock = lesson?.value.blocks.find((block) => 'md' in block);
  const project = data.projects[0];
  if (!lesson || !lessonBlock || !('md' in lessonBlock) || !project) {
    throw new Error('Missing fixture lesson or project');
  }
  lessonBlock.md = 'Train with lr = 0.1.';
  project.value.tasks.push({
    id: 'avoid-test-task',
    title: 'Training',
    md: 'Train with lr = 0.1.',
  });

  expect(validateContent(data)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        file: lesson.file,
        id: lesson.value.concept,
        message: '"lr": write "learning rate" or $\\eta$',
      }),
      expect.objectContaining({
        file: project.file,
        id: project.value.id,
        message: '"lr": write "learning rate" or $\\eta$',
      }),
    ]),
  );
});

test('an absent avoid list does not reject otherwise allowed prose', async () => {
  const data = await notationFixture();
  data.notation = { file: 'notation.yaml', value: { terms: [] } };
  const exercise = data.exercises.find((entry) => entry.concept === 'derivatives');
  if (!exercise) throw new Error('Missing fixture derivatives exercise');
  exercise.value.prompt = 'Train with lr = 0.1.';

  expect(validateContent(data)).not.toContainEqual(
    expect.objectContaining({ message: '"lr": write "learning rate" or $\\eta$' }),
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
        id: 'derivatives-fixture-practice-1',
        message: expect.stringMatching(
          /^uses needle notation but none of vectors is a hard prerequisite; near ".+"\. Add one of them as a prerequisite$/,
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
        message: expect.stringMatching(
          /^uses needle notation but none of vectors is a hard prerequisite; near ".+"\. Add one of them as a prerequisite$/,
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
    recap: [{ concept: 'vectors', text: 'Vectors have magnitude and direction.' }],
    knowledge_points: [
      {
        id: 'kp-one',
        title: 'First',
        tldr: 'A short summary.',
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
  expect(lesson.recap).toEqual([
    { concept: 'vectors', text: 'Vectors have magnitude and direction.' },
  ]);
  expect(lesson.blocks).toEqual([
    { kind: 'objective', md: 'Learn the idea.' },
    { kind: 'tldr', md: 'A short summary.' },
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

test('knowledge-point lesson schema requires between one and four points', () => {
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
    where_this_fits: 'The lesson context.',
    final: 'final-explain',
    summary: 'Summary.',
  };
  expect(
    LessonSchema.safeParse({
      ...base,
      knowledge_points: [{ ...point, problems: ['concept-question'] }],
    }).success,
  ).toBe(true);
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
        lesson_only: id === 'kp-fixed-one' || id === 'kp-fixed-three',
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

test('recall exercise schema requires knowledge_point only for recall roles', async () => {
  const data = await notationFixture();
  const recall = recallExerciseFixture(data);

  expect(recall.value.type).toBe('explain');
  expect(ExerciseSchema.safeParse({ ...recall.value, knowledge_point: undefined }).success).toBe(
    false,
  );
  expect(ExerciseSchema.safeParse({ ...recall.value, role: 'core' }).success).toBe(false);
});

test('valid explain recall exercise references a knowledge point in its concept lesson', async () => {
  const data = await notationFixture();
  const recall = recallExerciseFixture(data);
  data.exercises.push(recall);

  expect(validateContent(data).filter((issue) => issue.id === recall.value.id)).toEqual([]);
});

test('recall exercise knowledge_point must belong to the concept lesson', async () => {
  const data = await notationFixture();
  const otherLesson = data.lessons.find((entry) => entry.value.concept === 'vectors')?.value;
  const otherPoint = otherLesson?.knowledge_points?.[0];
  if (!otherPoint) throw new Error('Missing vectors knowledge-point fixture');
  const recall = recallExerciseFixture(data, { knowledgePoint: otherPoint.id });
  data.exercises.push(recall);

  expect(validateContent(data)).toContainEqual(
    expect.objectContaining({
      id: recall.value.id,
      message: expect.stringContaining("must reference a knowledge point in its concept's lesson"),
    }),
  );
});

test('recall exercises cannot be referenced by knowledge-point problems', async () => {
  const data = await notationFixture();
  const recall = recallExerciseFixture(data);
  const lesson = data.lessons.find((entry) => entry.value.concept === recall.concept)?.value;
  const point = lesson?.knowledge_points?.[0];
  if (!point) throw new Error('Missing recall knowledge-point fixture');
  data.exercises.push(recall);
  point.problems.push(recall.value.id);

  expect(validateContent(data)).toContainEqual(
    expect.objectContaining({
      id: recall.value.id,
      message: 'recall exercise must not be referenced by knowledge-point problems',
    }),
  );
});

test('recall exercises cannot be lesson_only', async () => {
  const data = await notationFixture();
  const recall = recallExerciseFixture(data, { lessonOnly: true });
  data.exercises.push(recall);

  expect(validateContent(data)).toContainEqual(
    expect.objectContaining({
      id: recall.value.id,
      message: 'recall exercise must not be lesson_only',
    }),
  );
});

test('recall exercises cannot be templates', async () => {
  const data = await notationFixture();
  const recall = recallExerciseFixture(data, { concept: 'vectors', template: true });
  data.exercises.push(recall);

  expect(validateContent(data)).toContainEqual(
    expect.objectContaining({
      id: recall.value.id,
      message: 'recall exercise must not be a template',
    }),
  );
});

test('knowledge-point problem references reject explain exercises', async () => {
  const data = await notationFixture();
  const lesson = data.lessons.find(({ value }) => value.concept === 'vectors');
  if (!lesson?.value.knowledge_points) throw new Error('Missing vectors knowledge-point lesson');
  const point = lesson.value.knowledge_points[0];
  if (!point) throw new Error('Missing first vectors knowledge point');
  const explainSource = data.exercises.find(({ value }) => value.id === 'derivatives-explain');
  if (!explainSource) throw new Error('Missing explain exercise fixture');
  const explain = ExerciseSchema.parse({
    ...explainSource.value,
    id: 'vectors-kp-explain',
    prompt: 'Explain why this step works.',
  });
  data.exercises.push({
    value: explain,
    concept: 'vectors',
    file: 'exercises/vectors.yaml',
  });
  point.problems[1] = explain.id;

  expect(validateContent(data)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: point.id,
        message:
          'knowledge-point problem vectors-kp-explain is type explain; only the lesson final may be explain',
      }),
    ]),
  );
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
    template('template-bare-name', { prompt: 'Bare placeholder {{x}}' }),
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
    ['template-leftover', 'unresolved {{ placeholder'],
    ['template-bare-name', 'unresolved {{ placeholder'],
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
    ...(content.sourceIndex
      ? { sourceIndex: { value: content.sourceIndex, file: 'sources/index.yaml' } }
      : {}),
    courses: content.courses.map(({ contentVersion, ...value }) => ({
      value,
      file: `courses/${value.id}.yaml`,
    })),
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

function addAvoidPattern(data: ContentSourceData) {
  data.notation = {
    file: 'notation.yaml',
    value: {
      terms: [],
      avoid: [
        {
          pattern: '\\b[Ll][Rr]\\b',
          use: 'write "learning rate" or $\\eta$',
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
  invalid.explain = Array.from({ length: 381 }, () => 'word').join(' ');
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
        message: 'knowledge-point explain has 381 words; maximum is 380',
      }),
    ]),
  );
  expect(
    issues.some((issue) => issue.id === valid.id && issue.message.includes('explain has')),
  ).toBe(false);
});

test('every knowledge point requires a lesson-only self-explanation question', async () => {
  const valid = await notationFixture();
  const lesson = valid.lessons.find(({ value }) => value.concept === 'vectors');
  const validPoint = lesson?.value.knowledge_points?.[0];
  if (!validPoint) throw new Error('Missing vectors knowledge point');
  const message = `knowledge point "${validPoint.id}" has no lesson_only self-explanation question about its worked example`;
  expect(
    validateContent(valid).some((issue) => issue.id === validPoint.id && issue.message === message),
  ).toBe(false);

  const invalid = structuredClone(valid);
  const invalidLesson = invalid.lessons.find(({ value }) => value.concept === 'vectors');
  const invalidPoint = invalidLesson?.value.knowledge_points?.[0];
  if (!invalidPoint) throw new Error('Missing vectors knowledge point');
  for (const problemId of invalidPoint.problems) {
    const exercise = invalid.exercises.find(({ value }) => value.id === problemId);
    if (exercise) exercise.value.lesson_only = false;
  }

  expect(validateContent(invalid)).toContainEqual(
    expect.objectContaining({
      id: invalidPoint.id,
      message: `knowledge point "${invalidPoint.id}" has no lesson_only self-explanation question about its worked example`,
    }),
  );
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

test('non-diagnostic exercise prompts must be standalone or lesson-only', async () => {
  const fixture = await notationFixture();
  const contextualPrompts = [
    'Why does the worked average use this value?',
    'Step 2 multiplies the outcome by its probability.',
    'Why does the weather example subtract 1.5 from 1.75 bits?',
    'Look at the diagram picture before choosing.',
    'Why does the probability calculation subtract the baseline?',
    'The cross-entropy argument uses actual probabilities as weights.',
    "What does the example's average show?",
  ];
  for (const prompt of contextualPrompts) {
    const invalid = structuredClone(fixture);
    const invalidExercise = invalid.exercises.find(
      (entry) => entry.value.id === 'vectors-magnitude',
    );
    if (!invalidExercise) throw new Error('Missing vector magnitude exercise');
    invalidExercise.value.prompt = prompt;
    expect(validateContent(invalid)).toContainEqual(
      expect.objectContaining({
        id: invalidExercise.value.id,
        message:
          'exercise prompt references lesson-only context; set lesson_only: true or make it stand alone',
      }),
    );
  }

  const standalone = structuredClone(fixture);
  const standaloneExercise = standalone.exercises.find(
    (entry) => entry.value.id === 'vectors-magnitude',
  );
  if (!standaloneExercise) throw new Error('Missing vector magnitude exercise');
  standaloneExercise.value.prompt =
    'Why does the average of these observations match the long-run rate?';
  expect(
    validateContent(standalone).some(
      (issue) =>
        issue.id === standaloneExercise.value.id && issue.message.includes('lesson-only context'),
    ),
  ).toBe(false);

  const lessonOnly = await notationFixture();
  const lessonOnlyExercise = lessonOnly.exercises.find(
    (entry) => entry.value.id === 'vectors-magnitude',
  );
  if (!lessonOnlyExercise) throw new Error('Missing vector magnitude exercise');
  lessonOnlyExercise.value.prompt = 'In the worked example, why does this calculation work?';
  lessonOnlyExercise.value.lesson_only = true;
  expect(
    validateContent(lessonOnly).some(
      (issue) =>
        issue.id === lessonOnlyExercise.value.id && issue.message.includes('lesson-only context'),
    ),
  ).toBe(false);

  const diagnostic = await notationFixture();
  const diagnosticExercise = diagnostic.exercises.find(
    (entry) => entry.value.id === 'vectors-magnitude',
  );
  if (!diagnosticExercise) throw new Error('Missing vector magnitude exercise');
  diagnosticExercise.value.prompt = 'In the worked example, why does this calculation work?';
  diagnosticExercise.value.role = 'diagnostic';
  expect(
    validateContent(diagnostic).some(
      (issue) =>
        issue.id === diagnosticExercise.value.id && issue.message.includes('lesson-only context'),
    ),
  ).toBe(false);
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

test('visualization metadata stays allowlisted and cannot bypass SVG validation', async () => {
  for (const [meta, body, expected] of [
    [
      'academy-visual=eigen-directions',
      '<svg viewBox="0 0 10 10" aria-label="Diagram"><rect fill="#abc"/></svg>',
      undefined,
    ],
    [
      'academy-visual=untrusted-code',
      '<svg viewBox="0 0 10 10" aria-label="Diagram"/>',
      'unsupported SVG visualization metadata',
    ],
    [
      'academy-visual=eigen-directions',
      '<svg viewBox="0 0 10 10" aria-label="Diagram"><script/></svg>',
      'invalid SVG',
    ],
  ] as const) {
    const data = await notationFixture();
    const exercise = data.exercises.find(({ concept }) => concept === 'vectors');
    if (!exercise) throw new Error('Missing vectors fixture');
    exercise.value.prompt = `Diagram:\n\`\`\`svg ${meta}\n${body}\n\`\`\``;
    const issues = validateContent(data).filter(
      (issue) =>
        issue.id === exercise.value.id &&
        (issue.message.startsWith('invalid SVG') ||
          issue.message.startsWith('unsupported SVG visualization')),
    );
    if (expected) expect(issues.some((issue) => issue.message.startsWith(expected))).toBe(true);
    else expect(issues).toEqual([]);
  }
});

test('exercise prose rejects unwrapped maths and ignores inline maths and code spans', async () => {
  const data = await notationFixture();
  const explanation = data.exercises.find(({ value }) => value.type === 'explain');
  const multipleChoice = data.exercises.find(({ value }) => value.type === 'mc');
  if (explanation?.value.type !== 'explain' || multipleChoice?.value.type !== 'mc') {
    throw new Error('Missing explanation and multiple-choice fixtures');
  }
  const criterion = explanation.value.rubric[0];
  const option = multipleChoice.value.options[0];
  if (!criterion || !option) throw new Error('Missing rubric criterion and option fixtures');

  explanation.value.prompt = 'Use d_in and W₁.';
  criterion.criterion = 'Mentions ∇f.';
  explanation.value.exemplar = 'Compare θ and ‖x‖.';
  explanation.value.solution = 'Use x_1.';
  explanation.value.hints = ['Use b_k.'];
  option.text = 'The value is y_k.';
  option.feedback = 'The update uses z_1.';

  const mathIssues = validateContent(data).filter(
    (issue) => issue.message === 'plain-text maths; wrap in $…$',
  );
  expect(mathIssues.map((issue) => issue.id)).toEqual(
    expect.arrayContaining([explanation.value.id, multipleChoice.value.id]),
  );

  explanation.value.prompt = 'Use $d_\\text{in}$ and $W_1$.';
  criterion.criterion = 'Mentions $\\nabla f$.';
  explanation.value.exemplar = 'Compare $\\theta$ and $\\|x\\|$.';
  explanation.value.solution = 'Use `x_1`.';
  explanation.value.hints = ['Use $b_k$.'];
  option.text = 'The value is $y_k$.';
  option.feedback = 'The update uses `z_1`.';
  const remainingIssues = validateContent(data).filter(
    (issue) =>
      issue.message === 'plain-text maths; wrap in $…$' &&
      [explanation.value.id, multipleChoice.value.id].includes(issue.id),
  );
  expect(remainingIssues).toEqual([]);
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
