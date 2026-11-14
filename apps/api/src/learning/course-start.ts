import type { ContentIndex } from '../content/types.js';
import { activeCourseFor } from './prerequisites.js';
import type { MasteryRecord } from './types.js';

export interface CourseStartStatus {
  needed: boolean;
  placementRunId: string | null;
}

export function courseHasEvidence(
  conceptIds: readonly string[],
  mastery: readonly Pick<MasteryRecord, 'conceptId' | 'state'>[],
  lessonRuns: readonly { conceptId: string }[],
): boolean {
  const courseConcepts = new Set(conceptIds);
  return (
    lessonRuns.some((run) => courseConcepts.has(run.conceptId)) ||
    mastery.some(
      (record) => courseConcepts.has(record.conceptId) && record.state !== 'not_assessed',
    )
  );
}

export function courseStartStatus(input: {
  enrolled: boolean;
  courseConceptIds: readonly string[];
  activePlacementRunId: string | null;
  mastery: readonly Pick<MasteryRecord, 'conceptId' | 'state'>[];
  lessonRuns: readonly { conceptId: string }[];
}): CourseStartStatus {
  return {
    needed:
      input.activePlacementRunId !== null ||
      (!input.enrolled &&
        !courseHasEvidence(input.courseConceptIds, input.mastery, input.lessonRuns)),
    placementRunId: input.activePlacementRunId,
  };
}

export function needsCourseChoice(input: {
  activeCourseId: string | null | undefined;
  studyCourseIds?: readonly string[];
  mastery: readonly Pick<MasteryRecord, 'state'>[];
  lessonRuns: readonly unknown[];
}): boolean {
  return (
    (input.studyCourseIds ? input.studyCourseIds.length === 0 : input.activeCourseId == null) &&
    input.lessonRuns.length === 0 &&
    !input.mastery.some((record) => record.state !== 'not_assessed')
  );
}

export function buildCourseStartState(input: {
  content: ContentIndex;
  activeCourseId: string | null | undefined;
  mastery: readonly Pick<MasteryRecord, 'conceptId' | 'state'>[];
  lessonRuns: readonly { conceptId: string }[];
  enrollments: readonly { courseId: string }[];
  placementRuns: readonly { id: string; state: unknown }[];
}) {
  const enrolledCourseIds = new Set(input.enrollments.map((enrollment) => enrollment.courseId));
  const activePlacementByCourse = new Map(
    input.placementRuns.flatMap((run) => {
      const courseId = (run.state as { courseId?: unknown }).courseId;
      return typeof courseId === 'string' ? [[courseId, run.id] as const] : [];
    }),
  );
  const statuses = new Map(
    input.content.courses.map((course) => [
      course.id,
      courseStartStatus({
        enrolled: enrolledCourseIds.has(course.id),
        courseConceptIds: course.units.flatMap((unit) => unit.concepts),
        activePlacementRunId: activePlacementByCourse.get(course.id) ?? null,
        mastery: input.mastery,
        lessonRuns: input.lessonRuns,
      }),
    ]),
  );
  const activeCourse = activeCourseFor(input.content, input.activeCourseId);
  const startedCourseIds = new Set(
    input.content.courses.flatMap((course) =>
      enrolledCourseIds.has(course.id) ||
      courseHasEvidence(
        course.units.flatMap((unit) => unit.concepts),
        input.mastery,
        input.lessonRuns,
      )
        ? [course.id]
        : [],
    ),
  );

  return {
    courseStart: activeCourse
      ? (statuses.get(activeCourse.id) ?? { needed: false, placementRunId: null })
      : { needed: false, placementRunId: null },
    startedCourseIds,
  };
}
