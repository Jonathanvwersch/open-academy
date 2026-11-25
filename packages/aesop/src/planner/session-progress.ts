import type { ContentIndex } from '../course/types.js';
import { filterSchedulerStateForContent } from '../graph/content-filters.js';
import { learnActivitiesWithUnmetPrerequisites, masteryKey } from '../graph/prerequisites.js';
import { recordLessonViewed } from '../memory/mastery.js';
import {
  completeReviewActivity,
  recordRecoveredReviewRatings,
} from '../memory/review-completion.js';
import type { Id } from '../store/core-store.js';
import type { FlowStore } from '../store/flow-store.js';
import type { Activity, Session } from '../store/session-store.js';
import { advanceActivity } from './activity-advance.js';
import { withReviewTopics } from './home-plan.js';
import type { SchedulerState } from './scheduler.js';

export type OwnedSession = Session & { userId: Id };
type LoadedSession = OwnedSession & { activities: Activity[] };

interface ProgressReads {
  content(): Promise<ContentIndex>;
  session(id: Id): Promise<LoadedSession | undefined>;
  schedulerState(now: Date, content: ContentIndex): Promise<SchedulerState>;
  attemptedExerciseIdsByActivity(ids: readonly Id[]): Promise<Map<Id, Set<Id>>>;
  replanBlocked(
    index: ContentIndex,
    now: Date,
    session: LoadedSession,
    state: SchedulerState,
    blocked: readonly Id[],
    activate: Id | undefined,
  ): Promise<void>;
}

export async function updateSessionProgress(
  store: FlowStore,
  learnerId: Id,
  sessionId: Id,
  activityId: Id,
  input: Record<string, unknown>,
  clock: () => Date,
  timeZone: string,
  enableFsrsFuzz: boolean,
  reads: ProgressReads,
) {
  let session = await reads.session(sessionId);
  let activity = session?.activities.find((item) => item.id === activityId);
  if (!activity) {
    return { kind: 'not_found' as const, body: { error: 'Activity not found' } };
  }
  if (activity.kind === 'mixed_quiz') {
    return {
      kind: 'conflict' as const,
      body: { error: 'Use the timed quiz to complete this activity' },
    };
  }
  const attemptedByActivity =
    activity.kind === 'review'
      ? await reads.attemptedExerciseIdsByActivity([activity.id])
      : new Map<string, Set<string>>();
  const completed = input.complete === true;
  const { complete: _complete, ...progress } = input;
  const now = clock();
  if (completed && activity.kind === 'review') {
    const attemptedExerciseIds = attemptedByActivity.get(activity.id) ?? new Set<string>();
    const missingExerciseIds = activity.exerciseIds.filter(
      (exerciseId) => !attemptedExerciseIds.has(exerciseId),
    );
    const removedQuestions = (activity.reason as { removedQuestions?: boolean } | null)
      ?.removedQuestions;
    if ((activity.exerciseIds.length === 0 && !removedQuestions) || missingExerciseIds.length > 0) {
      return {
        kind: 'conflict' as const,
        body: {
          error: 'Review activity needs an attempt for every exercise before completion.',
          missingExerciseIds,
        },
      };
    }
    if (removedQuestions && activity.exerciseIds.length > 0 && activity.status !== 'completed') {
      const index = await reads.content();
      const context = { index, now, session, userId: learnerId, timeZone };
      activity = await recordRecoveredReviewRatings(
        store,
        { enableFsrsFuzz, schedulerState: reads.schedulerState },
        context,
        activity,
      );
      if (activity.exerciseIds.some((id) => !attemptedExerciseIds.has(id))) {
        return {
          kind: 'ok' as const,
          body: withReviewTopics(activity, index, attemptedExerciseIds),
        };
      }
      const latestSession = await reads.session(activity.sessionId);
      await completeReviewActivity(
        store,
        { ...context, session: latestSession },
        activity,
        progress,
      );
      const finished = (await reads.session(activity.sessionId))?.activities.find(
        (item) => item.id === activity?.id,
      );
      return {
        kind: 'ok' as const,
        body: withReviewTopics(finished ?? activity, index, attemptedExerciseIds),
      };
    }
  }
  if (
    session?.status === 'active' &&
    activity.kind === 'learn' &&
    (activity.status === 'planned' ||
      (activity.status === 'in_progress' && input.lessonViewed === true))
  ) {
    const index = await reads.content();
    const state = filterSchedulerStateForContent(index, await reads.schedulerState(now, index));
    const masteryByKey = new Map(
      state.mastery.map((record) => [
        masteryKey(record.conceptId, record.dimension),
        { state: record.state, inferred: record.inferred },
      ]),
    );
    const blockedActivities = learnActivitiesWithUnmetPrerequisites(
      session.activities,
      masteryByKey,
      state.lessonRuns ?? [],
      index,
    );
    if (blockedActivities.length > 0) {
      const blockedTarget = blockedActivities.includes(activity.id);
      await reads.replanBlocked(
        index,
        now,
        session,
        state,
        blockedActivities,
        blockedTarget || activity.status !== 'planned' ? undefined : activity.id,
      );
      if (blockedTarget) {
        return {
          kind: 'conflict' as const,
          body: { error: 'Lesson prerequisites are no longer complete.' },
        };
      }
      session = await reads.session(sessionId);
      activity = session?.activities.find((item) => item.id === activityId);
      if (!activity) return { kind: 'not_found' as const, body: { error: 'Activity not found' } };
    }
  }
  const lessonIndex =
    input.lessonRunnerContinued === true &&
    !completed &&
    activity.kind === 'learn' &&
    activity.conceptId
      ? await reads.content()
      : null;
  const lesson = activity.conceptId
    ? lessonIndex?.lessonsByConcept.get(activity.conceptId)
    : undefined;
  const exerciseIds =
    lesson?.knowledge_points?.length && lesson.final ? [lesson.final] : activity.exerciseIds;
  const [updated] = await store.patchActivities(
    learnerId,
    { ids: [activity.id] },
    {
      progress,
      status: completed ? 'completed' : 'in_progress',
      startedAt: activity.startedAt ?? now,
      completedAt: completed ? now : null,
      ...(exerciseIds !== activity.exerciseIds ? { exerciseIds } : {}),
    },
  );
  if (activity.kind === 'learn' && activity.conceptId && input.lessonViewed === true) {
    const index = await reads.content();
    const concept = index.conceptsById.get(activity.conceptId);
    for (const dimension of concept?.dimensions ?? []) {
      const viewed = recordLessonViewed(
        await store.getMastery(learnerId, activity.conceptId, dimension),
        activity.conceptId,
        dimension,
        clock(),
      );
      await store.saveMastery(learnerId, viewed.mastery);
      if (viewed.event) {
        await store.addMasteryEvent(learnerId, {
          conceptId: viewed.event.conceptId,
          dimension: viewed.event.dimension,
          fromState: viewed.event.fromState,
          toState: viewed.event.toState,
          rule: viewed.event.rule,
          attemptId: null,
          createdAt: clock(),
        });
      }
    }
  }
  if (completed && session) await advanceActivity(store, learnerId, session, now);
  if (updated?.kind === 'review') {
    const index = await reads.content();
    return {
      kind: 'ok' as const,
      body: withReviewTopics(updated, index, attemptedByActivity.get(updated.id)),
    };
  }
  return { kind: 'ok' as const, body: updated };
}
