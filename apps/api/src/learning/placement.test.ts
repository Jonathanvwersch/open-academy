import { beforeAll, expect, test } from 'vitest';
import { loadContent } from '../content/load.js';
import { isTemplate } from '../content/templates.js';
import type { ContentIndex, IndexedExercise } from '../content/types.js';
import {
  createPlacementState,
  nextPlacementExercise,
  placementComplete,
  placementConceptIds,
  recordPlacementAnswer,
} from './placement.js';
import { initialMastery } from './types.js';

let baseContent: ContentIndex;

beforeAll(async () => {
  baseContent = await loadContent('tests/fixtures/content');
});

function makeContent(ids: string[], prerequisites: Record<string, string[]> = {}): ContentIndex {
  const baseCourse = baseContent.courses[0];
  const baseConcept = baseContent.conceptsById.get('vectors');
  const curriculum = baseContent.curriculum;
  const baseExercise = baseContent.exercises.find(
    (exercise): exercise is Extract<IndexedExercise, { type: 'mc' }> => exercise.type === 'mc',
  );
  if (!baseCourse || !baseConcept || !baseExercise || !curriculum) {
    throw new Error('Missing placement test fixture content');
  }
  const course = {
    ...baseCourse,
    id: 'placement-test',
    title: 'Placement test',
    units: [{ title: 'Placement chain', concepts: ids }],
  };
  const concepts = ids.map((id) => ({
    ...baseConcept,
    id,
    title: id,
    dimensions: ['math'] as ['math'],
    prereqs: (prerequisites[id] ?? []).map((prerequisiteId) => ({
      id: prerequisiteId,
      strength: 'hard' as const,
    })),
  }));
  const exercises = ids.map((id, index) => ({
    ...baseExercise,
    id: `probe-${id}`,
    concept: id,
    role: 'core' as const,
    difficulty: 2,
    lesson_only: false,
    contentVersion: String(index),
  }));
  return {
    ...baseContent,
    curriculum: {
      ...curriculum,
      courses: [course.id],
      default_course: course.id,
    },
    courses: [course],
    coursesById: new Map([[course.id, course]]),
    concepts,
    conceptsById: new Map(concepts.map((concept) => [concept.id, concept])),
    exercises,
    exercisesById: new Map(exercises.map((exercise) => [exercise.id, exercise])),
    exercisesByConcept: new Map(
      ids.flatMap((id, index) => {
        const exercise = exercises[index];
        return exercise ? [[id, [exercise] as IndexedExercise[]] as const] : [];
      }),
    ),
    lessons: [],
    lessonsByConcept: new Map(),
  };
}

const chain = ['a', 'b', 'c', 'd', 'e'];

test('a correct midpoint places it and its prerequisites and probes the remaining midpoint', () => {
  const content = makeContent(chain, { b: ['a'], c: ['b'], d: ['c'], e: ['d'] });
  const state = createPlacementState('placement-test');
  const exercise = nextPlacementExercise(state, content);
  expect(exercise?.id).toBe('probe-c');
  const next = recordPlacementAnswer(
    state,
    { conceptId: 'c', exerciseId: 'probe-c', correct: true },
    content,
  );
  expect(next.known).toEqual(['c', 'b', 'a']);
  expect(nextPlacementExercise(next, content)?.id).toBe('probe-e');
});

test('a wrong midpoint marks it and its hard dependents unknown', () => {
  const content = makeContent(chain, { b: ['a'], c: ['b'], d: ['c'], e: ['d'] });
  const state = recordPlacementAnswer(
    createPlacementState('placement-test'),
    { conceptId: 'c', exerciseId: 'probe-c', correct: false },
    content,
  );
  expect(state.unknown).toEqual(['c', 'd', 'e']);
});

test('placement stops at sixteen answers without crediting undetermined concepts', () => {
  const ids = Array.from({ length: 20 }, (_value, index) => `topic-${index}`);
  const content = makeContent(ids);
  let state = createPlacementState('placement-test');
  for (let index = 0; index < 16; index += 1) {
    const exercise = nextPlacementExercise(state, content);
    if (!exercise) throw new Error('Expected a placement probe');
    state = recordPlacementAnswer(
      state,
      { conceptId: exercise.concept, exerciseId: exercise.id, correct: false },
      content,
    );
  }
  expect(placementComplete(state, content)).toBe(true);
  expect(state.answers).toHaveLength(16);
  expect(state.known).toEqual([]);
  expect(
    placementConceptIds('placement-test', content).filter((id) => !state.unknown.includes(id)),
  ).toHaveLength(4);
});

test('already-complete concepts are excluded from placement', () => {
  const content = makeContent(chain);
  const complete = initialMastery('a', 'math');
  complete.state = 'assisted';
  expect(placementConceptIds('placement-test', content, [complete])).toEqual(chain.slice(1));
  expect(
    nextPlacementExercise(createPlacementState('placement-test'), content, [complete])?.id,
  ).toBe('probe-d');
});

test('concepts with lesson runs are excluded and not credited through dependents', () => {
  const content = makeContent(['a', 'b', 'c'], { b: ['a'], c: ['b'] });
  const lessonRuns = [{ conceptId: 'a', status: 'in_progress' as const }];
  expect(placementConceptIds('placement-test', content, [], lessonRuns)).toEqual(['b', 'c']);
  const state = recordPlacementAnswer(
    createPlacementState('placement-test'),
    { conceptId: 'c', exerciseId: 'probe-c', correct: true },
    content,
    [],
    lessonRuns,
  );
  expect(state.known).toEqual(['c', 'b']);
  expect(state.known).not.toContain('a');
});

test('a concept without a probe can still be placed out through a correct dependent', () => {
  const content = makeContent(['a', 'b'], { b: ['a'] });
  content.exercisesByConcept.set('a', []);
  content.exercisesById.delete('probe-a');
  const state = recordPlacementAnswer(
    createPlacementState('placement-test'),
    { conceptId: 'b', exerciseId: 'probe-b', correct: true },
    content,
  );
  expect(state.known).toEqual(['b', 'a']);
});

test('probe selection filters lesson problems and prefers difficulty two in authored order', () => {
  const content = makeContent(['a']);
  const baseMc = baseContent.exercises.find((exercise) => exercise.type === 'mc');
  const template = baseContent.exercises.find((exercise) => isTemplate(exercise));
  const text = baseContent.exercises.find((exercise) => exercise.type === 'text');
  const lesson = baseContent.lessonsByConcept.get('vectors');
  if (!baseMc || !template || !text || !lesson?.knowledge_points?.[0]) {
    throw new Error('Missing exercise selection fixture content');
  }
  const candidates = [
    { ...baseMc, id: 'wrong-type', concept: 'a', difficulty: 2, type: 'text' },
    { ...baseMc, id: 'lesson-only', concept: 'a', difficulty: 2, lesson_only: true },
    { ...template, id: 'template', concept: 'a', difficulty: 2 },
    { ...baseMc, id: 'difficulty-three', concept: 'a', difficulty: 3 },
    { ...baseMc, id: 'first-difficulty-two', concept: 'a', difficulty: 2 },
    { ...baseMc, id: 'second-difficulty-two', concept: 'a', difficulty: 2 },
  ] as IndexedExercise[];
  const problemIds = candidates.map((exercise) => exercise.id);
  content.exercisesById = new Map(candidates.map((exercise) => [exercise.id, exercise]));
  content.lessonsByConcept.set('a', {
    ...lesson,
    concept: 'a',
    knowledge_points: [{ ...lesson.knowledge_points[0], problems: problemIds }],
  });
  expect(nextPlacementExercise(createPlacementState('placement-test'), content)?.id).toBe(
    'first-difficulty-two',
  );
});

test('concept exercises are restricted to diagnostic, check and core roles', () => {
  const content = makeContent(['a']);
  const baseMc = baseContent.exercises.find((exercise) => exercise.type === 'mc');
  if (!baseMc) throw new Error('Missing MC fixture exercise');
  const candidates = [
    { ...baseMc, id: 'wrong-role', concept: 'a', role: 'transfer', difficulty: 2 },
    { ...baseMc, id: 'role-diagnostic', concept: 'a', role: 'diagnostic', difficulty: 3 },
    { ...baseMc, id: 'role-check', concept: 'a', role: 'check', difficulty: 2 },
  ] as IndexedExercise[];
  content.exercisesByConcept.set('a', candidates);
  content.exercisesById = new Map(candidates.map((exercise) => [exercise.id, exercise]));
  expect(nextPlacementExercise(createPlacementState('placement-test'), content)?.id).toBe(
    'role-check',
  );
});
