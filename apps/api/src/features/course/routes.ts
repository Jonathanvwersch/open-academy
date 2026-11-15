import { and, eq, inArray } from 'drizzle-orm';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { orderCourseIdsBySubject } from '../../content/course-order.js';
import { subjectForCourse } from '../../content/index.js';
import type { ContentIndex } from '../../content/types.js';
import type { Database } from '../../db/client.js';
import type { LearnerRepository } from '../../db/repository.js';
import {
  diagnosticRuns,
  lessonProblems,
  lessonRuns,
  masteryEvents,
  paperProgress,
  projectProgress,
  sessionActivities,
  studySessions,
  xpEvents,
} from '../../db/schema.js';
import type { ApiEnv } from '../../http/context.js';
import {
  filterMasteryRecordsForContent,
  filterSchedulerStateForContent,
  sessionActivityIsInContent,
} from '../../learning/content-filters.js';
import { buildCourseStartState, needsCourseChoice } from '../../learning/course-start.js';
import { topicIsComplete } from '../../learning/course-status.js';
import {
  courseTopicAttribution,
  type ProjectionCourse,
  projectCourseFinishes,
} from '../../learning/finish-projection.js';
import { deriveLessonState } from '../../learning/lesson-runner.js';
import {
  activeCourseFor,
  courseFoundationIds,
  learnActivitiesWithUnmetPrerequisites,
  masteryKey,
  prerequisiteMet,
} from '../../learning/prerequisites.js';
import type { PlannedActivity, SessionPreferences } from '../../learning/scheduler.js';
import {
  currentLearnerUnit,
  effectiveFocusSubjectId,
  isLearnableConcept,
  planSession,
  type SessionKind,
  schedulerRecentLearnMinutesBySubject,
  sessionBudget,
} from '../../learning/scheduler.js';
import { buildStreak } from '../../learning/streak.js';
import { masteryRank } from '../../learning/types.js';
import {
  averageDailyXp,
  coursePercent,
  defaultAverageDailyXp,
  estimateTaskXp,
  localDateKey,
  sessionKindForDate,
  weekXp,
  xpGoalFor,
} from '../../learning/xp.js';
import {
  buildCoursePayload,
  courseTopicState,
  placedOutConceptsFromRuns,
  replanSessionActivities,
  restartTopic,
  suggestedNextCourses,
  updateLearningFocus,
} from './service.js';

type RouteContext = Context<ApiEnv>;
type ActivityRecord = typeof sessionActivities.$inferSelect;

function buildProjectionCourses(
  index: ContentIndex,
  courseIds: string[],
  topicState: ReturnType<typeof courseTopicState>,
  completionDates: ReadonlyMap<string, string>,
  preferredSubjectId: string | null,
): ProjectionCourse[] {
  const subjectOrder = new Map(
    (index.curriculum?.subjects ?? []).map((subject, position) => [subject.id, position]),
  );
  const orderedCourseIds = orderCourseIdsBySubject(index, courseIds);
  const preferredCourseIds = preferredSubjectId
    ? [
        ...orderedCourseIds.filter(
          (courseId) => subjectForCourse(index, courseId).id === preferredSubjectId,
        ),
        ...orderedCourseIds.filter(
          (courseId) => subjectForCourse(index, courseId).id !== preferredSubjectId,
        ),
      ]
    : orderedCourseIds;
  const attributionCourses = preferredCourseIds.flatMap((activeCourseId) => {
    const activeCourse = index.coursesById.get(activeCourseId);
    return activeCourse
      ? [
          {
            id: activeCourse.id,
            title: activeCourse.title,
            subjectId: subjectForCourse(index, activeCourseId).id,
            units: activeCourse.units.map(({ title, concepts }) => ({ title, concepts })),
          },
        ]
      : [];
  });
  const activeTopicIds = new Set(
    orderedCourseIds.flatMap((courseId) => {
      const course = index.coursesById.get(courseId);
      return (
        course?.units
          .flatMap((unit) => unit.concepts)
          .filter((conceptId) => index.conceptsById.get(conceptId)?.status !== 'stub') ?? []
      );
    }),
  );
  return orderedCourseIds.flatMap((courseId) => {
    const course = index.coursesById.get(courseId);
    if (!course) return [];
    const schedulableFoundations = courseFoundationIds(index, courseId);
    const visited = new Set<string>();
    const topics: ProjectionCourse['topics'] = [];
    const addTopic = (conceptId: string, unitTitle: string) => {
      const concept = index.conceptsById.get(conceptId);
      if (!concept || concept.status === 'stub' || visited.has(conceptId)) return;
      visited.add(conceptId);
      const state = topicState(concept);
      const hardPrereqIds = concept.prereqs
        .filter((prerequisite) => prerequisite.strength === 'hard')
        .map((prerequisite) => prerequisite.id);
      for (const prereqId of hardPrereqIds) {
        if (activeTopicIds.has(prereqId)) continue;
        const prerequisite = index.conceptsById.get(prereqId);
        if (!prerequisite) continue;
        const alreadyDone = topicState(prerequisite).status === 'complete';
        if (
          alreadyDone ||
          (schedulableFoundations.has(prereqId) && isLearnableConcept(prerequisite, index))
        ) {
          addTopic(prereqId, unitTitle);
        }
      }
      const attribution = courseTopicAttribution(
        conceptId,
        attributionCourses,
        {
          courseId,
          courseTitle: course.title,
          unitTitle,
        },
        preferredSubjectId ?? undefined,
      );
      const completionDate = completionDates.get(conceptId);
      topics.push({
        conceptId,
        status: concept.status,
        done: state.status === 'complete',
        hardPrereqIds,
        title: concept.title,
        unitTitle,
        ...(completionDate ? { completionDate } : {}),
        displayCourseId: attribution.courseId,
        displayCourseTitle: attribution.courseTitle,
        displayUnitTitle: attribution.unitTitle,
      });
    };
    for (const unit of course.units) {
      for (const conceptId of unit.concepts) addTopic(conceptId, unit.title);
    }
    const subject = subjectForCourse(index, courseId);
    return [
      {
        id: courseId,
        subjectId: subject.id,
        subjectOrder: subjectOrder.get(subject.id) ?? Infinity,
        title: course.title,
        topics,
      },
    ];
  });
}

function activeLearnTopics(
  activities: readonly ActivityRecord[],
  courses: ProjectionCourse[],
  index: ContentIndex,
  date: string,
) {
  const added = new Set<string>();
  return activities.flatMap((activity) => {
    const conceptId = activity.conceptId;
    if (
      activity.kind !== 'learn' ||
      !conceptId ||
      added.has(conceptId) ||
      index.conceptsById.get(conceptId)?.status === 'stub'
    ) {
      return [];
    }
    const projectedCourse = courses.find((course) =>
      course.topics.some((topic) => topic.conceptId === conceptId),
    );
    const projectedTopic = projectedCourse?.topics.find((topic) => topic.conceptId === conceptId);
    if (!projectedCourse || !projectedTopic) return [];
    added.add(conceptId);
    return [
      {
        conceptId,
        courseId: projectedTopic.displayCourseId ?? projectedCourse.id,
        courseTitle:
          projectedTopic.displayCourseTitle ?? projectedCourse.title ?? projectedCourse.id,
        title: projectedTopic.title ?? conceptId,
        unitTitle: projectedTopic.displayUnitTitle ?? projectedTopic.unitTitle ?? '',
        date,
        dayLabel: 'Today',
      },
    ];
  });
}

function addLocalDays(localDate: string, days: number): string {
  const date = new Date(`${localDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function registerLearnCourseRoutes(
  api: Hono<ApiEnv>,
  deps: {
    db: Database;
    content: () => Promise<ContentIndex>;
    withRepo: (context: RouteContext) => LearnerRepository;
    requestNow: (context: RouteContext) => Date;
  },
) {
  api.get('/learn', async (context) => {
    const index = await deps.content();
    const repo = deps.withRepo(context);
    const userId = context.get('userId');
    const timeZone = context.get('timeZone');
    const now = deps.requestNow(context);
    const [runRowsRaw, completedRowsRaw, projectRowsRaw] = await Promise.all([
      deps.db.select().from(lessonRuns).where(eq(lessonRuns.userId, userId)),
      deps.db
        .select({ activity: sessionActivities })
        .from(sessionActivities)
        .innerJoin(studySessions, eq(sessionActivities.sessionId, studySessions.id))
        .where(and(eq(studySessions.userId, userId), eq(sessionActivities.status, 'completed'))),
      deps.db
        .select({ projectId: projectProgress.projectId, status: projectProgress.status })
        .from(projectProgress)
        .where(eq(projectProgress.userId, userId)),
    ]);
    const runRows = runRowsRaw.filter((run) => index.conceptsById.has(run.conceptId));
    const completedRows = completedRowsRaw.filter(({ activity }) =>
      sessionActivityIsInContent(index, activity),
    );
    const recentLearnMinutesByConcept: Record<string, number> = {};
    const recentLearnCutoff = new Date(now.getTime() - 7 * 86_400_000);
    for (const { activity } of completedRows) {
      if (
        activity.kind !== 'learn' ||
        !activity.conceptId ||
        !activity.completedAt ||
        activity.completedAt < recentLearnCutoff ||
        activity.completedAt > now
      ) {
        continue;
      }
      recentLearnMinutesByConcept[activity.conceptId] =
        (recentLearnMinutesByConcept[activity.conceptId] ?? 0) + activity.plannedMinutes;
    }
    const projectRows = projectRowsRaw.filter((project) =>
      index.projectsById.has(project.projectId),
    );
    const [masteryRows, user, events, active, placementRuns, enrollments, completedPlacementRuns] =
      await Promise.all([
        repo.masteryRecords(),
        repo.user(),
        deps.db.select().from(xpEvents).where(eq(xpEvents.userId, userId)),
        repo.activeSession(now),
        repo.activePlacementRuns(),
        repo.courseEnrollments(),
        deps.db
          .select({ state: diagnosticRuns.state })
          .from(diagnosticRuns)
          .where(
            and(
              eq(diagnosticRuns.userId, userId),
              eq(diagnosticRuns.kind, 'placement'),
              eq(diagnosticRuns.status, 'completed'),
            ),
          ),
      ]);
    const mastery = filterMasteryRecordsForContent(index, masteryRows);
    const activeCourseId = index.coursesById.has(user?.activeCourseId ?? '')
      ? (user?.activeCourseId ?? null)
      : null;
    const studyCourseIds = await repo.studyCourseIds(index);
    const prefs = (user?.prefs ?? {}) as SessionPreferences & { focusSubjectId?: unknown };
    const activeSubjectIds = new Set(
      studyCourseIds.map((courseId) => subjectForCourse(index, courseId).id),
    );
    const subjectHasLessons = (subjectId: string) =>
      studyCourseIds.some((courseId) => {
        if (subjectForCourse(index, courseId).id !== subjectId) return false;
        const course = index.coursesById.get(courseId);
        return (
          course?.units.some((unit) =>
            unit.concepts.some((conceptId) => {
              const concept = index.conceptsById.get(conceptId);
              return (
                concept !== undefined &&
                concept.status !== 'stub' &&
                index.lessonsByConcept.has(conceptId)
              );
            }),
          ) ?? false
        );
      });
    const activeSubjects = (index.curriculum?.subjects ?? [])
      .filter((subject) => activeSubjectIds.has(subject.id))
      .map(({ id, title }) => ({ id, title, hasLessons: subjectHasLessons(id) }));
    if (activeSubjects.length === 0 && studyCourseIds.length > 0) {
      const subject = subjectForCourse(index, studyCourseIds[0] ?? '');
      activeSubjects.push({ ...subject, hasLessons: subjectHasLessons(subject.id) });
    }
    const focusSubjectId = effectiveFocusSubjectId(prefs, studyCourseIds, index);
    const placementCourseId = placementRuns
      .map((run) => (run.state as { courseId?: unknown }).courseId)
      .find((id): id is string => typeof id === 'string' && index.coursesById.has(id));
    const currentCourseId = placementCourseId ?? studyCourseIds[0] ?? activeCourseId;
    const startState = buildCourseStartState({
      content: index,
      activeCourseId: currentCourseId,
      mastery,
      lessonRuns: runRows,
      enrollments,
      placementRuns,
    });
    const needsChoice = needsCourseChoice({
      activeCourseId,
      studyCourseIds,
      mastery,
      lessonRuns: runRows,
      activePlacementRuns: placementRuns,
    });
    const placedOutConcepts = placedOutConceptsFromRuns(completedPlacementRuns);
    const todayLocal = localDateKey(now, timeZone);
    const totalXp = events.reduce((total, event) => total + event.amount, 0);
    const todayXp = events
      .filter((event) => event.localDate === todayLocal)
      .reduce((total, event) => total + event.amount, 0);
    const projectStatuses = new Map(projectRows.map((row) => [row.projectId, row.status]));
    const runsByConcept = new Map(runRows.map((run) => [run.conceptId, run]));
    const problemsByRun = await getProblemsByRun(
      deps.db,
      runRows.map((run) => run.id),
    );
    const masteryByConcept = new Map<string, typeof mastery>();
    for (const record of mastery) {
      const conceptRecords = masteryByConcept.get(record.conceptId) ?? [];
      conceptRecords.push(record);
      masteryByConcept.set(record.conceptId, conceptRecords);
    }
    const completedConcept = (conceptId: string | null | undefined) => {
      if (!conceptId) return false;
      const concept = index.conceptsById.get(conceptId);
      if (!concept) return false;
      const states = concept.dimensions.map(
        (dimension) =>
          masteryByConcept.get(conceptId)?.find((record) => record.dimension === dimension)
            ?.state ?? 'not_assessed',
      );
      return topicIsComplete(runsByConcept.get(conceptId)?.status, states);
    };

    let activeSession = active ? await repo.session(active.id, active) : undefined;
    let schedulerState: Awaited<ReturnType<LearnerRepository['schedulerState']>> | undefined;
    const loadSchedulerState = async () => {
      schedulerState ??= filterSchedulerStateForContent(
        index,
        await repo.schedulerState(now, index, {
          mastery,
          lessonRuns: runRows,
          projectProgress: projectRows,
        }),
      );
      return schedulerState;
    };
    const masteryByKey = new Map(
      mastery.map((record) => [masteryKey(record.conceptId, record.dimension), record]),
    );
    const lessonRunState = runRows.map(({ conceptId, status }) => ({ conceptId, status }));
    const blockedActivities =
      activeSession?.status === 'active'
        ? learnActivitiesWithUnmetPrerequisites(
            activeSession.activities,
            masteryByKey,
            lessonRunState,
            index,
          )
        : [];
    if (activeSession && blockedActivities.length > 0) {
      await replanSessionActivities({
        db: deps.db,
        repo,
        userId,
        content: index,
        now,
        session: activeSession,
        skipActivityIds: blockedActivities,
        schedulerState: await loadSchedulerState(),
      });
      activeSession = await repo.session(activeSession.id);
    }
    const activeActivities =
      activeSession?.activities.filter(
        (activity) =>
          (activity.status === 'planned' || activity.status === 'in_progress') &&
          sessionActivityIsInContent(index, activity),
      ) ?? [];
    const activeSessionId =
      activeSession && (activeSession.activities.length === 0 || activeActivities.length > 0)
        ? (active?.id ?? null)
        : null;
    const activities: Array<ActivityRecord | PlannedActivity> = activeSessionId
      ? activeActivities
      : plannedActivities(await loadSchedulerState(), index, prefs, timeZone, now);

    const tasks = activities.map((activity, taskIndex) => {
      const conceptId = activity.conceptId;
      const concept = conceptId ? index.conceptsById.get(conceptId) : undefined;
      const lesson = conceptId ? index.lessonsByConcept.get(conceptId) : undefined;
      const run = conceptId ? runsByConcept.get(conceptId) : undefined;
      const lessonState =
        activity.kind === 'learn' && lesson?.knowledge_points?.length
          ? run
            ? deriveLessonState(lesson, problemsByRun.get(run.id) ?? [], index.exercisesById)
            : {
                points: lesson.knowledge_points.map(() => ({ status: 'active' })),
              }
          : undefined;
      const prerequisites = (concept?.prereqs ?? []).map((prerequisite) => ({
        id: prerequisite.id,
        title: index.conceptsById.get(prerequisite.id)?.title ?? prerequisite.id,
        done: completedConcept(prerequisite.id),
      }));
      const projectId = 'projectId' in activity ? activity.projectId : undefined;
      const project = projectId ? index.projectsById.get(projectId) : undefined;
      return {
        id: 'id' in activity ? activity.id : `planned-${taskIndex}`,
        activityKind: activity.kind,
        label: activityLabel(activity.kind),
        ...(conceptId ? { conceptId } : {}),
        title: concept?.title ?? project?.title ?? titleForKind(activity.kind),
        xp: estimateTaskXp(activity, lessonState),
        prerequisites,
      };
    });

    const recommendedConceptId = tasks.find((task) => task.activityKind === 'learn')?.conceptId;
    const outlineConceptIds = Array.from(
      new Set([
        ...studyCourseIds.flatMap((courseId) => {
          const course = index.coursesById.get(courseId);
          return [
            ...(course?.units.flatMap((unit) => unit.concepts) ?? []),
            ...courseFoundationIds(index, courseId),
          ];
        }),
      ]),
    );
    const eligibleChoices = activeSessionId
      ? []
      : outlineConceptIds.flatMap((conceptId) => {
          const concept = index.conceptsById.get(conceptId);
          const lesson = index.lessonsByConcept.get(conceptId);
          if (
            !concept ||
            !lesson ||
            concept.status === 'stub' ||
            completedConcept(conceptId) ||
            !concept.prereqs
              .filter((prerequisite) => prerequisite.strength === 'hard')
              .every((prerequisite) =>
                prerequisiteMet(prerequisite.id, masteryByKey, lessonRunState, index),
              )
          ) {
            return [];
          }
          const run = runsByConcept.get(conceptId);
          const lessonState = lesson.knowledge_points?.length
            ? run
              ? deriveLessonState(lesson, problemsByRun.get(run.id) ?? [], index.exercisesById)
              : { points: lesson.knowledge_points.map(() => ({ status: 'active' })) }
            : undefined;
          return [
            {
              conceptId,
              title: concept.title,
              xp: estimateTaskXp(
                { kind: 'learn', plannedMinutes: concept.est_minutes },
                lessonState,
              ),
              recommended: conceptId === recommendedConceptId,
            },
          ];
        });
    const choices = eligibleChoices.slice(0, 5);
    const recommendedChoice = eligibleChoices.find((choice) => choice.recommended);
    if (
      recommendedChoice &&
      !choices.some((choice) => choice.conceptId === recommendedChoice.conceptId)
    ) {
      choices.push(recommendedChoice);
    }

    const todayDone = completedRows
      .filter(
        ({ activity }) =>
          activity.completedAt && localDateKey(activity.completedAt, timeZone) === todayLocal,
      )
      .sort(
        (left, right) =>
          (left.activity.completedAt?.getTime() ?? 0) -
          (right.activity.completedAt?.getTime() ?? 0),
      );
    const doneToday = todayDone.map(({ activity }) => {
      const run =
        activity.kind === 'learn' && activity.conceptId
          ? runsByConcept.get(activity.conceptId)
          : undefined;
      const activityXp = events
        .filter(
          (event) =>
            event.sourceKey === `activity:${activity.id}` && event.localDate === todayLocal,
        )
        .reduce((total, event) => total + event.amount, 0);
      const lessonXp =
        run?.completedAt &&
        activity.completedAt &&
        run.completedAt.getTime() === activity.completedAt.getTime()
          ? events
              .filter(
                (event) =>
                  event.localDate === todayLocal &&
                  (event.sourceKey.startsWith(`kp:${run.id}:`) ||
                    event.sourceKey === `quiz:${run.id}`),
              )
              .reduce((total, event) => total + event.amount, 0)
          : 0;
      return {
        activityId: activity.id,
        label: activityLabel(activity.kind),
        title:
          (activity.conceptId && index.conceptsById.get(activity.conceptId)?.title) ??
          (activity.projectId && index.projectsById.get(activity.projectId)?.title) ??
          titleForKind(activity.kind),
        xp: activityXp + lessonXp,
        completedAt: activity.completedAt?.toISOString(),
      };
    });

    const coursePayload = buildCoursePayload(
      index,
      currentCourseId,
      mastery,
      runRows,
      new Map(),
      projectStatuses,
      placedOutConcepts,
      startState.startedCourseIds,
      startState.courseStart,
    );
    await completePayloadCourses(repo, coursePayload, now);
    const topics = coursePayload.units.flatMap((unit) => unit.topics);
    const focusedCourseIds = focusSubjectId
      ? studyCourseIds.filter((courseId) => subjectForCourse(index, courseId).id === focusSubjectId)
      : studyCourseIds;
    const topicState = courseTopicState(index, mastery, runRows, placedOutConcepts);
    const latestRunsByConcept = new Map<string, (typeof runRows)[number]>();
    for (const run of runRows) {
      const current = latestRunsByConcept.get(run.conceptId);
      if (!current || run.startedAt >= current.startedAt) {
        latestRunsByConcept.set(run.conceptId, run);
      }
    }
    const completionDates = new Map<string, string>();
    for (const run of latestRunsByConcept.values()) {
      if (run.completedAt) {
        completionDates.set(run.conceptId, localDateKey(run.completedAt, timeZone));
      }
    }
    const projectionConceptIds = new Set(
      studyCourseIds.flatMap((courseId) => {
        const activeCourse = index.coursesById.get(courseId);
        return activeCourse
          ? [
              ...activeCourse.units.flatMap((unit) => unit.concepts),
              ...courseFoundationIds(index, courseId),
            ]
          : [];
      }),
    );
    const conceptsWithoutRunDates = [...projectionConceptIds].filter((conceptId) => {
      const concept = index.conceptsById.get(conceptId);
      return (
        !completionDates.has(conceptId) &&
        concept !== undefined &&
        topicState(concept).status === 'complete'
      );
    });
    if (conceptsWithoutRunDates.length > 0) {
      const completionEvents = await deps.db
        .select({
          conceptId: masteryEvents.conceptId,
          fromState: masteryEvents.fromState,
          toState: masteryEvents.toState,
          createdAt: masteryEvents.createdAt,
        })
        .from(masteryEvents)
        .where(
          and(
            eq(masteryEvents.userId, userId),
            inArray(masteryEvents.conceptId, conceptsWithoutRunDates),
          ),
        );
      const earliestEvents = new Map<string, Date>();
      for (const event of completionEvents) {
        if (
          masteryRank(event.toState) < masteryRank('assisted') ||
          masteryRank(event.fromState) >= masteryRank('assisted')
        ) {
          continue;
        }
        const earliest = earliestEvents.get(event.conceptId);
        if (!earliest || event.createdAt < earliest) {
          earliestEvents.set(event.conceptId, event.createdAt);
        }
      }
      for (const [conceptId, completedAt] of earliestEvents) {
        completionDates.set(conceptId, localDateKey(completedAt, timeZone));
      }
    }
    const projectionCourses = buildProjectionCourses(
      index,
      studyCourseIds,
      topicState,
      completionDates,
      focusSubjectId,
    );
    const finishProjectionCourses = focusSubjectId
      ? buildProjectionCourses(index, focusedCourseIds, topicState, completionDates, focusSubjectId)
      : projectionCourses;
    const projectionSchedulerState = schedulerState ?? {
      activeCourseId,
      studyCourseIds,
      focusSubjectId: focusSubjectId ?? undefined,
      mastery,
      lessonRuns: lessonRunState,
      recentLearnMinutesByConcept,
    };
    const recentLearnMinutesBySubject = schedulerRecentLearnMinutesBySubject(
      projectionSchedulerState,
      index,
    );
    const averageXp = averageDailyXp(events, todayLocal);
    const dailyXpAtPace = averageXp > 0 ? averageXp : defaultAverageDailyXp(prefs);
    const dailyXpAtGoal = defaultAverageDailyXp(prefs);
    const finishesAtPace = projectCourseFinishes({
      courses: finishProjectionCourses,
      dailyXp: dailyXpAtPace,
      today: todayLocal,
      spentBySubject: recentLearnMinutesBySubject,
    });
    const finishesAtGoal = projectCourseFinishes({
      courses: finishProjectionCourses,
      dailyXp: dailyXpAtGoal,
      today: todayLocal,
      spentBySubject: recentLearnMinutesBySubject,
    });
    const todayTopics = activeLearnTopics(activeActivities, projectionCourses, index, todayLocal);
    const projectUpcoming = (courses: ProjectionCourse[], topicsForToday: typeof todayTopics) => {
      const todayConceptIds = new Set(topicsForToday.map((topic) => topic.conceptId));
      const projection = projectCourseFinishes({
        courses,
        dailyXp: dailyXpAtPace,
        today: addLocalDays(todayLocal, topicsForToday.length > 0 ? 1 : 0),
        assumedDoneConceptIds: todayConceptIds,
        spentBySubject: recentLearnMinutesBySubject,
      });
      return [
        ...topicsForToday,
        ...projection.upcoming.map((topic) => ({
          ...topic,
          dayLabel: projectedDayLabel(topic.date, todayLocal),
        })),
      ];
    };
    const allSubjectsProjectionCourses = focusSubjectId
      ? buildProjectionCourses(index, studyCourseIds, topicState, completionDates, null)
      : projectionCourses;
    const allSubjectsTodayTopics = focusSubjectId
      ? activeLearnTopics(activeActivities, allSubjectsProjectionCourses, index, todayLocal)
      : todayTopics;
    const upNext = {
      upcoming: projectUpcoming(finishProjectionCourses, todayTopics),
      allSubjects: focusSubjectId
        ? projectUpcoming(allSubjectsProjectionCourses, allSubjectsTodayTopics)
        : null,
      finished: finishesAtPace.finished,
    };
    const studyCourses = orderCourseIdsBySubject(index, studyCourseIds).flatMap((courseId) => {
      const course = index.coursesById.get(courseId);
      const progress = coursePayload.courses.find((item) => item.id === courseId);
      if (!course || !progress) return [];
      const unit = currentLearnerUnit(
        { activeCourseId: courseId, mastery, lessonRuns: runRows },
        index,
      );
      return [
        {
          id: course.id,
          title: course.title,
          subjectId: subjectForCourse(index, courseId).id,
          topicsDone: progress.topicsDone,
          topicsTotal: progress.topicsTotal,
          unitTitle: course.units[unit - 1]?.title ?? `Unit ${unit}`,
          estimatedFinish: finishesAtPace.byCourse.get(courseId) ?? null,
          estimatedFinishAtGoal: finishesAtGoal.byCourse.get(courseId) ?? null,
        },
      ];
    });
    const topicsDone = topics.filter((topic) => topic.status === 'complete').length;
    const estimatedFinish = finishesAtPace.byCourse.get(currentCourseId ?? '') ?? null;
    const estimatedFinishAtGoal = finishesAtGoal.byCourse.get(currentCourseId ?? '') ?? null;
    const focusedConceptIds = focusSubjectId
      ? new Set(
          studyCourseIds
            .filter((courseId) => subjectForCourse(index, courseId).id === focusSubjectId)
            .flatMap((courseId) => {
              const course = index.coursesById.get(courseId);
              return [
                ...(course?.units.flatMap((unit) => unit.concepts) ?? []),
                ...courseFoundationIds(index, courseId),
              ];
            }),
        )
      : new Set<string>();
    const dueReviewsOutsideFocus = focusSubjectId
      ? new Set(
          (schedulerState
            ? schedulerState.cards.filter((card) => Date.parse(card.dueAt) <= now.getTime())
            : await repo.dueCards(now)
          )
            .map((card) => card.conceptId)
            .filter((conceptId) => !focusedConceptIds.has(conceptId)),
        ).size
      : 0;
    return context.json({
      streak: buildStreak(events, todayLocal),
      today: {
        needsCourseChoice: needsChoice,
        courseStart: startState.courseStart,
        studyCourses,
        studyFinish: {
          atPace: finishesAtPace.overall,
          atGoal: finishesAtGoal.overall,
        },
        sessionKind: sessionKindForDate(todayLocal),
      },
      activeSubjects,
      focusSubjectId,
      dueReviewsOutsideFocus,
      upNext,
      xp: {
        total: totalXp,
        today: todayXp,
        goal: xpGoalFor(todayLocal, prefs),
        week: weekXp(events, todayLocal, prefs),
      },
      course: {
        title: coursePayload.course.title,
        percentComplete: coursePercent(topicsDone, topics.length),
        topicsDone,
        topicsTotal: topics.length,
        estimatedFinish,
        estimatedFinishAtGoal,
      },
      studyCourses,
      tasks,
      choices,
      doneToday,
      activeSessionId,
    });
  });

  api.get('/courses', async (context) => {
    const index = await deps.content();
    const repo = deps.withRepo(context);
    const now = deps.requestNow(context);
    const snapshot = await loadCourseSnapshot(deps.db, repo, index, context.get('userId'));
    const activeCourseId = snapshot.studyCourseIds[0] ?? snapshot.activeCourseId;
    const { payload } = snapshot.buildPayload(activeCourseId);
    await completePayloadCourses(repo, payload, now);
    const enrollmentByCourse = new Map(snapshot.enrollments.map((row) => [row.courseId, row]));
    const completedIds = new Set(
      payload.courses
        .filter((course) => course.topicsTotal > 0 && course.topicsDone === course.topicsTotal)
        .map((course) => course.id),
    );
    const courseOrder = orderCourseIdsBySubject(index);
    const subjects = new Map<
      string,
      Array<{
        id: string;
        title: string;
        description: string;
        topicsDone: number;
        topicsTotal: number;
        status: 'not_started' | 'active' | 'paused' | 'completed';
        startNeeded: boolean;
      }>
    >();
    for (const courseId of courseOrder) {
      const course = index.coursesById.get(courseId);
      const progress = payload.courses.find((item) => item.id === courseId);
      if (!course || !progress) continue;
      const enrollment = enrollmentByCourse.get(courseId);
      const status = completedIds.has(courseId)
        ? 'completed'
        : (enrollment?.status ?? 'not_started');
      const startState = buildCourseStartState({
        content: index,
        activeCourseId: courseId,
        mastery: snapshot.mastery,
        lessonRuns: snapshot.runs,
        enrollments: snapshot.enrollments,
        placementRuns: snapshot.placementRuns,
      });
      const subject = subjectForCourse(index, courseId);
      const rows = subjects.get(subject.id) ?? [];
      rows.push({
        id: course.id,
        title: course.title,
        description: course.description,
        topicsDone: progress.topicsDone,
        topicsTotal: progress.topicsTotal,
        status,
        startNeeded: status === 'not_started' && startState.courseStart.needed,
      });
      subjects.set(subject.id, rows);
    }
    const catalogSubjects = index.curriculum?.subjects
      ? index.curriculum.subjects.flatMap((subject) => {
          const courses = subjects.get(subject.id);
          return courses?.length ? [{ id: subject.id, title: subject.title, courses }] : [];
        })
      : [
          {
            id: 'default',
            title: index.curriculum?.subject?.title ?? 'Courses',
            courses: subjects.get('default') ?? [],
          },
        ];
    return context.json({ subjects: catalogSubjects });
  });

  api.put('/focus', async (context) => {
    const body = z
      .object({ subjectId: z.string().nullable() })
      .strict()
      .safeParse(await context.req.json().catch(() => null));
    if (!body.success) return context.json({ error: 'Invalid focus subject' }, 400);
    const index = await deps.content();
    const subjectId = body.data.subjectId;
    if (
      subjectId !== null &&
      !index.curriculum?.subjects?.some((subject) => subject.id === subjectId)
    ) {
      return context.json({ error: 'Unknown focus subject' }, 400);
    }

    await updateLearningFocus({
      db: deps.db,
      repo: deps.withRepo(context),
      userId: context.get('userId'),
      content: index,
      subjectId,
      now: deps.requestNow(context),
    });
    return context.json({ focusSubjectId: subjectId });
  });

  api.get('/courses/:id', async (context) => {
    const index = await deps.content();
    const courseId = context.req.param('id');
    if (!index.coursesById.has(courseId)) return context.json({ error: 'Course not found' }, 404);
    const repo = deps.withRepo(context);
    const snapshot = await loadCourseSnapshot(deps.db, repo, index, context.get('userId'));
    const now = deps.requestNow(context);
    const { payload } = snapshot.buildPayload(courseId);
    await completePayloadCourses(repo, payload, now);
    const completedIds = new Set(
      payload.courses
        .filter((course) => course.topicsTotal > 0 && course.topicsDone === course.topicsTotal)
        .map((course) => course.id),
    );
    const enrollmentByCourse = new Map(snapshot.enrollments.map((row) => [row.courseId, row]));
    const statuses = new Map(
      index.courses.map(
        (course) =>
          [
            course.id,
            completedIds.has(course.id)
              ? 'completed'
              : (enrollmentByCourse.get(course.id)?.status ?? 'not_started'),
          ] as const,
      ),
    );
    const status = statuses.get(courseId) ?? 'not_started';
    const course = index.coursesById.get(courseId);
    return context.json({
      ...payload,
      status,
      suggestedNext:
        status === 'completed'
          ? suggestedNextCourses(index, courseId, statuses).map((suggestion) => ({
              ...suggestion,
              reason: `Builds on ${course?.title ?? 'this course'}`,
            }))
          : [],
    });
  });

  api.get('/course', async (context) => {
    const index = await deps.content();
    const repo = deps.withRepo(context);
    await repo.studyCourseIds(index);
    const [
      masteryRows,
      activeCourseIdStored,
      runsRaw,
      paperRows,
      projectRowsRaw,
      enrollments,
      placementRuns,
      completedPlacementRuns,
    ] = await Promise.all([
      repo.masteryRecords(),
      repo.activeCourseId(),
      deps.db
        .select()
        .from(lessonRuns)
        .where(eq(lessonRuns.userId, context.get('userId'))),
      deps.db
        .select()
        .from(paperProgress)
        .where(eq(paperProgress.userId, context.get('userId'))),
      deps.db
        .select({ projectId: projectProgress.projectId, status: projectProgress.status })
        .from(projectProgress)
        .where(eq(projectProgress.userId, context.get('userId'))),
      repo.courseEnrollments(),
      repo.activePlacementRuns(),
      deps.db
        .select({ state: diagnosticRuns.state })
        .from(diagnosticRuns)
        .where(
          and(
            eq(diagnosticRuns.userId, context.get('userId')),
            eq(diagnosticRuns.kind, 'placement'),
            eq(diagnosticRuns.status, 'completed'),
          ),
        ),
    ]);
    const mastery = filterMasteryRecordsForContent(index, masteryRows);
    const requestedCourseId = context.req.query('course');
    const storedActiveCourseId = index.coursesById.has(activeCourseIdStored ?? '')
      ? (activeCourseIdStored ?? null)
      : null;
    const activeCourseId =
      requestedCourseId && index.coursesById.has(requestedCourseId)
        ? requestedCourseId
        : storedActiveCourseId;
    const runs = runsRaw.filter((run) => index.conceptsById.has(run.conceptId));
    const projectRows = projectRowsRaw.filter((project) =>
      index.projectsById.has(project.projectId),
    );
    const paperStatuses = new Map<string, 'not_started' | 'reading' | 'completed'>(
      paperRows
        .filter((row) => index.papersById.has(row.paperId))
        .map((row) => [row.paperId, row.completedAt ? 'completed' : 'reading'] as const),
    );
    const projectStatuses = new Map(projectRows.map((row) => [row.projectId, row.status]));
    const startState = buildCourseStartState({
      content: index,
      activeCourseId,
      mastery,
      lessonRuns: runs,
      enrollments,
      placementRuns,
    });
    const placedOutConcepts = placedOutConceptsFromRuns(completedPlacementRuns);
    const payload = buildCoursePayload(
      index,
      activeCourseId,
      mastery,
      runs,
      paperStatuses,
      projectStatuses,
      placedOutConcepts,
      startState.startedCourseIds,
      startState.courseStart,
    );
    await completePayloadCourses(repo, payload, deps.requestNow(context));
    return context.json(payload);
  });

  api.put('/course/active', async (context) => {
    const index = await deps.content();
    const body = (await context.req.json().catch(() => null)) as { courseId?: unknown } | null;
    if (!body || typeof body.courseId !== 'string') {
      return context.json({ error: 'Invalid courseId' }, 400);
    }
    if (!index.coursesById.has(body.courseId)) {
      return context.json({ error: 'Unknown course' }, 404);
    }
    await deps.withRepo(context).setActiveCourseId(body.courseId);
    return context.json({ courseId: body.courseId });
  });

  api.post('/concepts/:id/restart', async (context) => {
    const index = await deps.content();
    const conceptId = context.req.param('id');
    if (!index.conceptsById.has(conceptId)) {
      return context.json({ error: 'Concept not found' }, 404);
    }
    await restartTopic({ db: deps.db, userId: context.get('userId'), conceptId, content: index });
    return context.json({ conceptId });
  });

  api.put('/courses/:id/enrollment', async (context) => {
    const index = await deps.content();
    const courseId = context.req.param('id');
    if (!index.coursesById.has(courseId)) return context.json({ error: 'Course not found' }, 404);
    const body = (await context.req.json().catch(() => null)) as { status?: unknown } | null;
    if (body?.status !== 'active' && body?.status !== 'paused') {
      return context.json({ error: 'Invalid enrollment status' }, 400);
    }
    const repo = deps.withRepo(context);
    const enrollment = await repo.courseEnrollment(courseId);
    if (!enrollment) {
      return context.json(
        { error: body.status === 'active' ? 'Start this course first' : 'Course is not active' },
        409,
      );
    }
    await repo.setCourseEnrollmentStatus(courseId, body.status);
    return context.json({ id: courseId, status: body.status });
  });

  api.post('/courses/:id/start', async (context) => {
    const index = await deps.content();
    const courseId = context.req.param('id');
    if (!index.coursesById.has(courseId)) return context.json({ error: 'Course not found' }, 404);
    const body = (await context.req.json().catch(() => null)) as { method?: unknown } | null;
    if (body?.method !== 'beginning') {
      return context.json({ error: 'Invalid course start method' }, 400);
    }
    const repo = deps.withRepo(context);
    const now = deps.requestNow(context);
    const activeRuns = await repo.activePlacementRuns();
    await Promise.all(
      activeRuns
        .filter((run) => (run.state as { courseId?: unknown }).courseId === courseId)
        .map((run) =>
          deps.db
            .update(diagnosticRuns)
            .set({ status: 'abandoned' })
            .where(eq(diagnosticRuns.id, run.id)),
        ),
    );
    await repo.startCourse(courseId, 'beginning', now);
    return context.json({ courseId, method: 'beginning' });
  });

  api.post('/course/start', async (context) => {
    const body = (await context.req.json().catch(() => null)) as {
      method?: unknown;
      courseId?: unknown;
    } | null;
    if (body?.method !== 'beginning') {
      return context.json({ error: 'Invalid course start method' }, 400);
    }
    const index = await deps.content();
    const repo = deps.withRepo(context);
    const requestedCourseId =
      typeof body.courseId === 'string' && index.coursesById.has(body.courseId)
        ? body.courseId
        : null;
    const activeCourse = activeCourseFor(index, requestedCourseId ?? (await repo.activeCourseId()));
    if (!activeCourse) return context.json({ error: 'No active course' }, 404);
    await repo.startCourse(activeCourse.id, 'beginning', deps.requestNow(context));
    return context.json({ courseId: activeCourse.id, method: 'beginning' });
  });
}

async function loadCourseSnapshot(
  db: Database,
  repo: LearnerRepository,
  index: ContentIndex,
  userId: string,
) {
  const studyCourseIds = await repo.studyCourseIds(index);
  const [
    masteryRows,
    activeCourseId,
    runsRaw,
    paperRows,
    projectRowsRaw,
    enrollments,
    placementRuns,
    completedPlacementRuns,
  ] = await Promise.all([
    repo.masteryRecords(),
    repo.activeCourseId(),
    db.select().from(lessonRuns).where(eq(lessonRuns.userId, userId)),
    db.select().from(paperProgress).where(eq(paperProgress.userId, userId)),
    db
      .select({ projectId: projectProgress.projectId, status: projectProgress.status })
      .from(projectProgress)
      .where(eq(projectProgress.userId, userId)),
    repo.courseEnrollments(),
    repo.activePlacementRuns(),
    db
      .select({ state: diagnosticRuns.state })
      .from(diagnosticRuns)
      .where(
        and(
          eq(diagnosticRuns.userId, userId),
          eq(diagnosticRuns.kind, 'placement'),
          eq(diagnosticRuns.status, 'completed'),
        ),
      ),
  ]);
  const mastery = filterMasteryRecordsForContent(index, masteryRows);
  const runs = runsRaw.filter((run) => index.conceptsById.has(run.conceptId));
  const projectRows = projectRowsRaw.filter((project) => index.projectsById.has(project.projectId));
  const paperStatuses = new Map<string, 'not_started' | 'reading' | 'completed'>(
    paperRows
      .filter((row) => index.papersById.has(row.paperId))
      .map((row) => [row.paperId, row.completedAt ? 'completed' : 'reading'] as const),
  );
  const projectStatuses = new Map(projectRows.map((row) => [row.projectId, row.status]));
  const placedOutConcepts = placedOutConceptsFromRuns(completedPlacementRuns);

  return {
    studyCourseIds,
    activeCourseId: activeCourseId && index.coursesById.has(activeCourseId) ? activeCourseId : null,
    mastery,
    runs,
    paperStatuses,
    projectStatuses,
    enrollments,
    placementRuns,
    placedOutConcepts,
    buildPayload(courseId: string | null | undefined) {
      const startState = buildCourseStartState({
        content: index,
        activeCourseId: courseId,
        mastery,
        lessonRuns: runs,
        enrollments,
        placementRuns,
      });
      return {
        startState,
        payload: buildCoursePayload(
          index,
          courseId,
          mastery,
          runs,
          paperStatuses,
          projectStatuses,
          placedOutConcepts,
          startState.startedCourseIds,
          startState.courseStart,
        ),
      };
    },
  };
}

async function completePayloadCourses(
  repo: LearnerRepository,
  payload: ReturnType<typeof buildCoursePayload>,
  completedAt: Date,
) {
  const completedCourseIds = payload.courses
    .filter((course) => course.topicsTotal > 0 && course.topicsDone === course.topicsTotal)
    .map((course) => course.id);
  if (completedCourseIds.length === 0) return;
  const enrollments = await repo.courseEnrollments();
  const newlyCompleted = completedCourseIds.filter(
    (courseId) =>
      !enrollments.some(
        (enrollment) => enrollment.courseId === courseId && enrollment.status === 'completed',
      ),
  );
  await repo.completeCourses(newlyCompleted, completedAt);
}

function plannedActivities(
  state: Awaited<ReturnType<LearnerRepository['schedulerState']>>,
  index: ContentIndex,
  preferences: unknown,
  timeZone: string,
  now: Date,
): PlannedActivity[] {
  const prefs = (preferences ?? {}) as SessionPreferences;
  const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone }).format(now);
  const kind: SessionKind =
    weekday === 'Sat' ? 'saturday' : weekday === 'Sun' ? 'sunday' : 'weekday';
  return planSession(
    state,
    index,
    now,
    sessionBudget(kind, prefs, localDateKey(now, timeZone)),
    kind,
  ).activities;
}

function projectedDayLabel(date: string, today: string): string {
  const days = Math.round(
    (Date.parse(`${date}T00:00:00.000Z`) - Date.parse(`${today}T00:00:00.000Z`)) / 86_400_000,
  );
  if (days <= 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  const value = new Date(`${date}T12:00:00.000Z`);
  if (days < 7)
    return new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'UTC' }).format(value);
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(value);
}

async function getProblemsByRun(db: Database, runIds: string[]) {
  if (runIds.length === 0) return new Map<string, Array<typeof lessonProblems.$inferSelect>>();
  const rows = await db.select().from(lessonProblems).where(inArray(lessonProblems.runId, runIds));
  const byRun = new Map<string, Array<typeof lessonProblems.$inferSelect>>();
  for (const row of rows) {
    const runRows = byRun.get(row.runId) ?? [];
    runRows.push(row);
    byRun.set(row.runId, runRows);
  }
  return byRun;
}

function activityLabel(
  kind: string,
): 'Lesson' | 'Review' | 'Practice' | 'Project' | 'Quiz' | 'Paper' {
  if (kind === 'learn') return 'Lesson';
  if (kind === 'review') return 'Review';
  if (kind === 'lab') return 'Project';
  if (kind === 'paper') return 'Paper';
  if (kind === 'quick_check') return 'Quiz';
  return 'Practice';
}

function titleForKind(kind: string): string {
  if (kind === 'paper') return 'Paper reading';
  if (kind === 'quick_check') return 'Quick check';
  if (kind === 'reflect') return 'Reflection';
  if (kind === 'teachback') return 'Teach-back';
  if (kind === 'practice') return 'Mixed practice';
  return activityLabel(kind);
}
