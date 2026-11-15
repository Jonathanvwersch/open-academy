import { and, eq, inArray, or } from 'drizzle-orm';
import type { ContentIndex, IndexedConcept, IndexedCourse } from '../../content/types.js';
import type { Database } from '../../db/client.js';
import type { LearnerRepository } from '../../db/repository.js';
import {
  lessonRuns,
  mastery,
  masteryEvents,
  remediationFlags,
  reviewCards,
  sessionActivities,
  studySessions,
} from '../../db/schema.js';
import {
  lowestMasteryState,
  masteryLabel,
  topicIsComplete,
  topicStatus,
} from '../../learning/course-status.js';
import { courseTopicPosition } from '../../learning/lesson-course-context.js';
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

export async function restartTopic(input: {
  db: Database;
  userId: string;
  conceptId: string;
  content: ContentIndex;
}) {
  await input.db.transaction(async (tx) => {
    await tx
      .delete(masteryEvents)
      .where(
        and(eq(masteryEvents.userId, input.userId), eq(masteryEvents.conceptId, input.conceptId)),
      );
    await tx
      .delete(mastery)
      .where(and(eq(mastery.userId, input.userId), eq(mastery.conceptId, input.conceptId)));
    await tx
      .delete(reviewCards)
      .where(and(eq(reviewCards.userId, input.userId), eq(reviewCards.conceptId, input.conceptId)));
    await tx
      .delete(lessonRuns)
      .where(and(eq(lessonRuns.userId, input.userId), eq(lessonRuns.conceptId, input.conceptId)));
    await tx
      .delete(remediationFlags)
      .where(
        and(
          eq(remediationFlags.userId, input.userId),
          or(
            eq(remediationFlags.conceptId, input.conceptId),
            eq(remediationFlags.targetPrereqId, input.conceptId),
          ),
        ),
      );

    const sessions = await tx
      .select({ id: studySessions.id })
      .from(studySessions)
      .where(eq(studySessions.userId, input.userId));
    if (!sessions.length) return;
    const sessionIds = sessions.map((session) => session.id);
    await tx
      .update(sessionActivities)
      .set({ status: 'skipped' })
      .where(
        and(
          eq(sessionActivities.conceptId, input.conceptId),
          inArray(sessionActivities.sessionId, sessionIds),
          or(eq(sessionActivities.status, 'planned'), eq(sessionActivities.status, 'in_progress')),
        ),
      );

    const plannedActivities = await tx
      .select({ id: sessionActivities.id, conceptId: sessionActivities.conceptId })
      .from(sessionActivities)
      .where(
        and(
          inArray(sessionActivities.sessionId, sessionIds),
          eq(sessionActivities.status, 'planned'),
        ),
      );
    const [masteryRows, runRows] = await Promise.all([
      tx
        .select({
          conceptId: mastery.conceptId,
          dimension: mastery.dimension,
          state: mastery.state,
        })
        .from(mastery)
        .where(eq(mastery.userId, input.userId)),
      tx
        .select({ conceptId: lessonRuns.conceptId, status: lessonRuns.status })
        .from(lessonRuns)
        .where(eq(lessonRuns.userId, input.userId)),
    ]);
    const masteryByKey = new Map(
      masteryRows.map((record) => [masteryKey(record.conceptId, record.dimension), record.state]),
    );
    const runStatusByConcept = new Map(runRows.map((run) => [run.conceptId, run.status]));
    const incompletePrereqMemo = new Map<string, boolean>();
    const hasIncompleteHardPrerequisite = (conceptId: string) => {
      const visited = new Set<string>();
      const visit = (id: string): boolean => {
        if (visited.has(id)) return false;
        visited.add(id);
        const concept = input.content.conceptsById.get(id);
        if (!concept) return false;
        for (const prerequisite of concept.prereqs) {
          if (prerequisite.strength !== 'hard') continue;
          const prerequisiteConcept = input.content.conceptsById.get(prerequisite.id);
          if (!prerequisiteConcept) return true;
          const cached = incompletePrereqMemo.get(prerequisite.id);
          if (cached === true) return true;
          const dimensionStates = prerequisiteConcept.dimensions.map(
            (dimension) =>
              masteryByKey.get(masteryKey(prerequisite.id, dimension)) ?? 'not_assessed',
          );
          const incomplete =
            !topicIsComplete(runStatusByConcept.get(prerequisite.id), dimensionStates) ||
            visit(prerequisite.id);
          incompletePrereqMemo.set(prerequisite.id, incomplete);
          if (incomplete) return true;
        }
        return false;
      };
      return visit(conceptId);
    };
    const activitiesToSkip = plannedActivities
      .filter(
        (activity) =>
          activity.conceptId !== null && hasIncompleteHardPrerequisite(activity.conceptId),
      )
      .map((activity) => activity.id);
    if (activitiesToSkip.length) {
      await tx
        .update(sessionActivities)
        .set({ status: 'skipped' })
        .where(
          and(
            inArray(sessionActivities.id, activitiesToSkip),
            eq(sessionActivities.status, 'planned'),
          ),
        );
    }
  });
}

export function placedOutConceptsFromRuns(runs: readonly { state: unknown }[]): Set<string> {
  const conceptIds = new Set<string>();
  for (const run of runs) {
    if (typeof run.state !== 'object' || run.state === null) continue;
    const known = (run.state as { known?: unknown }).known;
    if (!Array.isArray(known)) continue;
    for (const conceptId of known) {
      if (typeof conceptId === 'string') conceptIds.add(conceptId);
    }
  }
  return conceptIds;
}

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

export function courseTopicState(
  index: ContentIndex,
  masteryRecords: MasteryRecords,
  runs: RunRecords,
  placedOutConcepts: ReadonlySet<string>,
) {
  const masteryByKey = new Map(
    masteryRecords.map((record) => [masteryKey(record.conceptId, record.dimension), record]),
  );
  const runsByConcept = new Map(runs.map((run) => [run.conceptId, run]));
  return (concept: IndexedConcept) => {
    const dimensionStates = concept.dimensions.map(
      (dimension) => masteryByKey.get(masteryKey(concept.id, dimension))?.state ?? 'not_assessed',
    );
    const runStatus = runsByConcept.get(concept.id)?.status;
    const prerequisites = concept.prereqs.map((prerequisite) => ({
      ...prerequisite,
      done: prerequisiteMet(prerequisite.id, masteryByKey, runs, index),
    }));
    const status = topicStatus({ lessonRunStatus: runStatus, dimensionStates, prerequisites });
    return {
      status,
      dimensionStates,
      placedOut:
        status === 'complete' && runStatus === undefined && placedOutConcepts.has(concept.id),
      missingPrereqs: prerequisites.filter(
        (prerequisite) => prerequisite.strength === 'hard' && !prerequisite.done,
      ),
    };
  };
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
  const topicState = courseTopicState(index, masteryRecords, runs, placedOutConcepts);
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
        const { status, dimensionStates, placedOut, missingPrereqs } = topicState(concept);
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
          mastery: masteryLabel(lowestMasteryState(dimensionStates)),
          placedOut,
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
  const topicState = courseTopicState(index, masteryRecords, runs, placedOutConcepts);
  const foundations = activeCourse
    ? courseFoundations(index, resolvedCourseId)
        .filter((concept) => topicState(concept).status !== 'complete')
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
