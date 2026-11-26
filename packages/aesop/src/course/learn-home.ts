import { orderCourseIdsBySubject } from '../course/course-order.js';
import { subjectForCourse } from '../course/index.js';
import type { ContentIndex } from '../course/types.js';
import {
  filterMasteryRecordsForContent,
  filterSchedulerStateForContent,
  sessionActivityIsInContent,
} from '../graph/content-filters.js';
import { buildCourseStartState, needsCourseChoice } from '../graph/course-start.js';
import { topicIsComplete } from '../graph/course-status.js';
import {
  courseFoundationIds,
  createPrerequisiteChecker,
  labActivityReady,
  learnActivitiesWithUnmetPrerequisites,
  masteryKey,
} from '../graph/prerequisites.js';
import { isLessonRetryReady } from '../lessons/lesson-retry.js';
import { deriveLessonState } from '../lessons/lesson-runner.js';
import { isDueToday, startOfNextCalendarDay } from '../memory/fsrs.js';
import { masteryRank } from '../memory/types.js';
import { activePlacementRuns } from '../placement/diagnostic-commands.js';
import {
  courseTopicAttribution,
  type ProjectionCourse,
  projectCourseFinishes,
} from '../planner/finish-projection.js';
import {
  attemptedExerciseIdsByActivity as groupAttemptedExerciseIdsByActivity,
  reviewTopicsForActivity,
} from '../planner/review-topics.js';
import type { PlannedActivity, SchedulerState, SessionPreferences } from '../planner/scheduler.js';
import {
  currentLearnerUnit,
  effectiveFocusSubjectId,
  isLearnableConcept,
  planSession,
  type SessionKind,
  schedulerRecentLearnMinutesBySubject,
  sessionBudget,
} from '../planner/scheduler.js';
import { buildStreak } from '../progress/streak.js';
import {
  averageDailyXp,
  coursePercent,
  defaultAverageDailyXp,
  estimateTaskXp,
  localDateKey,
  sessionKindForDate,
  weekXp,
  xpGoalFor,
} from '../progress/xp.js';
import { quizOffer } from '../quizzes/quiz-offer.js';
import type { CourseStore } from '../store/course-store.js';
import type { LessonProblem } from '../store/lesson-store.js';
import type { Activity } from '../store/session-store.js';
import {
  buildCoursePayload,
  courseTopicState,
  placedOutConceptsFromGrants,
} from './course-payload.js';
import { CourseReader, type CourseReadInput } from './course-reader.js';
import { replanSessionActivities } from './progress-commands.js';

type ActivityRecord = Activity;

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

export async function getLearnHome(store: CourseStore, input: CourseReadInput) {
  const { userId, content: index, timeZone } = input;
  const now = input.now();
  const reader = new CourseReader(store, input);
  const [runRowsRaw, completedRowsRaw, projectRowsRaw] = await Promise.all([
    store.listLessonRuns(userId),
    store.listCompletedActivities(userId),
    store.listProjectProgress(userId),
  ]);
  const runRows = runRowsRaw.filter((run) => index.conceptsById.has(run.conceptId));
  const completedRows = completedRowsRaw.filter((activity) =>
    sessionActivityIsInContent(index, activity),
  );
  const recentLearnMinutesByConcept: Record<string, number> = {};
  const recentLearnCutoff = new Date(now.getTime() - 7 * 86_400_000);
  for (const activity of completedRows) {
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
  const projectRows = projectRowsRaw.filter((project) => index.projectsById.has(project.projectId));
  const [masteryRows, user, events, active, placementRuns, enrollments, completedPlacementRuns] =
    await Promise.all([
      store.listMastery(userId),
      reader.settings(),
      store.listXpEvents(userId, {}),
      reader.activeSession(now),
      activePlacementRuns(store, userId),
      reader.enrollments(),
      store.listPlacementGrants(userId),
    ]);
  const mastery = filterMasteryRecordsForContent(index, masteryRows);
  const activeCourseId = index.coursesById.has(user?.activeCourseId ?? '')
    ? (user?.activeCourseId ?? null)
    : null;
  const studyCourseIds = await reader.studyCourseIds();
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
  const placedOutConcepts = placedOutConceptsFromGrants(completedPlacementRuns);
  const todayLocal = localDateKey(now, timeZone);
  const totalXp = events.reduce((total, event) => total + event.amount, 0);
  const todayXp = events
    .filter((event) => event.localDate === todayLocal)
    .reduce((total, event) => total + event.amount, 0);
  const projectStatuses = new Map(projectRows.map((row) => [row.projectId, row.status]));
  const runsByConcept = new Map(runRows.map((run) => [run.conceptId, run]));
  const problemsByRun = await getProblemsByRun(
    store,
    userId,
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
        masteryByConcept.get(conceptId)?.find((record) => record.dimension === dimension)?.state ??
        'not_assessed',
    );
    return topicIsComplete(runsByConcept.get(conceptId)?.status, states);
  };

  let activeSession = active ? await reader.session(active.id, active) : undefined;
  let schedulerState: SchedulerState | undefined;
  const loadSchedulerState = async () => {
    schedulerState ??= filterSchedulerStateForContent(
      index,
      await reader.schedulerState(now, {
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
  const prerequisiteChecker = createPrerequisiteChecker(masteryByKey, lessonRunState, index);
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
    await replanSessionActivities(store, {
      userId,
      content: index,
      now,
      session: activeSession,
      skipActivityIds: blockedActivities,
      schedulerState: await loadSchedulerState(),
    });
    activeSession = await reader.session(activeSession.id);
  }
  const activeActivities =
    activeSession?.activities.filter(
      (activity) =>
        (activity.status === 'planned' || activity.status === 'in_progress') &&
        sessionActivityIsInContent(index, activity) &&
        labActivityReady(activity, masteryByKey, lessonRunState, index),
    ) ?? [];
  const inProgressReviewActivityIds = activeActivities
    .filter((activity) => activity.kind === 'review' && activity.status === 'in_progress')
    .map((activity) => activity.id);
  const attemptedExerciseIdsByActivity = inProgressReviewActivityIds.length
    ? groupAttemptedExerciseIdsByActivity(
        await store.listAttempts(userId, {
          activityIds: inProgressReviewActivityIds,
          order: 'unordered',
        }),
      )
    : new Map<string, Set<string>>();
  const activeSessionId =
    activeSession && (activeSession.activities.length === 0 || activeActivities.length > 0)
      ? (active?.id ?? null)
      : null;
  const activities: Array<ActivityRecord | PlannedActivity> = activeSessionId
    ? activeActivities
    : await plannedActivities(
        store,
        userId,
        await loadSchedulerState(),
        index,
        prefs,
        timeZone,
        now,
      );

  const tasks = activities.map((activity, taskIndex) => {
    const conceptId = activity.conceptId;
    const concept = conceptId ? index.conceptsById.get(conceptId) : undefined;
    const attemptedExerciseIds =
      'id' in activity ? attemptedExerciseIdsByActivity.get(activity.id) : undefined;
    const reviewTopics =
      activity.kind === 'review'
        ? reviewTopicsForActivity(activity, index, attemptedExerciseIds)
        : [];
    const lesson = conceptId ? index.lessonsByConcept.get(conceptId) : undefined;
    const run = conceptId ? runsByConcept.get(conceptId) : undefined;
    const lessonState =
      activity.kind === 'learn' && lesson?.knowledge_points?.length
        ? run
          ? deriveLessonState(
              lesson,
              problemsByRun.get(run.id) ?? [],
              index.exercisesById,
              run.quizPassedAt,
              run.attempt,
            )
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
    const reasonSummary = (activity.reason as { summary?: string }).summary;
    return {
      id: 'id' in activity ? activity.id : `planned-${taskIndex}`,
      activityKind: activity.kind,
      label: activityLabel(activity.kind),
      ...(conceptId ? { conceptId } : {}),
      ...(activity.kind === 'review' && reasonSummary?.includes(' before retrying ')
        ? { reason: reasonSummary }
        : {}),
      title:
        reviewTopics.length > 1
          ? 'Mixed review'
          : (reviewTopics[0]?.title ??
            concept?.title ??
            project?.title ??
            titleForKind(activity.kind)),
      ...(reviewTopics.length ? { reviewTopics } : {}),
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
  const choiceSchedulerState = activeSessionId ? undefined : await loadSchedulerState();
  const openRemediationFlags = choiceSchedulerState?.remediationFlags ?? [];
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
          !prerequisiteChecker.chainReady(conceptId)
        ) {
          return [];
        }
        const run = runsByConcept.get(conceptId);
        const hasOpenFlags = openRemediationFlags
          .filter((flag) => flag.conceptId === conceptId)
          .some((flag) => flag.status === undefined || flag.status === 'open');
        if (
          run?.status === 'needs_retry' &&
          !isLessonRetryReady(run.retryAfter, hasOpenFlags, now)
        ) {
          return [];
        }
        const lessonState = lesson.knowledge_points?.length
          ? run
            ? deriveLessonState(
                lesson,
                problemsByRun.get(run.id) ?? [],
                index.exercisesById,
                run.quizPassedAt,
                run.attempt,
              )
            : { points: lesson.knowledge_points.map(() => ({ status: 'active' })) }
          : undefined;
        return [
          {
            conceptId,
            title: concept.title,
            xp: estimateTaskXp({ kind: 'learn', plannedMinutes: concept.est_minutes }, lessonState),
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

  const todayDone = completedRows.filter(
    (activity) =>
      activity.completedAt && localDateKey(activity.completedAt, timeZone) === todayLocal,
  );
  const mixedQuizActivityIds = todayDone
    .filter((activity) => activity.kind === 'mixed_quiz')
    .map((activity) => activity.id);
  const mixedQuizRuns = mixedQuizActivityIds.length
    ? await store.listTimedQuizRuns(userId, { activityIds: mixedQuizActivityIds, original: true })
    : [];
  const mixedQuizXpByActivity = new Map<string, number>();
  for (const run of mixedQuizRuns) {
    if (!run.activityId) continue;
    const runXp = events
      .filter(
        (event) => event.localDate === todayLocal && event.sourceKey === `mixed-quiz:${run.id}`,
      )
      .reduce((total, event) => total + event.amount, 0);
    mixedQuizXpByActivity.set(
      run.activityId,
      (mixedQuizXpByActivity.get(run.activityId) ?? 0) + runXp,
    );
  }
  const doneToday = todayDone.map((activity) => {
    const run =
      activity.kind === 'learn' && activity.conceptId
        ? runsByConcept.get(activity.conceptId)
        : undefined;
    const activityXp = events
      .filter(
        (event) => event.sourceKey === `activity:${activity.id}` && event.localDate === todayLocal,
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
    const mixedQuizXp =
      activity.kind === 'mixed_quiz' ? (mixedQuizXpByActivity.get(activity.id) ?? 0) : 0;
    return {
      activityId: activity.id,
      label: activityLabel(activity.kind),
      title:
        (activity.conceptId && index.conceptsById.get(activity.conceptId)?.title) ??
        (activity.projectId && index.projectsById.get(activity.projectId)?.title) ??
        titleForKind(activity.kind),
      xp: activityXp + lessonXp + mixedQuizXp,
      completedAt: activity.completedAt?.toISOString(),
    };
  });

  const courseRemediationFlags = runRows.some((run) => run.status === 'needs_retry')
    ? await store.listRemediationFlags(userId, { status: 'open' })
    : [];
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
    courseRemediationFlags,
  );
  await reader.completePayloadCourses(coursePayload, now);
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
    const completionEvents = await store.listCourseMasteryEvents(userId, conceptsWithoutRunDates);
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
  const projectionSchedulerState: Pick<
    SchedulerState,
    | 'activeCourseId'
    | 'studyCourseIds'
    | 'focusSubjectId'
    | 'mastery'
    | 'lessonRuns'
    | 'recentLearnMinutesByConcept'
  > = schedulerState ?? {
    activeCourseId,
    studyCourseIds,
    focusSubjectId: focusSubjectId ?? undefined,
    mastery,
    lessonRuns: runRows,
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
  const projectUpcoming = (
    courses: ProjectionCourse[],
    topicsForToday: typeof todayTopics,
    spentBySubject: Record<string, number>,
  ) => {
    const todayConceptIds = new Set(topicsForToday.map((topic) => topic.conceptId));
    const projection = projectCourseFinishes({
      courses,
      dailyXp: dailyXpAtPace,
      today: addLocalDays(todayLocal, topicsForToday.length > 0 ? 1 : 0),
      assumedDoneConceptIds: todayConceptIds,
      spentBySubject,
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
  const allSubjectsRecentLearnMinutesBySubject = focusSubjectId
    ? schedulerRecentLearnMinutesBySubject(
        { ...projectionSchedulerState, focusSubjectId: undefined },
        index,
      )
    : recentLearnMinutesBySubject;
  const allSubjectsTodayTopics = focusSubjectId
    ? activeLearnTopics(activeActivities, allSubjectsProjectionCourses, index, todayLocal)
    : todayTopics;
  const upNext = {
    upcoming: projectUpcoming(finishProjectionCourses, todayTopics, recentLearnMinutesBySubject),
    allSubjects: focusSubjectId
      ? projectUpcoming(
          allSubjectsProjectionCourses,
          allSubjectsTodayTopics,
          allSubjectsRecentLearnMinutesBySubject,
        )
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
          ? schedulerState.cards
              .filter((card) => isDueToday(card.dueAt, now, timeZone))
              .map((card) => card.conceptId)
          : await store.listDueReviewConcepts(userId, startOfNextCalendarDay(now, timeZone))
        )
          .filter((conceptId) => {
            const concept = index.conceptsById.get(conceptId);
            return concept !== undefined && concept.status !== 'stub';
          })
          .filter((conceptId) => !focusedConceptIds.has(conceptId)),
      ).size
    : 0;
  return {
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
  };
}

async function plannedActivities(
  store: CourseStore,
  userId: string,
  state: SchedulerState,
  index: ContentIndex,
  preferences: unknown,
  timeZone: string,
  now: Date,
): Promise<PlannedActivity[]> {
  const prefs = (preferences ?? {}) as SessionPreferences;
  const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone }).format(now);
  const kind: SessionKind =
    weekday === 'Sat' ? 'saturday' : weekday === 'Sun' ? 'sunday' : 'weekday';
  const { plannedMinutes } = await quizOffer(store, userId, index, now, state.activeCourseId, {
    prefs,
  });
  return planSession(
    { ...state, pendingQuiz: plannedMinutes === undefined ? undefined : { plannedMinutes } },
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

async function getProblemsByRun(store: CourseStore, userId: string, runIds: string[]) {
  const rows = await store.listCourseLessonProblems(userId, runIds);
  const byRun = new Map<string, LessonProblem[]>();
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
  if (kind === 'quick_check' || kind === 'mixed_quiz') return 'Quiz';
  return 'Practice';
}

function titleForKind(kind: string): string {
  if (kind === 'paper') return 'Paper reading';
  if (kind === 'quick_check') return 'Quick check';
  if (kind === 'mixed_quiz') return 'Timed quiz';
  if (kind === 'reflect') return 'Reflection';
  if (kind === 'teachback') return 'Teach-back';
  if (kind === 'practice') return 'Mixed practice';
  return activityLabel(kind);
}
