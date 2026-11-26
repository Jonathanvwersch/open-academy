import type { ContentIndex } from '../course/types.js';
import { filterSchedulerStateForContent } from '../graph/content-filters.js';
import { localDateKey } from '../progress/xp.js';
import type { Id } from '../store/core-store.js';
import type { PlacementReviewStore } from '../store/placement-review-store.js';
import type { Activity, SessionStore } from '../store/session-store.js';
import { reviewActivityReason } from './review-topics.js';
import {
  buildRemedialReviewActivityForConcept,
  buildReviewActivityForConcept,
  interleaveReviewExercises,
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
  store: PlacementReviewStore,
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
    const reason = { ...reviewActivityReason(activity.reason) };
    const exerciseIds = [...survivors];
    const survivingTopics = new Set(
      survivors.flatMap((id) => content.exercisesById.get(id)?.concept ?? []),
    );
    const inferTopics = !reason.topicIds && !activity.conceptId;
    const needsLegacyFire =
      !reason.topicIds && !reason.fireAppliedTopicIds && !reason.removedQuestions;
    const legacyAttempts =
      needsLegacyFire || inferTopics
        ? (await store.listAttempts(learnerId, { activityIds: [activity.id] })).filter(
            (attempt) => attempt.mode === 'review',
          )
        : [];
    if (needsLegacyFire && legacyAttempts.length > 0) {
      const savedAttempts = new Map(legacyAttempts.map((attempt) => [attempt.exerciseId, attempt]));
      const originalExercises = activity.exerciseIds.map((id) => {
        const exercise = content.exercisesById.get(id);
        const attempt = savedAttempts.get(id);
        return (
          exercise ?? (attempt && { concept: attempt.conceptId, dimension: attempt.dimension })
        );
      });
      if (originalExercises.every((exercise) => exercise !== undefined)) {
        const attemptsById = new Map(legacyAttempts.map((attempt) => [attempt.id, attempt]));
        const logs = await store.listReviewLogs(learnerId, { activityId: activity.id });
        const dimensionsByTopic = new Map<string, Set<string>>();
        for (const { concept, dimension } of originalExercises) {
          const dimensions = dimensionsByTopic.get(concept) ?? new Set<string>();
          dimensions.add(dimension);
          dimensionsByTopic.set(concept, dimensions);
        }
        reason.fireAppliedTopicIds = [...dimensionsByTopic].flatMap(([topic, dimensions]) => {
          const topicLogs = logs.filter((log) => log.conceptId === topic);
          const loggedDimensions = new Set(
            topicLogs.map(({ attemptId }) => attemptsById.get(attemptId ?? '')?.dimension),
          );
          return topicLogs.length === dimensions.size &&
            [...dimensions].every((dimension) => loggedDimensions.has(dimension))
            ? [topic]
            : [];
        });
      }
    }
    const knownTopics = [
      ...new Set(
        reason.topicIds ??
          (activity.conceptId
            ? [activity.conceptId]
            : [...survivingTopics, ...legacyAttempts.map(({ conceptId }) => conceptId)]),
      ),
    ];
    const coveredTopics = new Set([
      ...survivingTopics,
      ...(inferTopics && survivors.length > 0
        ? legacyAttempts.map(({ conceptId }) => conceptId)
        : []),
    ]);
    const missingTopics = knownTopics.filter((id) => !coveredTopics.has(id));
    const mixed = !activity.conceptId;
    if (survivors.length === 0 || (mixed && (reason.topicIds || missingTopics.length > 0))) {
      state ??= filterSchedulerStateForContent(content, await schedulerState());
      const current = state;
      const usedExerciseIds = activities
        .filter((other) => other.id !== activity.id)
        .flatMap((other) => other.exerciseIds);
      const reservedTopics = new Set(
        usedExerciseIds.map((id) => content.exercisesById.get(id)?.concept),
      );
      const slots = activity.exerciseIds.length;
      const select = (topic: string, used: string[]) => {
        const reselect = current.remediationFlags.some(
          (flag) => flag.status !== 'resolved' && flag.targetPrereqId === topic,
        )
          ? buildRemedialReviewActivityForConcept
          : buildReviewActivityForConcept;
        const replacement = reselect(
          {
            ...current,
            usedExerciseIds: [...(current.usedExerciseIds ?? []), ...usedExerciseIds, ...used],
          },
          content,
          now,
          topic,
        );
        return replacement?.exerciseIds ?? [];
      };
      const originals = missingTopics.map((topicId) => ({
        topicId,
        exerciseIds: select(topicId, survivors),
      }));
      for (const { exerciseIds: replacements } of originals) {
        if (exerciseIds.length >= slots) break;
        const replacement = replacements.shift();
        if (replacement) exerciseIds.push(replacement);
      }
      for (const topicId of knownTopics) {
        if (exerciseIds.length >= slots) break;
        if (coveredTopics.has(topicId)) {
          originals.push({ topicId, exerciseIds: select(topicId, exerciseIds) });
        }
      }
      exerciseIds.push(
        ...interleaveReviewExercises(originals).slice(0, slots - exerciseIds.length),
      );
      if (mixed) {
        const tried = new Set([...knownTopics, ...reservedTopics]);
        for (const topic of new Set(current.cards.map((card) => card.conceptId))) {
          if (exerciseIds.length >= slots) break;
          if (!tried.has(topic)) {
            exerciseIds.push(...select(topic, exerciseIds).slice(0, slots - exerciseIds.length));
          }
        }
      }
    }
    const [updated] = await store.patchActivities(
      learnerId,
      { ids: [activity.id], statuses: ['planned', 'in_progress'] },
      {
        exerciseIds,
        reason: { ...reason, removedQuestions: true },
      },
      { exerciseIds: activity.exerciseIds, reason: activity.reason },
    );
    if (updated) Object.assign(activity, updated);
    else {
      const [current] = await store.listActivities(learnerId, { ids: [activity.id] });
      if (current) Object.assign(activity, current);
    }
  }
}
