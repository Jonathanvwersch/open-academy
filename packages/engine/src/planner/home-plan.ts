import type { ContentIndex } from '../course/types.js';
import {
  filterSchedulerStateForContent,
  sessionActivityIsInContent,
} from '../graph/content-filters.js';
import { buildCourseStartState, needsCourseChoice } from '../graph/course-start.js';
import { topicIsComplete } from '../graph/course-status.js';
import { activeCourseFor } from '../graph/prerequisites.js';
import { activePlacementRuns } from '../placement/diagnostic-commands.js';
import { localDateKey, sessionKindForDate } from '../progress/xp.js';
import { quizOffer } from '../quizzes/quiz-offer.js';
import type { FlowStore } from '../store/flow-store.js';
import type { Activity, Session } from '../store/session-store.js';
import { reviewTopicsForActivity } from './review-topics.js';
import {
  currentLearnerUnit,
  type PlannedActivity,
  planSession,
  type SchedulerState,
  type SessionPreferences,
  sessionBudget,
} from './scheduler.js';

interface HomeReads {
  schedulerState(now: Date, content: ContentIndex): Promise<SchedulerState>;
  user(): Promise<{ prefs: unknown } | undefined>;
  activeSession(now: Date): Promise<Session | undefined>;
  courseEnrollments(): Promise<readonly { courseId: string }[]>;
  session(sessionId: string): Promise<(Session & { activities: Activity[] }) | undefined>;
  attemptedExerciseIdsByActivity(ids: readonly string[]): Promise<Map<string, Set<string>>>;
  completeCourses(ids: readonly string[], now: Date): Promise<void>;
}

export function withReviewTopics<
  T extends { kind: string; exerciseIds: string[]; status?: string },
>(activity: T, index: ContentIndex, attemptedExerciseIds?: ReadonlySet<string>) {
  if (activity.kind !== 'review') return activity;
  return {
    ...activity,
    reviewTopics: reviewTopicsForActivity(activity, index, attemptedExerciseIds),
    allReviewTopics: reviewTopicsForActivity(activity, index),
  };
}

export async function loadHomePlan(
  store: FlowStore,
  learnerId: string,
  repo: HomeReads,
  index: ContentIndex,
  now: Date,
  timeZone: string,
  tutorEnabled: boolean,
) {
  const state = filterSchedulerStateForContent(index, await repo.schedulerState(now, index));
  const user = await repo.user();
  const prefs = (user?.prefs ?? {}) as SessionPreferences & { goal?: string };
  const subjectTitle = index.curriculum?.subject?.title;
  const sessionKind = sessionKindForDate(localDateKey(now, timeZone));
  const budget = sessionBudget(sessionKind, prefs, localDateKey(now, timeZone));
  const availableQuiz = await quizOffer(
    store,
    learnerId,
    index,
    now,
    state.activeCourseId,
    user ?? null,
  );
  state.pendingQuiz =
    availableQuiz.plannedMinutes === undefined
      ? undefined
      : { plannedMinutes: availableQuiz.plannedMinutes };
  const [active, enrollments, placementRuns] = await Promise.all([
    repo.activeSession(now),
    repo.courseEnrollments(),
    activePlacementRuns(store, learnerId),
  ]);
  const placementCourseId = placementRuns
    .map((run) => run.courseId)
    .find((id): id is string => typeof id === 'string' && index.coursesById.has(id));
  const currentCourseId = placementCourseId ?? state.studyCourseIds[0] ?? state.activeCourseId;
  const activeSession = active ? await repo.session(active.id) : undefined;
  const hasCurrentActivity =
    !activeSession ||
    activeSession.activities.length === 0 ||
    activeSession.activities.some(
      (activity) =>
        (activity.status === 'planned' || activity.status === 'in_progress') &&
        sessionActivityIsInContent(index, activity),
    );
  const activeSessionId = hasCurrentActivity ? (active?.id ?? null) : null;
  const activeActivities =
    activeSessionId && activeSession
      ? activeSession.activities.filter(
          (activity) =>
            (activity.status === 'planned' || activity.status === 'in_progress') &&
            sessionActivityIsInContent(index, activity),
        )
      : [];
  const inProgressReviewActivityIds = activeActivities
    .filter((activity) => activity.kind === 'review' && activity.status === 'in_progress')
    .map((activity) => activity.id);
  const attemptedByActivity = await repo.attemptedExerciseIdsByActivity(
    inProgressReviewActivityIds,
  );
  const plan =
    activeSessionId && activeSession
      ? {
          activities: activeActivities.map(
            (activity): PlannedActivity => ({
              kind: activity.kind,
              conceptId: activity.conceptId,
              projectId: activity.projectId ?? undefined,
              exerciseIds: activity.exerciseIds,
              plannedMinutes: activity.plannedMinutes,
              reason: activity.reason as PlannedActivity['reason'],
              status: activity.status as PlannedActivity['status'],
            }),
          ),
          reasons: activeActivities.map((activity) => activity.reason as PlannedActivity['reason']),
        }
      : planSession(state, index, now, budget, sessionKind);
  const startState = buildCourseStartState({
    content: index,
    activeCourseId: currentCourseId,
    mastery: state.mastery,
    lessonRuns: state.lessonRuns ?? [],
    enrollments,
    placementRuns,
  });
  const course = activeCourseFor(index, currentCourseId);
  const unit = currentLearnerUnit({ ...state, activeCourseId: currentCourseId }, index);
  const unitFocus = course?.units[unit - 1];
  const runsByConcept = new Map((state.lessonRuns ?? []).map((run) => [run.conceptId, run.status]));
  const masteryByConcept = new Map<string, typeof state.mastery>();
  for (const record of state.mastery) {
    const records = masteryByConcept.get(record.conceptId) ?? [];
    records.push(record);
    masteryByConcept.set(record.conceptId, records);
  }
  const studyCourses = state.studyCourseIds.flatMap((courseId) => {
    const studyCourse = index.coursesById.get(courseId);
    if (!studyCourse) return [];
    const topics = studyCourse.units.flatMap((studyUnit) => studyUnit.concepts);
    const topicsDone = topics.filter((conceptId) => {
      const concept = index.conceptsById.get(conceptId);
      if (!concept) return false;
      const states = concept.dimensions.map(
        (dimension) =>
          masteryByConcept.get(conceptId)?.find((record) => record.dimension === dimension)
            ?.state ?? 'not_assessed',
      );
      return topicIsComplete(runsByConcept.get(conceptId), states);
    }).length;
    const courseUnit = currentLearnerUnit({ ...state, activeCourseId: courseId }, index);
    return [
      {
        id: courseId,
        title: studyCourse.title,
        topicsDone,
        topicsTotal: topics.length,
        unitTitle: studyCourse.units[courseUnit - 1]?.title ?? `Unit ${courseUnit}`,
      },
    ];
  });
  const completedCourseIds = studyCourses
    .filter(
      (studyCourse) =>
        studyCourse.topicsTotal > 0 && studyCourse.topicsDone === studyCourse.topicsTotal,
    )
    .map((studyCourse) => studyCourse.id);
  await repo.completeCourses(completedCourseIds, now);
  return {
    needsCourseChoice: needsCourseChoice({
      activeCourseId: state.activeCourseId,
      studyCourseIds: state.studyCourseIds,
      mastery: state.mastery,
      lessonRuns: state.lessonRuns ?? [],
      activePlacementRuns: placementRuns,
    }),
    courseStart: startState.courseStart,
    studyCourses,
    objective:
      unitFocus?.title ??
      prefs.goal ??
      (subjectTitle ? `Make steady progress in ${subjectTitle}.` : 'Make steady progress.'),
    courseTitle: course?.title ?? '',
    unitTitle: unitFocus?.title ?? `Unit ${unit}`,
    unit,
    dueReviews: new Set(
      plan.activities.flatMap((activity, activityIndex) => {
        const activeActivity =
          activeSessionId && activeSession ? activeActivities[activityIndex] : undefined;
        return activity.kind === 'review'
          ? reviewTopicsForActivity(
              activity,
              index,
              activeActivity ? attemptedByActivity.get(activeActivity.id) : undefined,
            ).map((topic) => topic.conceptId)
          : [];
      }),
    ).size,
    budgetMinutes: budget,
    quizOffer: {
      xpBalance: availableQuiz.xpBalance,
      plannedMinutes: availableQuiz.plannedMinutes ?? null,
      active: Boolean(availableQuiz.active),
    },
    sessionKind,
    activeSessionId,
    tutorEnabled,
    plan: {
      ...plan,
      activities: plan.activities.map((activity, activityIndex) => {
        const activeActivity =
          activeSessionId && activeSession ? activeActivities[activityIndex] : undefined;
        return withReviewTopics(
          {
            ...activity,
            conceptTitle: activity.conceptId
              ? index.conceptsById.get(activity.conceptId)?.title
              : undefined,
          },
          index,
          activeActivity ? attemptedByActivity.get(activeActivity.id) : undefined,
        );
      }),
    },
  };
}
