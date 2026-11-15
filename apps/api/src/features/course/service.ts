import type { CourseQueueStatus } from '@academy/contracts/course';
import { and, eq, inArray, or } from 'drizzle-orm';
import { orderCourseIdsBySubject } from '../../content/course-order.js';
import { subjectForCourse } from '../../content/index.js';
import type { ContentIndex, IndexedConcept, IndexedCourse } from '../../content/types.js';
import type { Database } from '../../db/client.js';
import type { LearnerRepository } from '../../db/repository.js';
import {
  courseEnrollments,
  lessonRuns,
  mastery,
  masteryEvents,
  remediationFlags,
  reviewCards,
  sessionActivities,
  studySessions,
  users,
} from '../../db/schema.js';
import { filterSchedulerStateForContent } from '../../learning/content-filters.js';
import { lowestMasteryState, masteryLabel, topicStatus } from '../../learning/course-status.js';
import { initialLearnProgress } from '../../learning/initial-learn-progress.js';
import { courseTopicPosition } from '../../learning/lesson-course-context.js';
import {
  activeCourseFor,
  compareOutlinePosition,
  courseFoundations,
  masteryKey,
  prerequisiteMet,
} from '../../learning/prerequisites.js';
import {
  currentLearnerUnit,
  effectiveFocusSubjectId,
  type PlannedActivity,
  replan,
  type SchedulerState,
} from '../../learning/scheduler.js';

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

    const affectedCourseIds = input.content.courses
      .filter((course) => course.units.some((unit) => unit.concepts.includes(input.conceptId)))
      .map((course) => course.id);
    if (affectedCourseIds.length > 0) {
      await tx
        .update(courseEnrollments)
        .set({ status: 'active', completedAt: null })
        .where(
          and(
            eq(courseEnrollments.userId, input.userId),
            eq(courseEnrollments.status, 'completed'),
            inArray(courseEnrollments.courseId, affectedCourseIds),
          ),
        );
    }

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

    const dependentActivities = await tx
      .select({ id: sessionActivities.id, conceptId: sessionActivities.conceptId })
      .from(sessionActivities)
      .where(
        and(
          inArray(sessionActivities.sessionId, sessionIds),
          or(eq(sessionActivities.status, 'planned'), eq(sessionActivities.status, 'in_progress')),
        ),
      );
    const [masteryRows, runRows] = await Promise.all([
      tx
        .select({
          conceptId: mastery.conceptId,
          dimension: mastery.dimension,
          state: mastery.state,
          inferred: mastery.inferred,
        })
        .from(mastery)
        .where(eq(mastery.userId, input.userId)),
      tx
        .select({ conceptId: lessonRuns.conceptId, status: lessonRuns.status })
        .from(lessonRuns)
        .where(eq(lessonRuns.userId, input.userId)),
    ]);
    const masteryByKey = new Map(
      masteryRows.map((record) => [
        masteryKey(record.conceptId, record.dimension),
        { state: record.state, inferred: record.inferred },
      ]),
    );
    const activitiesToSkip = dependentActivities
      .filter((activity) => {
        if (!activity.conceptId) return false;
        const concept = input.content.conceptsById.get(activity.conceptId);
        return (
          concept?.prereqs.some(
            (prerequisite) =>
              prerequisite.strength === 'hard' &&
              !prerequisiteMet(prerequisite.id, masteryByKey, runRows, input.content),
          ) ?? false
        );
      })
      .map((activity) => activity.id);
    if (activitiesToSkip.length) {
      await tx
        .update(sessionActivities)
        .set({ status: 'skipped' })
        .where(
          and(
            inArray(sessionActivities.id, activitiesToSkip),
            or(
              eq(sessionActivities.status, 'planned'),
              eq(sessionActivities.status, 'in_progress'),
            ),
          ),
        );
    }
  });
}

export async function replanSessionActivities(input: {
  db: Database;
  repo: LearnerRepository;
  userId: string;
  content: ContentIndex;
  now: Date;
  session: NonNullable<Awaited<ReturnType<LearnerRepository['session']>>>;
  skipActivityIds?: readonly string[];
  activatePlannedActivityId?: string;
  schedulerState?: SchedulerState;
}) {
  const state = filterSchedulerStateForContent(
    input.content,
    input.schedulerState ?? (await input.repo.schedulerState(input.now, input.content)),
  );
  const skipIds = new Set(input.skipActivityIds ?? []);
  const planningActivities = input.session.activities.map((activity) => ({
    ...activity,
    status: skipIds.has(activity.id)
      ? 'skipped'
      : activity.id === input.activatePlannedActivityId
        ? 'in_progress'
        : activity.status,
  })) as unknown as PlannedActivity[];
  const existingMinutes = planningActivities
    .filter((activity) => activity.status === 'completed' || activity.status === 'in_progress')
    .reduce((total, activity) => total + activity.plannedMinutes, 0);
  const remaining = Math.max(0, input.session.plannedMinutes - existingMinutes);
  const plan = replan(
    state,
    input.content,
    input.now,
    remaining,
    planningActivities,
    input.session.kind,
  );
  const preserved = input.session.activities
    .filter(
      (activity) =>
        activity.status !== 'planned' ||
        skipIds.has(activity.id) ||
        activity.id === input.activatePlannedActivityId,
    )
    .map((activity) => (skipIds.has(activity.id) ? { ...activity, status: 'skipped' } : activity));
  const planned = await Promise.all(
    plan.activities
      .filter((activity) => activity.status !== 'in_progress')
      .map(async (activity) => ({
        activity,
        progress: await initialLearnProgress(
          input.db,
          input.userId,
          activity,
          activity.conceptId ? input.content.lessonsByConcept.get(activity.conceptId) : undefined,
        ),
      })),
  );
  const nextIndex = Math.max(-1, ...preserved.map((activity) => activity.idx)) + 1;
  await input.db.transaction(async (tx) => {
    if (skipIds.size > 0) {
      await tx
        .update(sessionActivities)
        .set({ status: 'skipped' })
        .where(
          and(
            eq(sessionActivities.sessionId, input.session.id),
            inArray(sessionActivities.id, [...skipIds]),
            or(
              eq(sessionActivities.status, 'planned'),
              eq(sessionActivities.status, 'in_progress'),
            ),
          ),
        );
    }
    if (input.activatePlannedActivityId) {
      await tx
        .update(sessionActivities)
        .set({ status: 'in_progress', startedAt: input.now })
        .where(
          and(
            eq(sessionActivities.id, input.activatePlannedActivityId),
            eq(sessionActivities.status, 'planned'),
          ),
        );
    }
    await tx
      .delete(sessionActivities)
      .where(
        and(
          eq(sessionActivities.sessionId, input.session.id),
          eq(sessionActivities.status, 'planned'),
        ),
      );
    for (const [idx, entry] of planned.entries()) {
      const { activity, progress } = entry;
      await tx.insert(sessionActivities).values({
        sessionId: input.session.id,
        idx: nextIndex + idx,
        kind: activity.kind,
        conceptId: activity.conceptId,
        projectId: activity.projectId,
        exerciseIds: activity.exerciseIds,
        plannedMinutes: activity.plannedMinutes,
        status: 'planned',
        reason: activity.reason,
        ...(progress ? { progress } : {}),
      });
    }
  });
}

export async function updateLearningFocus(input: {
  db: Database;
  repo: LearnerRepository;
  userId: string;
  content: ContentIndex;
  subjectId: string | null;
  now: Date;
}) {
  const user = await input.repo.user();
  const prefs = { ...((user?.prefs ?? {}) as Record<string, unknown>) };
  if (input.subjectId === null) delete prefs.focusSubjectId;
  else prefs.focusSubjectId = input.subjectId;
  await input.db.update(users).set({ prefs }).where(eq(users.id, input.userId));

  const active = await input.repo.activeSession(input.now);
  const session = active ? await input.repo.session(active.id) : undefined;
  if (!session) return;
  const schedulerState = await input.repo.schedulerState(input.now, input.content);
  const focusSubjectId = effectiveFocusSubjectId(
    { focusSubjectId: input.subjectId },
    schedulerState.studyCourseIds,
    input.content,
  );
  const state = filterSchedulerStateForContent(input.content, {
    ...schedulerState,
    focusSubjectId: focusSubjectId ?? undefined,
  });
  await replanSessionActivities({
    db: input.db,
    repo: input.repo,
    userId: input.userId,
    content: input.content,
    now: input.now,
    session,
    schedulerState: state,
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
  const courseOrder = orderCourseIdsBySubject(index);
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
    return (
      candidateCourse?.units.some((unit) =>
        unit.concepts.some((conceptId) => {
          const concept = content.conceptsById.get(conceptId);
          if (!concept || concept.status === 'stub' || !content.lessonsByConcept.has(conceptId)) {
            return false;
          }
          const status = topicState(concept).status;
          return status !== 'locked' && status !== 'complete';
        }),
      ) ?? false
    );
  });
  if (frontCourseId === course.id) return { kind: 'studying' };

  const frontCourseOrder = frontCourseId ? orderedSubjectCourseIds.indexOf(frontCourseId) : -1;
  const courseOrder = orderedSubjectCourseIds.indexOf(course.id);
  const frontCourse = frontCourseId ? content.coursesById.get(frontCourseId) : undefined;
  if (frontCourse && frontCourseOrder < courseOrder) {
    return { kind: 'after', courseId: frontCourse.id, courseTitle: frontCourse.title };
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
  const foundationCourseTitles = [
    ...new Set(
      foundations.flatMap((foundation) => {
        const source = foundationSourceCourse(index, foundation.conceptId);
        return source ? [source.title] : [];
      }),
    ),
  ];
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
    foundationNeeds: {
      count: foundations.length,
      courseTitles: foundationCourseTitles.slice(0, 3),
      hasMore: foundationCourseTitles.length > 3,
    },
    foundations,
    units,
  };
}
