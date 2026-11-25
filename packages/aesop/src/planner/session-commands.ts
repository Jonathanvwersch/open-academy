import type { ContentIndex, IndexedLesson } from '../course/types.js';
import { filterSchedulerStateForContent } from '../graph/content-filters.js';
import {
  compareOutlinePosition,
  createPrerequisiteChecker,
  masteryKey,
} from '../graph/prerequisites.js';
import { isLessonRetryReady } from '../lessons/lesson-retry.js';
import { localDateKey, sessionKindForDate } from '../progress/xp.js';
import type { Id, NewRow } from '../store/core-store.js';
import type { Activity, Session, SessionStore } from '../store/session-store.js';
import { withReviewTopics } from './home-plan.js';
import {
  type PlannedActivity,
  planSession,
  replan,
  type SchedulerState,
  type SessionPreferences,
  sessionBudget,
} from './scheduler.js';

type InitialProgress = (
  activity: PlannedActivity,
  lesson: IndexedLesson | undefined,
) => Promise<unknown>;

export async function plannedActivityRow(
  activity: PlannedActivity,
  idx: number,
  status: Activity['status'],
  initialProgress: InitialProgress,
  index: ContentIndex,
): Promise<NewRow<Omit<Activity, 'sessionId'>>> {
  const progress = await initialProgress(
    activity,
    activity.conceptId ? index.lessonsByConcept.get(activity.conceptId) : undefined,
  );
  return {
    idx,
    status,
    progress: progress || {},
    reason: activity.reason,
    kind: activity.kind,
    conceptId: activity.conceptId ?? null,
    projectId: activity.projectId ?? null,
    exerciseIds: activity.exerciseIds,
    plannedMinutes: activity.plannedMinutes,
    startedAt: null,
    completedAt: null,
  };
}

export async function createSession(
  store: SessionStore,
  learnerId: Id,
  index: ContentIndex,
  now: Date,
  timeZone: string,
  input: { kind?: Session['kind']; budgetMinutes?: number; focusConceptId?: Id },
  reads: {
    schedulerState(now: Date, content: ContentIndex): Promise<SchedulerState>;
    preferences(): Promise<SessionPreferences>;
    quizOffer(
      content: ContentIndex,
      now: Date,
      courseId: string | null,
    ): Promise<{ plannedMinutes?: number }>;
    initialProgress: InitialProgress;
  },
) {
  const sessionKind = input.kind ?? sessionKindForDate(localDateKey(now, timeZone));
  const state = filterSchedulerStateForContent(index, await reads.schedulerState(now, index));
  const prefs = await reads.preferences();
  const budgetMinutes =
    input.budgetMinutes ?? sessionBudget(sessionKind, prefs, localDateKey(now, timeZone));
  if (input.focusConceptId) {
    const focusConcept = index.conceptsById.get(input.focusConceptId);
    if (!focusConcept) {
      return { kind: 'not_found' as const, error: 'Concept not found' };
    }
    if (focusConcept.status === 'stub') {
      return { kind: 'conflict' as const, error: 'Concept is not yet authored' };
    }
    const retryRun = state.lessonRuns?.find(
      (run) => run.conceptId === focusConcept.id && run.status === 'needs_retry',
    );
    if (retryRun) {
      const retryAfter = retryRun.retryAfter ? new Date(retryRun.retryAfter) : undefined;
      if (!isLessonRetryReady(retryAfter, false, now)) {
        return { kind: 'conflict' as const, error: 'This lesson comes back tomorrow.' };
      }
      const reviewFirstIds = [
        ...new Set(
          state.remediationFlags
            .filter(
              (flag) =>
                flag.conceptId === focusConcept.id &&
                (flag.status === undefined || flag.status === 'open'),
            )
            .map((flag) => flag.targetPrereqId ?? focusConcept.id),
        ),
      ];
      if (!isLessonRetryReady(retryAfter, reviewFirstIds.length > 0, now)) {
        const titles = reviewFirstIds.map((id) => index.conceptsById.get(id)?.title ?? id);
        return { kind: 'conflict' as const, error: `Review ${titles.join(' and ')} first.` };
      }
    }
    const masteryByKey = new Map(
      state.mastery.map((record) => [masteryKey(record.conceptId, record.dimension), record]),
    );
    const prerequisiteChecker = createPrerequisiteChecker(
      masteryByKey,
      state.lessonRuns ?? [],
      index,
    );
    const missingPrerequisiteId = prerequisiteChecker
      .missingFrontier(focusConcept.id)
      .sort((left, right) => compareOutlinePosition(left, right, index, state.activeCourseId))[0];
    if (!prerequisiteChecker.chainReady(focusConcept.id)) {
      const firstMissingId =
        missingPrerequisiteId ??
        focusConcept.prereqs
          .filter((prerequisite) => prerequisite.strength === 'hard')
          .map((prerequisite) => prerequisite.id)
          .sort((left, right) =>
            compareOutlinePosition(left, right, index, state.activeCourseId),
          )[0] ??
        focusConcept.id;
      const prerequisiteTitle = index.conceptsById.get(firstMissingId)?.title ?? firstMissingId;
      return { kind: 'conflict' as const, error: `Finish ${prerequisiteTitle} first` };
    }
    state.inProgressConceptId = input.focusConceptId;
  }
  const availableQuiz = await reads.quizOffer(index, now, state.activeCourseId);
  state.pendingQuiz =
    availableQuiz.plannedMinutes === undefined
      ? undefined
      : { plannedMinutes: availableQuiz.plannedMinutes };
  const plan = planSession(state, index, now, budgetMinutes, sessionKind, undefined, undefined, {
    focusConceptId: input.focusConceptId,
  });
  if (
    input.focusConceptId &&
    !plan.activities.some(
      (activity) =>
        (activity.kind === 'learn' || activity.kind === 'practice') &&
        activity.conceptId === input.focusConceptId,
    )
  ) {
    return { kind: 'conflict' as const, error: 'No eligible exercise exists for this concept.' };
  }
  await store.patchSessions(learnerId, { status: 'active' }, { status: 'abandoned', endedAt: now });
  const session = await store.insertSession(learnerId, {
    kind: sessionKind,
    plannedMinutes: budgetMinutes,
    startedAt: now,
    endedAt: null,
    status: 'active',
    plan: { activities: plan.activities, reasons: plan.reasons, schedulerVersion: '1' },
    activeSeconds: 0,
  });
  const activities = await Promise.all(
    plan.activities.map(async (activity, idx) => {
      const row = await plannedActivityRow(
        activity,
        idx,
        idx === 0 ? 'in_progress' : 'planned',
        reads.initialProgress,
        index,
      );
      const [created] = await store.insertActivities(learnerId, session.id, [row]);
      if (!created) throw new Error('Unable to insert session activity');
      return withReviewTopics(created, index);
    }),
  );
  return { kind: 'created' as const, session: { ...session, userId: learnerId, activities } };
}

export async function replacePlannedActivities(
  store: SessionStore,
  learnerId: Id,
  session: Session & { activities: Activity[] },
  index: ContentIndex,
  now: Date,
  remainingBudgetMinutes: number | undefined,
  reads: {
    schedulerState(now: Date, content: ContentIndex): Promise<SchedulerState>;
    attemptedExerciseIdsByActivity(ids: readonly Id[]): Promise<Map<Id, Set<Id>>>;
    initialProgress: InitialProgress;
  },
) {
  if ((session.plan as { quizFollowUp?: string }).quizFollowUp) {
    return { activities: session.activities.map((activity) => withReviewTopics(activity, index)) };
  }
  const state = await reads.schedulerState(now, index);
  const activities = session.activities.map((activity) => ({
    ...activity,
    projectId: activity.projectId ?? undefined,
    reason: activity.reason as PlannedActivity['reason'],
  }));
  const existingMinutes = activities
    .filter((activity) => activity.status === 'completed' || activity.status === 'in_progress')
    .reduce((total, activity) => total + activity.plannedMinutes, 0);
  const remaining = remainingBudgetMinutes ?? Math.max(0, session.plannedMinutes - existingMinutes);
  const plan = replan(state, index, now, remaining, activities, session.kind);
  const planned = session.activities.filter((activity) => activity.status === 'planned');
  await Promise.all(
    planned.map((activity) => store.deleteActivities(learnerId, { ids: [activity.id] })),
  );
  const preserved = session.activities.filter((activity) => activity.status !== 'planned');
  const nextIndex = Math.max(-1, ...preserved.map((activity) => activity.idx)) + 1;
  const created = await Promise.all(
    plan.activities
      .filter((activity) => activity.status !== 'in_progress')
      .map(async (activity, idx) => {
        const row = await plannedActivityRow(
          activity,
          nextIndex + idx,
          'planned',
          reads.initialProgress,
          index,
        );
        const [inserted] = await store.insertActivities(learnerId, session.id, [row]);
        if (!inserted) throw new Error('Unable to insert session activity');
        return inserted;
      }),
  );
  const inProgressReviewIds = preserved
    .filter((activity) => activity.kind === 'review' && activity.status === 'in_progress')
    .map((activity) => activity.id);
  const attemptedByActivity = await reads.attemptedExerciseIdsByActivity(inProgressReviewIds);
  return {
    activities: [...preserved, ...created].map((activity) =>
      withReviewTopics(activity, index, attemptedByActivity.get(activity.id)),
    ),
  };
}

export async function endSession(
  store: SessionStore,
  learnerId: Id,
  previous: Session,
  endedAt: Date,
) {
  const elapsedSeconds = previous.startedAt
    ? Math.max(0, Math.floor((endedAt.getTime() - previous.startedAt.getTime()) / 1000))
    : 0;
  const query = { ids: [previous.id] };
  await store.patchSessions(learnerId, query, {
    endedAt,
    status: 'completed',
    activeSeconds: previous.activeSeconds + elapsedSeconds,
  });
  const [session] = await store.listSessions(learnerId, query);
  return session && { ...session, userId: learnerId };
}
