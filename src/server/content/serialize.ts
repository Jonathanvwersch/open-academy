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

export function serializeExercise(exercise: IndexedExercise, userId = ''): Record<string, unknown> {
  const serialized = stripPrivateFields(exercise) as Record<string, unknown>;
  serialized.hintCount = exercise.hints.length;
  serialized.hintCount = exercise.hints.length;
  const options = serialized.options;
  if (Array.isArray(options)) {
    serialized.options = [...options].sort(
      (left, right) =>
        seededOrder(userId, exercise.id, left) - seededOrder(userId, exercise.id, right),
    );
  }
  return serialized;
}

function seededOrder(userId: string, exerciseId: string, option: unknown): number {
  const id =
    typeof option === 'object' && option !== null && 'id' in option
      ? String(option.id)
      : String(option);
  const input = `${userId}:${exerciseId}:${id}`;
  let hash = 2166136261;
  for (const char of input) {
    hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  }
  return hash >>> 0;
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
