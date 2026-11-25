import type { ContentIndex } from '../course/types.js';
import { filterSchedulerStateForContent } from '../graph/content-filters.js';
import { localDateKey } from '../progress/xp.js';
import type { Id } from '../store/core-store.js';
import type { Activity, SessionStore } from '../store/session-store.js';
import {
  buildRemedialReviewActivityForConcept,
  buildReviewActivityForConcept,
  type SchedulerState,
} from './scheduler.js';

export async function activeSessionForDate(
  store: SessionStore,
  learnerId: Id,
  now: Date,
  timezone: string,
) {
  const today = localDateKey(now, timezone);
  const sessions = await store.listSessions(learnerId, { status: 'active' });
  return sessions.find(
    (session) => session.startedAt && localDateKey(session.startedAt, timezone) === today,
  );
}

export async function recoverReviewActivities(
  store: SessionStore,
  learnerId: Id,
  activities: Activity[],
  content: ContentIndex,
  now: Date,
  schedulerState: () => Promise<SchedulerState>,
) {
  let state: SchedulerState | undefined;
  for (const activity of activities) {
    if (
      activity.kind !== 'review' ||
      (activity.status !== 'planned' && activity.status !== 'in_progress')
    )
      continue;
    const survivors = activity.exerciseIds.filter((id) => content.exercisesById.has(id));
    if (survivors.length === activity.exerciseIds.length) continue;
    const exerciseIds = survivors;
    if (exerciseIds.length === 0) {
      state ??= filterSchedulerStateForContent(content, await schedulerState());
      const usedExerciseIds = activities
        .filter((other) => other.id !== activity.id)
        .flatMap((other) => other.exerciseIds);
      const reservedTopics = new Set(
        usedExerciseIds.map((id) => content.exercisesById.get(id)?.concept),
      );
      const topics = activity.conceptId
        ? [activity.conceptId]
        : [...new Set(state.cards.map((card) => card.conceptId))].filter(
            (id) => !reservedTopics.has(id),
          );
      for (const topic of topics) {
        const reselect = state.remediationFlags.some(
          (flag) => flag.status !== 'resolved' && flag.targetPrereqId === topic,
        )
          ? buildRemedialReviewActivityForConcept
          : buildReviewActivityForConcept;
        const replacement = reselect(
          { ...state, usedExerciseIds: [...usedExerciseIds, ...exerciseIds] },
          content,
          now,
          topic,
        );
        if (replacement) exerciseIds.push(...replacement.exerciseIds);
        if (exerciseIds.length >= activity.exerciseIds.length) break;
      }
    }
    const [updated] = await store.patchActivities(
      learnerId,
      { ids: [activity.id] },
      { exerciseIds, reason: { ...(activity.reason as object), removedQuestions: true } },
      { exerciseIds: activity.exerciseIds },
    );
    if (updated) Object.assign(activity, updated);
    else {
      const [current] = await store.listActivities(learnerId, { ids: [activity.id] });
      if (current) Object.assign(activity, current);
    }
  }
}
