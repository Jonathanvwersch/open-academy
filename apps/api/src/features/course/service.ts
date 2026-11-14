import type { ContentIndex, IndexedCourse } from '../../content/types.js';
import type { LearnerRepository } from '../../db/repository.js';
import type { lessonRuns } from '../../db/schema.js';
import { lowestMasteryState, masteryLabel, topicStatus } from '../../learning/course-status.js';
import {
  activeCourseFor,
  compareOutlinePosition,
  courseFoundations,
  masteryKey,
  prerequisiteMet,
} from '../../learning/prerequisites.js';
import { currentLearnerUnit } from '../../learning/scheduler.js';

type MasteryRecords = Awaited<ReturnType<LearnerRepository['masteryRecords']>>;
type RunRecords = Array<typeof lessonRuns.$inferSelect>;
type PaperStatuses = Map<string, 'not_started' | 'reading' | 'completed'>;
type ProjectStatuses = Map<string, 'not_started' | 'in_progress' | 'completed'>;
type EnrollmentStatus = 'not_started' | 'active' | 'paused' | 'completed';

export function suggestedNextCourses(
  index: ContentIndex,
  completedCourseId: string,
  statuses: ReadonlyMap<string, EnrollmentStatus>,
) {
  const completedCourse = index.coursesById.get(completedCourseId);
  if (!completedCourse) return [];
  const completedConceptIds = new Set(completedCourse.units.flatMap((unit) => unit.concepts));
  const courseOrder = index.curriculum?.courses ?? index.courses.map((course) => course.id);
  return courseOrder
    .flatMap((courseId, order) => {
      const course = index.coursesById.get(courseId);
      if (!course || !['not_started', 'paused'].includes(statuses.get(courseId) ?? 'not_started')) {
        return [];
      }
      const topicsWithCompletedPrerequisite = new Set(
        course.units.flatMap((unit) =>
          unit.concepts.filter((conceptId) =>
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

function buildUnits(
  index: ContentIndex,
  course: IndexedCourse,
  masteryRecords: MasteryRecords,
  runs: RunRecords,
  paperStatuses: PaperStatuses,
  projectStatuses: ProjectStatuses,
  placedOutConcepts: ReadonlySet<string>,
) {
  const masteryByConcept = new Map<string, typeof masteryRecords>();
  for (const record of masteryRecords) {
    const records = masteryByConcept.get(record.conceptId) ?? [];
    records.push(record);
    masteryByConcept.set(record.conceptId, records);
  }
  const runsByConcept = new Map(runs.map((run) => [run.conceptId, run]));
  const masteryByKey = new Map(
    masteryRecords.map((record) => [masteryKey(record.conceptId, record.dimension), record]),
  );
  const lessonRunState = runs.map(({ conceptId, status }) => ({ conceptId, status }));
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
            available: project.status === 'authored' && project.tests.length > 0,
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
            number: `${unitIndex + 1}.${topicIndex + 1}`,
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
        const records = masteryByConcept.get(concept.id) ?? [];
        const dimensionStates = concept.dimensions.map(
          (dimension) =>
            records.find((record) => record.dimension === dimension)?.state ?? 'not_assessed',
        );
        const runStatus = runsByConcept.get(concept.id)?.status;
        const status = topicStatus({
          lessonRunStatus: runStatus,
          dimensionStates,
          prerequisites: concept.prereqs.map((prerequisite) => ({
            strength: prerequisite.strength,
            done: prerequisiteMet(prerequisite.id, masteryByKey, lessonRunState, index),
          })),
        });
        const needs = concept.prereqs
          .filter(
            (prerequisite) =>
              prerequisite.strength === 'hard' &&
              !prerequisiteMet(prerequisite.id, masteryByKey, lessonRunState, index),
          )
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
          number: `${unitIndex + 1}.${topicIndex + 1}`,
          conceptId,
          title: concept.title,
          hasLesson: index.lessonsByConcept.has(concept.id),
          status,
          mastery: masteryLabel(lowestMasteryState(dimensionStates)),
          placedOut:
            status === 'complete' && runStatus === undefined && placedOutConcepts.has(concept.id),
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
  placedOutConcepts: ReadonlySet<string> = new Set(),
  startedCourseIds: ReadonlySet<string> = new Set(),
  courseStart: { courseId: string | null; needed: boolean; placementRunId: string | null } = {
    courseId: null,
    needed: false,
    placementRunId: null,
  },
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
  const foundations = activeCourse
    ? courseFoundations(index, resolvedCourseId)
        .filter((concept) => {
          const records = masteryRecords.filter((record) => record.conceptId === concept.id);
          const states = concept.dimensions.map(
            (dimension) =>
              records.find((record) => record.dimension === dimension)?.state ?? 'not_assessed',
          );
          return (
            topicStatus({
              lessonRunStatus: runs.find((run) => run.conceptId === concept.id)?.status,
              dimensionStates: states,
              prerequisites: concept.prereqs.map((prerequisite) => ({
                strength: prerequisite.strength,
                done: prerequisiteMet(
                  prerequisite.id,
                  new Map(
                    masteryRecords.map((record) => [
                      masteryKey(record.conceptId, record.dimension),
                      record,
                    ]),
                  ),
                  runs.map(({ conceptId, status }) => ({ conceptId, status })),
                  index,
                ),
              })),
            }) !== 'complete'
          );
        })
        .map((concept, indexInFoundations) => {
          const source = index.courses.find((course) =>
            course.units.some((unit) => unit.concepts.includes(concept.id)),
          );
          const topics = source
            ? buildUnits(
                index,
                source,
                masteryRecords,
                runs,
                paperStatuses,
                projectStatuses,
                placedOutConcepts,
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
    foundations,
    units,
  };
}
