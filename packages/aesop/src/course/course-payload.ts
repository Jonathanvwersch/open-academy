import type { CourseQueueStatus } from '@academy/contracts/course';
import { orderCourseIdsBySubject } from '../course/course-order.js';
import { subjectForCourse } from '../course/index.js';
import type { ContentIndex, IndexedConcept, IndexedCourse } from '../course/types.js';
import { lowestMasteryState, masteryLabel, topicStatus } from '../graph/course-status.js';
import { courseTopicPosition } from '../graph/lesson-course-context.js';
import {
  activeCourseFor,
  compareOutlinePosition,
  courseFoundationIds,
  courseFoundations,
  createPrerequisiteChecker,
  masteryKey,
  projectReady,
} from '../graph/prerequisites.js';
import type { MasteryRecord } from '../memory/types.js';
import {
  currentPlacementCredit,
  type PlacementGrantSnapshot,
  withdrawnPlacementCredit,
} from '../placement/grants.js';
import { currentLearnerUnit, type SchedulerState } from '../planner/scheduler.js';
import type { LessonRun } from '../store/lesson-store.js';

type MasteryRecords = MasteryRecord[];
type RunRecords = LessonRun[];
type PaperStatuses = Map<string, 'not_started' | 'reading' | 'completed'>;
type ProjectStatuses = Map<string, 'not_started' | 'in_progress' | 'completed'>;
type EnrollmentStatus = 'not_started' | 'active' | 'paused' | 'completed';

export type PlacementCreditSet = ReadonlySet<string> & {
  readonly withdrawn?: ReadonlySet<string>;
};

export function placedOutConceptsFromGrants(
  grants: readonly PlacementGrantSnapshot[],
): PlacementCreditSet {
  return Object.assign(currentPlacementCredit(grants), {
    withdrawn: withdrawnPlacementCredit(grants),
  });
}

export function suggestedNextCourses(
  index: ContentIndex,
  completedCourseId: string,
  statuses: ReadonlyMap<string, EnrollmentStatus>,
) {
  const completedCourse = index.coursesById.get(completedCourseId);
  if (!completedCourse) return [];
  const completedConceptIds = new Set(completedCourse.units.flatMap((unit) => unit.concepts));
  const courseOrder = orderCourseIdsBySubject(index);
  return courseOrder
    .flatMap((courseId, order) => {
      const course = index.coursesById.get(courseId);
      if (!course || !['not_started', 'paused'].includes(statuses.get(courseId) ?? 'not_started')) {
        return [];
      }
      const topicsWithCompletedPrerequisite = new Set(
        course.units.flatMap((unit) =>
          unit.concepts.filter(
            (conceptId) =>
              !completedConceptIds.has(conceptId) &&
              index.conceptsById
                .get(conceptId)
                ?.prereqs.some(
                  (prerequisite) =>
                    prerequisite.strength === 'hard' && completedConceptIds.has(prerequisite.id),
                ),
          ),
        ),
      ).size;
      return topicsWithCompletedPrerequisite > 0
        ? [{ id: course.id, title: course.title, order, topicsWithCompletedPrerequisite }]
        : [];
    })
    .sort(
      (left, right) =>
        right.topicsWithCompletedPrerequisite - left.topicsWithCompletedPrerequisite ||
        left.order - right.order,
    )
    .slice(0, 2)
    .map(({ id, title }) => ({
      id,
      title,
      reason: `Builds on ${completedCourse.title}`,
    }));
}

export function courseTopicState(
  index: ContentIndex,
  masteryRecords: MasteryRecords,
  runs: RunRecords,
  placedOutConcepts: PlacementCreditSet,
  remediationFlags: SchedulerState['remediationFlags'] = [],
) {
  const masteryByKey = new Map(
    masteryRecords.map((record) => [masteryKey(record.conceptId, record.dimension), record]),
  );
  const runsByConcept = new Map(runs.map((run) => [run.conceptId, run]));
  const prerequisiteChecker = createPrerequisiteChecker(masteryByKey, runs, index);
  return (concept: IndexedConcept) => {
    const dimensionStates = concept.dimensions.map(
      (dimension) => masteryByKey.get(masteryKey(concept.id, dimension))?.state ?? 'not_assessed',
    );
    const run = runsByConcept.get(concept.id);
    const runStatus = run?.status;
    const status = topicStatus({
      lessonRunStatus: runStatus,
      dimensionStates,
      chainReady: prerequisiteChecker.chainReady(concept.id),
    });
    return {
      status,
      ...(runStatus === 'needs_retry'
        ? {
            retry: {
              after: run?.retryAfter?.toISOString() ?? null,
              reviewFirst: [
                ...new Set(
                  remediationFlags
                    .filter(
                      (flag) =>
                        flag.conceptId === concept.id &&
                        (flag.status === undefined || flag.status === 'open'),
                    )
                    .map((flag) => flag.targetPrereqId ?? concept.id),
                ),
              ].map((id) => ({
                id,
                title: index.conceptsById.get(id)?.title ?? id,
              })),
            },
          }
        : {}),
      dimensionStates,
      placedOut:
        status === 'complete' && runStatus === undefined && placedOutConcepts.has(concept.id),
      ...(status !== 'complete' && placedOutConcepts.withdrawn?.has(concept.id)
        ? { movedBack: true as const }
        : {}),
      missingPrereqs: prerequisiteChecker.missingFrontier(concept.id).map((id) => ({
        id,
        strength: 'hard' as const,
        done: false,
      })),
    };
  };
}

export function courseQueueStatus(
  content: ContentIndex,
  course: IndexedCourse,
  studyCourseIds: readonly string[],
  focusSubjectId: string | null,
  topicState: ReturnType<typeof courseTopicState>,
): CourseQueueStatus | null {
  if (!studyCourseIds.includes(course.id)) return null;

  const lessonedTopics = course.units.flatMap((unit) =>
    unit.concepts.flatMap((conceptId) => {
      const concept = content.conceptsById.get(conceptId);
      return concept && concept.status !== 'stub' && content.lessonsByConcept.has(conceptId)
        ? [{ concept, state: topicState(concept) }]
        : [];
    }),
  );
  if (lessonedTopics.length === 0) return { kind: 'soon' };
  if (lessonedTopics.every(({ state }) => state.status === 'complete')) {
    return { kind: 'done' };
  }

  const subject = subjectForCourse(content, course.id);
  if (focusSubjectId && focusSubjectId !== subject.id) {
    return {
      kind: 'paused',
      subjectTitle:
        content.curriculum?.subjects?.find((candidate) => candidate.id === focusSubjectId)?.title ??
        content.curriculum?.subject?.title ??
        'Courses',
    };
  }

  const orderedSubjectCourseIds = orderCourseIdsBySubject(content, studyCourseIds).filter(
    (courseId) => subjectForCourse(content, courseId).id === subject.id,
  );
  const frontCourseId = orderedSubjectCourseIds.find((courseId) => {
    const candidateCourse = content.coursesById.get(courseId);
    if (!candidateCourse) return false;
    const candidateConceptIds = new Set([
      ...candidateCourse.units.flatMap((unit) => unit.concepts),
      ...courseFoundationIds(content, courseId),
    ]);
    return [...candidateConceptIds].some((conceptId) => {
      const concept = content.conceptsById.get(conceptId);
      if (!concept || concept.status === 'stub' || !content.lessonsByConcept.has(conceptId)) {
        return false;
      }
      const status = topicState(concept).status;
      return status !== 'locked' && status !== 'complete';
    });
  });
  if (frontCourseId === course.id) return { kind: 'studying' };

  const frontCourseOrder = frontCourseId ? orderedSubjectCourseIds.indexOf(frontCourseId) : -1;
  const courseOrder = orderedSubjectCourseIds.indexOf(course.id);
  if (frontCourseId && frontCourseOrder < courseOrder) {
    const afterCourseId = orderedSubjectCourseIds
      .slice(frontCourseOrder, courseOrder)
      .reverse()
      .find((courseId) => {
        const candidateCourse = content.coursesById.get(courseId);
        return (
          candidateCourse?.units.some((unit) =>
            unit.concepts.some((conceptId) => {
              const concept = content.conceptsById.get(conceptId);
              return (
                concept !== undefined &&
                concept.status !== 'stub' &&
                content.lessonsByConcept.has(conceptId) &&
                topicState(concept).status !== 'complete'
              );
            }),
          ) ?? false
        );
      });
    const afterCourse = afterCourseId ? content.coursesById.get(afterCourseId) : undefined;
    if (afterCourse) {
      return { kind: 'after', courseId: afterCourse.id, courseTitle: afterCourse.title };
    }
  }

  const courseConceptIds = new Set(course.units.flatMap((unit) => unit.concepts));
  const unmetPrerequisiteIds = new Set(
    lessonedTopics
      .filter(({ state }) => state.status === 'locked')
      .flatMap(({ state }) =>
        state.missingPrereqs
          .filter(
            (prerequisite) =>
              prerequisite.strength === 'hard' &&
              !prerequisite.done &&
              !courseConceptIds.has(prerequisite.id),
          )
          .map((prerequisite) => prerequisite.id),
      ),
  );
  const courseTitles = [
    ...new Set(
      [...unmetPrerequisiteIds].flatMap((conceptId) => {
        const source = foundationSourceCourse(content, conceptId);
        return source ? [source.title] : [];
      }),
    ),
  ].slice(0, 3);
  return { kind: 'waiting', topicCount: unmetPrerequisiteIds.size, courseTitles };
}

function foundationSourceCourse(content: ContentIndex, conceptId: string) {
  return content.courses.find((candidate) =>
    candidate.units.some((unit) => unit.concepts.includes(conceptId)),
  );
}

function buildUnits(
  index: ContentIndex,
  course: IndexedCourse,
  masteryRecords: MasteryRecords,
  runs: RunRecords,
  paperStatuses: PaperStatuses,
  projectStatuses: ProjectStatuses,
  placedOutConcepts: PlacementCreditSet,
  remediationFlags: SchedulerState['remediationFlags'],
) {
  const topicState = courseTopicState(
    index,
    masteryRecords,
    runs,
    placedOutConcepts,
    remediationFlags,
  );
  const masteryByKey = new Map(
    masteryRecords.map((record) => [masteryKey(record.conceptId, record.dimension), record]),
  );
  const runsByConcept = new Map(runs.map((run) => [run.conceptId, run]));
  const outlineConcepts = [
    ...new Set(index.courses.flatMap((entry) => entry.units.flatMap((unit) => unit.concepts))),
  ].flatMap((id) => {
    const candidate = index.conceptsById.get(id);
    return candidate ? [candidate] : [];
  });

  return course.units.map((unit, unitIndex) => {
    const project = unit.project ? index.projectsById.get(unit.project) : undefined;
    return {
      unit: unitIndex + 1,
      title: unit.title,
      intro: unit.intro ?? '',
      project: project
        ? {
            id: project.id,
            title: project.title,
            available: projectReady(project, masteryByKey, runs, index),
            status: projectStatuses.get(project.id) ?? 'not_started',
          }
        : null,
      papers: (unit.papers ?? []).flatMap((paperId) => {
        const paper = index.papersById.get(paperId);
        return paper
          ? [
              {
                id: paper.id,
                title: paper.title,
                authors: paper.authors,
                year: paper.year,
                estMinutes: paper.est_minutes,
                status: paperStatuses.get(paper.id) ?? 'not_started',
              },
            ]
          : [];
      }),
      topics: unit.concepts.map((conceptId, topicIndex) => {
        const concept = index.conceptsById.get(conceptId);
        if (!concept) {
          return {
            number: courseTopicPosition(unitIndex, topicIndex),
            conceptId,
            title: conceptId,
            hasLesson: false,
            status: 'not_started' as const,
            mastery: 'Not started' as const,
            placedOut: false,
            buildsOn: [],
            leadsTo: [],
            leadsToMore: 0,
          };
        }
        const { status, dimensionStates, placedOut, movedBack, missingPrereqs, retry } =
          topicState(concept);
        const needs = missingPrereqs
          .sort((left, right) => compareOutlinePosition(left.id, right.id, index, course.id))
          .map((prerequisite) => ({
            id: prerequisite.id,
            title: index.conceptsById.get(prerequisite.id)?.title ?? prerequisite.id,
            ...(runsByConcept.get(prerequisite.id)?.status === 'quiz' ? { quiz: true } : {}),
          }));
        const buildsOn = [...concept.prereqs]
          .sort((left, right) => compareOutlinePosition(left.id, right.id, index, course.id))
          .map((prerequisite) => ({
            id: prerequisite.id,
            title: index.conceptsById.get(prerequisite.id)?.title ?? prerequisite.id,
          }));
        const nextConcepts = outlineConcepts.filter((candidate) =>
          candidate.prereqs.some((prerequisite) => prerequisite.id === concept.id),
        );
        return {
          number: courseTopicPosition(unitIndex, topicIndex),
          conceptId,
          title: concept.title,
          hasLesson: index.lessonsByConcept.has(concept.id),
          status,
          ...(retry ? { retry } : {}),
          mastery: masteryLabel(lowestMasteryState(dimensionStates)),
          placedOut,
          ...(movedBack ? { movedBack } : {}),
          buildsOn,
          leadsTo: nextConcepts.slice(0, 3).map((candidate) => ({
            id: candidate.id,
            title: candidate.title,
          })),
          leadsToMore: Math.max(0, nextConcepts.length - 3),
          ...(status === 'locked' ? { needs } : {}),
        };
      }),
    };
  });
}

export function buildCoursePayload(
  index: ContentIndex,
  activeCourseId: string | null | undefined,
  masteryRecords: MasteryRecords,
  runs: RunRecords,
  paperStatuses: PaperStatuses = new Map(),
  projectStatuses: ProjectStatuses = new Map(),
  placedOutConcepts: PlacementCreditSet = new Set(),
  startedCourseIds: ReadonlySet<string> = new Set(),
  courseStart: { courseId: string | null; needed: boolean; placementRunId: string | null } = {
    courseId: null,
    needed: false,
    placementRunId: null,
  },
  remediationFlags: SchedulerState['remediationFlags'] = [],
) {
  const activeCourse = activeCourseFor(index, activeCourseId);
  const resolvedCourseId = activeCourse?.id;
  const units = activeCourse
    ? buildUnits(
        index,
        activeCourse,
        masteryRecords,
        runs,
        paperStatuses,
        projectStatuses,
        placedOutConcepts,
        remediationFlags,
      )
    : [];
  const done = (topic: { status: string }) => topic.status === 'complete';
  const courses = index.courses.map((course) => {
    const topics = buildUnits(
      index,
      course,
      masteryRecords,
      runs,
      paperStatuses,
      projectStatuses,
      placedOutConcepts,
      remediationFlags,
    ).flatMap((unit) => unit.topics);
    return {
      id: course.id,
      title: course.title,
      description: course.description,
      topicsDone: topics.filter(done).length,
      topicsTotal: topics.length,
      active: course.id === resolvedCourseId,
      started: startedCourseIds.has(course.id),
    };
  });
  const topicState = courseTopicState(
    index,
    masteryRecords,
    runs,
    placedOutConcepts,
    remediationFlags,
  );
  const foundations = activeCourse
    ? courseFoundations(index, resolvedCourseId)
        .filter((concept) => topicState(concept).status !== 'complete')
        .map((concept, indexInFoundations) => {
          const source = foundationSourceCourse(index, concept.id);
          const topics = source
            ? buildUnits(
                index,
                source,
                masteryRecords,
                runs,
                paperStatuses,
                projectStatuses,
                placedOutConcepts,
                remediationFlags,
              )
                .flatMap((unit) => unit.topics)
                .filter((topic) => topic.conceptId === concept.id)
            : [];
          const topic = topics[0];
          return topic
            ? { ...topic, number: `F${indexInFoundations + 1}` }
            : {
                number: `F${indexInFoundations + 1}`,
                conceptId: concept.id,
                title: concept.title,
                hasLesson: index.lessonsByConcept.has(concept.id),
                status: 'not_started' as const,
                mastery: 'Not started' as const,
                placedOut: false,
                buildsOn: [],
                leadsTo: [],
                leadsToMore: 0,
              };
        })
    : [];
  const buildsOnByCourse = new Map<
    string,
    { courseId: string; title: string; topicCount: number; remaining: number }
  >();
  if (activeCourse) {
    for (const conceptId of courseFoundationIds(index, resolvedCourseId)) {
      const source = foundationSourceCourse(index, conceptId);
      if (!source) continue;
      const group = buildsOnByCourse.get(source.id) ?? {
        courseId: source.id,
        title: source.title,
        topicCount: 0,
        remaining: 0,
      };
      group.topicCount += 1;
      const concept = index.conceptsById.get(conceptId);
      if (concept && topicState(concept).status !== 'complete') group.remaining += 1;
      buildsOnByCourse.set(source.id, group);
    }
  }
  const courseOrder = new Map(
    orderCourseIdsBySubject(index).map((courseId, position) => [courseId, position]),
  );
  const buildsOn = [...buildsOnByCourse.values()].sort(
    (left, right) =>
      (courseOrder.get(left.courseId) ?? Number.POSITIVE_INFINITY) -
      (courseOrder.get(right.courseId) ?? Number.POSITIVE_INFINITY),
  );
  const state = {
    activeCourseId: activeCourse?.id ?? null,
    mastery: masteryRecords,
    lessonRuns: runs.map(({ conceptId, status }) => ({ conceptId, status })),
  };
  return {
    courseStart,
    course: activeCourse
      ? { id: activeCourse.id, title: activeCourse.title, description: activeCourse.description }
      : { id: '', title: '', description: '' },
    courses,
    currentUnit: currentLearnerUnit(state, index),
    buildsOn,
    foundations,
    units,
  };
}
