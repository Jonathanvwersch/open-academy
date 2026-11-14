import type { ContentIndex, IndexedConcept, IndexedCourse } from '../content/types.js';
import type { MasteryRecord } from './types.js';
import { masteryRank } from './types.js';

type LessonRun = {
  conceptId: string;
  status: 'in_progress' | 'needs_retry' | 'quiz' | 'completed';
};

export function masteryKey(conceptId: string, dimension: string): string {
  return `${conceptId}:${dimension}`;
}

export function prerequisiteMet(
  prereqId: string,
  masteryByKey: ReadonlyMap<string, Pick<MasteryRecord, 'state' | 'inferred'>>,
  lessonRuns: readonly LessonRun[],
  content: ContentIndex,
): boolean {
  const concept = content.conceptsById.get(prereqId);
  if (!concept) return false;

  const lessonRun = lessonRuns.find((run) => run.conceptId === prereqId);
  if (lessonRun) return lessonRun.status === 'completed';
  return concept.dimensions.some((dimension) => {
    const record = masteryByKey.get(masteryKey(prereqId, dimension));
    return (
      record?.inferred || masteryRank(record?.state ?? 'not_assessed') >= masteryRank('assisted')
    );
  });
}

export function activeCourseFor(
  content: ContentIndex,
  activeCourseId?: string | null,
): IndexedCourse | undefined {
  return (
    content.coursesById.get(activeCourseId ?? '') ??
    content.coursesById.get(content.curriculum?.default_course ?? '') ??
    content.courses[0]
  );
}

export function courseConceptIds(course: IndexedCourse | undefined): Set<string> {
  return new Set(course?.units.flatMap((unit) => unit.concepts) ?? []);
}

export function courseUnitPositions(
  content: ContentIndex,
  activeCourseId?: string | null,
): Map<string, number> {
  const course = activeCourseFor(content, activeCourseId);
  const courseConcepts = courseConceptIds(course);
  const positions = new Map<string, number>();
  course?.units.forEach((unit, unitIndex) => {
    for (const conceptId of unit.concepts) {
      if (!positions.has(conceptId)) positions.set(conceptId, unitIndex + 1);
    }
  });

  const visit = (conceptId: string, unitNumber: number, visited: Set<string>) => {
    if (visited.has(conceptId)) return;
    visited.add(conceptId);
    const concept = content.conceptsById.get(conceptId);
    if (!concept) return;
    for (const prerequisite of concept.prereqs) {
      if (prerequisite.strength !== 'hard') continue;
      const prerequisiteConcept = content.conceptsById.get(prerequisite.id);
      if (!prerequisiteConcept) continue;
      if (!courseConcepts.has(prerequisite.id) && prerequisiteConcept.status !== 'stub') {
        const current = positions.get(prerequisite.id);
        if (current === undefined || unitNumber < current)
          positions.set(prerequisite.id, unitNumber);
      }
      visit(prerequisite.id, unitNumber, visited);
    }
  };
  course?.units.forEach((unit, unitIndex) => {
    for (const conceptId of unit.concepts) visit(conceptId, unitIndex + 1, new Set());
  });
  return positions;
}

export function courseFoundationIds(
  content: ContentIndex,
  activeCourseId?: string | null,
): Set<string> {
  const course = activeCourseFor(content, activeCourseId);
  const courseConcepts = courseConceptIds(course);
  const positions = courseUnitPositions(content, activeCourseId);
  return new Set([...positions.keys()].filter((conceptId) => !courseConcepts.has(conceptId)));
}

export function courseFoundations(
  content: ContentIndex,
  activeCourseId?: string | null,
): IndexedConcept[] {
  const positions = courseUnitPositions(content, activeCourseId);
  return [...courseFoundationIds(content, activeCourseId)]
    .map((id) => content.conceptsById.get(id))
    .filter((concept): concept is IndexedConcept => concept !== undefined)
    .sort((left, right) => {
      const unitOrder =
        (positions.get(left.id) ?? Infinity) - (positions.get(right.id) ?? Infinity);
      if (unitOrder !== 0) return unitOrder;
      const leftPosition = outlinePosition(left.id, content, activeCourseId);
      const rightPosition = outlinePosition(right.id, content, activeCourseId);
      return leftPosition[0] - rightPosition[0] || leftPosition[1] - rightPosition[1];
    });
}

export function outlinePosition(
  conceptId: string,
  content: ContentIndex,
  activeCourseId?: string | null,
): [number, number] {
  const course = activeCourseFor(content, activeCourseId);
  for (let unitIndex = 0; unitIndex < (course?.units.length ?? 0); unitIndex += 1) {
    const topicIndex = course?.units[unitIndex]?.concepts.indexOf(conceptId) ?? -1;
    if (topicIndex >= 0) return [unitIndex, topicIndex];
  }
  let globalUnit = 0;
  for (const courseId of content.curriculum?.courses ?? []) {
    const globalCourse = content.coursesById.get(courseId);
    for (const unit of globalCourse?.units ?? []) {
      const topicIndex = unit.concepts.indexOf(conceptId);
      if (topicIndex >= 0) return [globalUnit, topicIndex];
      globalUnit += 1;
    }
  }
  return [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
}

export function compareOutlinePosition(
  leftId: string,
  rightId: string,
  content: ContentIndex,
  activeCourseId?: string | null,
): number {
  const left = outlinePosition(leftId, content, activeCourseId);
  const right = outlinePosition(rightId, content, activeCourseId);
  if (left[0] !== right[0]) return left[0] < right[0] ? -1 : 1;
  if (left[1] !== right[1]) return left[1] < right[1] ? -1 : 1;
  return 0;
}
