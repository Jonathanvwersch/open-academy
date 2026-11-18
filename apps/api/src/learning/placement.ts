import { isTemplate } from '../content/templates.js';
import type { ContentIndex, IndexedExercise } from '../content/types.js';
import { topicIsComplete } from './course-status.js';
import { activeCourseFor, courseFoundationIds } from './prerequisites.js';
import type { MasteryRecord } from './types.js';

export const PLACEMENT_MAX_QUESTIONS = 16;

export interface PlacementAnswer {
  conceptId: string;
  exerciseId: string;
  correct: boolean;
}

export interface PlacementState {
  courseId: string;
  answers: PlacementAnswer[];
  known: string[];
  unknown: string[];
}

export type PlacementMasteryRecord = Pick<MasteryRecord, 'conceptId' | 'dimension' | 'state'>;
export type PlacementLessonRun = {
  conceptId: string;
  status: 'in_progress' | 'needs_retry' | 'quiz' | 'completed';
};

const preferredDifficulties = [2, 3, 1];
const allowedExerciseTypes = new Set(['mc', 'numeric', 'expression']);
const allowedRoles = new Set(['diagnostic', 'check', 'core']);

export function createPlacementState(courseId: string): PlacementState {
  return { courseId, answers: [], known: [], unknown: [] };
}

export function placementConceptIds(
  courseId: string,
  content: ContentIndex,
  mastery: readonly PlacementMasteryRecord[] = [],
  lessonRuns: readonly PlacementLessonRun[] = [],
): string[] {
  const course = activeCourseFor(content, courseId);
  if (!course) return [];

  const conceptIds = [
    ...new Set([
      ...courseFoundationIds(content, course.id),
      ...course.units.flatMap((unit) => unit.concepts),
    ]),
  ];
  const masteryByConcept = new Map<string, PlacementMasteryRecord[]>();
  for (const record of mastery) {
    const records = masteryByConcept.get(record.conceptId) ?? [];
    records.push(record);
    masteryByConcept.set(record.conceptId, records);
  }
  const lessonRunConcepts = new Set(lessonRuns.map((run) => run.conceptId));

  return conceptIds.filter((conceptId) => {
    const concept = content.conceptsById.get(conceptId);
    if (!concept || concept.status === 'stub' || lessonRunConcepts.has(conceptId)) return false;
    return !topicIsComplete(
      undefined,
      concept.dimensions.map(
        (dimension) =>
          masteryByConcept.get(conceptId)?.find((record) => record.dimension === dimension)
            ?.state ?? 'not_assessed',
      ),
    );
  });
}

export function placementProbeExercise(
  conceptId: string,
  content: ContentIndex,
): IndexedExercise | undefined {
  const lesson = content.lessonsByConcept.get(conceptId);
  const candidates = lesson?.knowledge_points?.length
    ? lesson.knowledge_points.flatMap((point) =>
        point.problems.flatMap((exerciseId) => {
          const exercise = content.exercisesById.get(exerciseId);
          return exercise ? [exercise] : [];
        }),
      )
    : (content.exercisesByConcept.get(conceptId) ?? []).filter((exercise) =>
        allowedRoles.has(exercise.role),
      );
  const eligible = candidates.filter(
    (exercise) =>
      exercise.role !== 'recall' &&
      !exercise.lesson_only &&
      !isTemplate(exercise) &&
      allowedExerciseTypes.has(exercise.type),
  );

  for (const difficulty of preferredDifficulties) {
    const exercise = eligible.find((candidate) => candidate.difficulty === difficulty);
    if (exercise) return exercise;
  }
  return undefined;
}

export function nextPlacementExercise(
  state: PlacementState,
  content: ContentIndex,
  mastery: readonly PlacementMasteryRecord[] = [],
  lessonRuns: readonly PlacementLessonRun[] = [],
): IndexedExercise | undefined {
  if (state.answers.length >= PLACEMENT_MAX_QUESTIONS) return undefined;
  const determined = new Set([...state.known, ...state.unknown]);
  const answered = new Set(state.answers.map((answer) => answer.conceptId));
  const probeable = placementConceptIds(state.courseId, content, mastery, lessonRuns)
    .filter((conceptId) => !determined.has(conceptId) && !answered.has(conceptId))
    .flatMap((conceptId) => {
      const exercise = placementProbeExercise(conceptId, content);
      return exercise ? [{ conceptId, exercise }] : [];
    });
  return probeable[Math.floor(probeable.length / 2)]?.exercise;
}

export function recordPlacementAnswer(
  state: PlacementState,
  answer: PlacementAnswer,
  content: ContentIndex,
  mastery: readonly PlacementMasteryRecord[] = [],
  lessonRuns: readonly PlacementLessonRun[] = [],
): PlacementState {
  const conceptIds = placementConceptIds(state.courseId, content, mastery, lessonRuns);
  const conceptIdSet = new Set(conceptIds);
  const known = new Set(state.known);
  const unknown = new Set(state.unknown);

  if (answer.correct) {
    known.add(answer.conceptId);
    unknown.delete(answer.conceptId);
    for (const prerequisiteId of transitiveHardPrerequisites(
      answer.conceptId,
      content,
      conceptIdSet,
    )) {
      if (!known.has(prerequisiteId) && !unknown.has(prerequisiteId)) {
        known.add(prerequisiteId);
      }
    }
  } else {
    for (const dependentId of [
      answer.conceptId,
      ...transitiveHardDependents(answer.conceptId, conceptIds, content),
    ]) {
      if (!known.has(dependentId) && !unknown.has(dependentId)) {
        unknown.add(dependentId);
      }
    }
  }

  return {
    ...state,
    answers: [...state.answers, answer],
    known: [...known],
    unknown: [...unknown],
  };
}

export function placementComplete(
  state: PlacementState,
  content: ContentIndex,
  mastery: readonly PlacementMasteryRecord[] = [],
  lessonRuns: readonly PlacementLessonRun[] = [],
): boolean {
  return (
    state.answers.length >= PLACEMENT_MAX_QUESTIONS ||
    nextPlacementExercise(state, content, mastery, lessonRuns) === undefined
  );
}

function transitiveHardPrerequisites(
  conceptId: string,
  content: ContentIndex,
  conceptIds: ReadonlySet<string>,
): string[] {
  const found: string[] = [];
  const visited = new Set([conceptId]);
  const visit = (currentId: string) => {
    const concept = content.conceptsById.get(currentId);
    for (const prerequisite of concept?.prereqs ?? []) {
      if (prerequisite.strength !== 'hard' || !conceptIds.has(prerequisite.id)) continue;
      if (visited.has(prerequisite.id)) continue;
      visited.add(prerequisite.id);
      found.push(prerequisite.id);
      visit(prerequisite.id);
    }
  };
  visit(conceptId);
  return found;
}

function transitiveHardDependents(
  conceptId: string,
  conceptIds: readonly string[],
  content: ContentIndex,
): string[] {
  const found: string[] = [];
  const visited = new Set([conceptId]);
  const queue = [conceptId];
  while (queue.length > 0) {
    const prerequisiteId = queue.shift();
    if (!prerequisiteId) continue;
    for (const candidateId of conceptIds) {
      if (visited.has(candidateId)) continue;
      const candidate = content.conceptsById.get(candidateId);
      if (
        !candidate?.prereqs.some(
          (prerequisite) => prerequisite.id === prerequisiteId && prerequisite.strength === 'hard',
        )
      ) {
        continue;
      }
      visited.add(candidateId);
      found.push(candidateId);
      queue.push(candidateId);
    }
  }
  return found;
}
