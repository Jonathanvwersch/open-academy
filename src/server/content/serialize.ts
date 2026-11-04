import type { IndexedConcept, IndexedExercise, IndexedLesson, IndexedProject } from './types.js';

const privateFields = new Set([
  'answer',
  'accept',
  'regex',
  'tolerance',
  'solution',
  'hints',
  'correct',
  'category',
  'common_wrong',
  'buggy_line',
  'exemplar',
  'misconceptions',
  'feedback',
]);

function stripPrivateFields(value: unknown, omitWeight = false): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stripPrivateFields(item, omitWeight));
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  const entries = Object.entries(value).filter(([key]) => {
    return !privateFields.has(key) && !(omitWeight && key === 'weight');
  });
  return Object.fromEntries(
    entries.map(([key, item]) => [key, stripPrivateFields(item, key === 'rubric')]),
  );
}

export function serializeExercise(exercise: IndexedExercise): Record<string, unknown> {
  return stripPrivateFields(exercise) as Record<string, unknown>;
}

export function serializeLesson(lesson: IndexedLesson): Record<string, unknown> {
  return stripPrivateFields(lesson) as Record<string, unknown>;
}

export function serializeConcept(concept: IndexedConcept): Record<string, unknown> {
  return stripPrivateFields(concept) as Record<string, unknown>;
}

export function serializeProject(project: IndexedProject): Record<string, unknown> {
  return stripPrivateFields(project) as Record<string, unknown>;
}
