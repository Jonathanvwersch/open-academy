import { Rating } from 'ts-fsrs';
import type { ContentIndex, IndexedExercise } from '../course/types.js';
import {
  bringWeakestPrerequisiteCardDueNow,
  canBringPrerequisiteDueNow,
} from '../lessons/prerequisite-review.js';
import { updateActivityAndAdvance } from '../planner/activity-advance.js';
import {
  adjustedMinutesForLearnerPace,
  buildReviewActivityForConcept,
  interleaveReviewExercises,
  type SchedulerState,
} from '../planner/scheduler.js';
import type { PlacementReviewStore } from '../store/placement-review-store.js';
import type { Activity } from '../store/session-store.js';
import { isDueToday, reviewActivityRating, scheduleReviewWithDetails } from './fsrs.js';
import { applyImplicitRepetitions, getTopicSpeed } from './mastery-service.js';

export type ReviewContext = {
  index: ContentIndex;
  userId: string;
  timeZone: string;
  now: Date;
  session?: { activities: Activity[] } | null;
};

export type ReviewScheduler = {
  enableFsrsFuzz: boolean;
  schedulerState(now: Date, index: ContentIndex): Promise<SchedulerState>;
};

/** Links finalized timed-quiz items until the timed-quiz store is available. */
export type LinkTimedQuizFollowUp = (
  userId: string,
  activityId: string,
  conceptIds: string[],
) => Promise<void>;

function groupReviewExercisesByConcept(exerciseIds: string[], index: ContentIndex) {
  const groups = new Map<string, string[]>();
  for (const exerciseId of exerciseIds) {
    const topicId = index.exercisesById.get(exerciseId)?.concept ?? exerciseId;
    const topicExerciseIds = groups.get(topicId) ?? [];
    topicExerciseIds.push(exerciseId);
    groups.set(topicId, topicExerciseIds);
  }
  return [...groups].map(([topicId, exerciseIds]) => ({ topicId, exerciseIds }));
}

export async function recordReviewRating(
  store: PlacementReviewStore,
  runtime: ReviewScheduler,
  context: ReviewContext,
  activity: Activity,
  exercise: Pick<IndexedExercise, 'concept' | 'dimension'>,
  attemptId: string,
): Promise<Activity> {
  const { index, userId, timeZone, now } = context;
  const card = await store.getReviewCard(userId, exercise.concept, exercise.dimension);
  if (!card || activity.exerciseIds.length === 0) return activity;
  const topicExerciseIds = activity.exerciseIds.filter((id) => {
    const candidate = index.exercisesById.get(id);
    return candidate?.concept === card.conceptId && candidate.dimension === card.dimension;
  });
  const attempts = await store.listAttempts(userId, {
    activityIds: [activity.id],
    exerciseIds: topicExerciseIds,
    order: 'review_chronological',
  });
  const exerciseAttempts = topicExerciseIds.map((id) =>
    attempts.filter((attempt) => attempt.exerciseId === id),
  );
  if (exerciseAttempts.some((items) => !items.length)) return activity;
  const existingLogs = await store.listReviewLogs(userId, {
    activityId: activity.id,
    cardIds: [card.id],
    limit: 1,
  });
  if (existingLogs.length > 0) return activity;

  const rating = reviewActivityRating(
    exerciseAttempts.map((items) => {
      const lastAttempt = items.at(-1);
      return {
        correct: lastAttempt?.correct ?? 0,
        hintsUsed: items.reduce((total, attempt) => total + attempt.hintsUsed, 0),
        durationMs: lastAttempt?.durationMs,
        targetSeconds: lastAttempt
          ? index.exercisesById.get(lastAttempt.exerciseId)?.target_seconds
          : undefined,
      };
    }),
  );
  const [previousLog] =
    rating === Rating.Again
      ? await store.listReviewLogs(userId, { cardIds: [card.id], limit: 1 })
      : [];
  const speed = await getTopicSpeed(store, userId, card.conceptId);
  const scheduled = scheduleReviewWithDetails(
    card.fsrs,
    now,
    rating,
    timeZone,
    runtime.enableFsrsFuzz,
    speed,
  );
  await store.patchReviewCard(userId, card.id, {
    fsrs: scheduled.card,
    dueAt: scheduled.card.due,
    lastReviewAt: now,
    reps: scheduled.card.reps,
    lapses: scheduled.card.lapses,
  });
  await store.appendReviewLog(userId, card.id, {
    attemptId,
    rating,
    fsrsLog: { ...scheduled.log, effectiveDueAt: scheduled.card.due },
    speed,
    rawDueAt: scheduled.rawDueAt,
    createdAt: now,
  });
  const expectedReviewLogCount = new Set(
    activity.exerciseIds.flatMap((id) => {
      const candidate = index.exercisesById.get(id);
      return candidate?.concept === card.conceptId ? [candidate.dimension] : [];
    }),
  ).size;
  const conceptReviewLogs = (
    await store.listReviewLogs(userId, { activityId: activity.id })
  ).filter((log) => log.conceptId === card.conceptId);
  if (conceptReviewLogs.length > 0 && conceptReviewLogs.length === expectedReviewLogCount) {
    await applyImplicitRepetitions(store, {
      learnerId: userId,
      conceptId: card.conceptId,
      rating: Math.min(...conceptReviewLogs.map((log) => log.rating)) as Rating,
      index,
      now,
      timeZone,
      enableFuzz: runtime.enableFsrsFuzz,
    });
  }
  if (rating === Rating.Again && previousLog?.rating === Rating.Again) {
    return bringPrerequisiteReviewForward(store, runtime, context, activity, card.conceptId);
  }
  return activity;
}

async function bringPrerequisiteReviewForward(
  store: PlacementReviewStore,
  runtime: ReviewScheduler,
  { index, userId, timeZone, now, session }: ReviewContext,
  activity: Activity,
  conceptId: string,
): Promise<Activity> {
  const hardPrerequisiteIds =
    index.conceptsById
      .get(conceptId)
      ?.prereqs.filter((prerequisite) => prerequisite.strength === 'hard')
      .map((prerequisite) => prerequisite.id) ?? [];
  if (hardPrerequisiteIds.length === 0) return activity;
  const prerequisiteCards = (await store.listReviewCards(userId, hardPrerequisiteIds)).filter(
    (card) => !card.suspendedAt,
  );
  const coveredDimensionKeys = new Set(
    activity.exerciseIds.flatMap((exerciseId) => {
      const exercise = index.exercisesById.get(exerciseId);
      return exercise ? [`${exercise.concept}/${exercise.dimension}`] : [];
    }),
  );
  const completedReviewConceptIds = new Set(
    (session?.activities ?? [])
      .filter((item) => item.kind === 'review' && item.status === 'completed')
      .flatMap((item) =>
        item.exerciseIds.flatMap((exerciseId) => {
          const conceptId = index.exercisesById.get(exerciseId)?.concept;
          return conceptId ? [conceptId] : [];
        }),
      ),
  );
  const weakest = bringWeakestPrerequisiteCardDueNow(
    prerequisiteCards.filter((card) =>
      canBringPrerequisiteDueNow({
        lastReviewAt: card.lastReviewAt,
        now,
        timeZone,
        coveredByActivity:
          completedReviewConceptIds.has(card.conceptId) ||
          coveredDimensionKeys.has(`${card.conceptId}/${card.dimension}`),
      }),
    ),
    now,
    runtime.enableFsrsFuzz,
  );
  if (!weakest) return activity;
  const schedulerState = await runtime.schedulerState(now, index);
  const stateWithWeakestDueNow = {
    ...schedulerState,
    cards: schedulerState.cards.map((card) =>
      card.conceptId === weakest.conceptId && card.dimension === weakest.dimension
        ? { ...card, dueAt: weakest.dueAt.toISOString() }
        : card,
    ),
  };
  const dueCards = stateWithWeakestDueNow.cards.filter(
    (card) =>
      card.conceptId === weakest.conceptId &&
      isDueToday(card.dueAt, now, stateWithWeakestDueNow.timezone ?? timeZone),
  );
  const usedExerciseIds = [
    ...(schedulerState.usedExerciseIds ?? []),
    ...(session?.activities.flatMap((item) => item.exerciseIds) ?? []),
  ];
  const reviewActivity = buildReviewActivityForConcept(
    { ...stateWithWeakestDueNow, usedExerciseIds },
    index,
    now,
    weakest.conceptId,
    dueCards,
  );
  const extension = await store.transaction(async (tx) => {
    await tx.patchReviewCard(userId, weakest.id, { dueAt: weakest.dueAt, fsrs: weakest.fsrs });
    if (!reviewActivity) return;
    const sessionReviewActivities = await tx.listActivities(userId, {
      sessionIds: [activity.sessionId],
    });
    const coversPrerequisite = (sessionActivity: (typeof sessionReviewActivities)[number]) =>
      sessionActivity.kind === 'review' &&
      sessionActivity.exerciseIds.some(
        (exerciseId) => index.exercisesById.get(exerciseId)?.concept === weakest.conceptId,
      );
    const completedActivity = sessionReviewActivities.find(
      (sessionActivity) =>
        sessionActivity.status === 'completed' && coversPrerequisite(sessionActivity),
    );
    if (completedActivity) return;
    const coveredActivity = sessionReviewActivities.find(
      (sessionActivity) =>
        ['planned', 'in_progress'].includes(sessionActivity.status) &&
        coversPrerequisite(sessionActivity),
    );
    if (coveredActivity) {
      const existingExerciseIds = new Set(coveredActivity.exerciseIds);
      const coveredDimensions = new Set(
        coveredActivity.exerciseIds.flatMap((exerciseId) => {
          const exercise = index.exercisesById.get(exerciseId);
          return exercise?.concept && exercise.dimension
            ? [`${exercise.concept}/${exercise.dimension}`]
            : [];
        }),
      );
      const usedElsewhere = new Set(
        sessionReviewActivities
          .filter((sessionActivity) => sessionActivity.id !== coveredActivity.id)
          .flatMap((sessionActivity) => sessionActivity.exerciseIds),
      );
      const addedExerciseIds = [...new Set(reviewActivity.exerciseIds)].filter((exerciseId) => {
        const exercise = index.exercisesById.get(exerciseId);
        return Boolean(
          exercise &&
            !existingExerciseIds.has(exerciseId) &&
            !usedElsewhere.has(exerciseId) &&
            !coveredDimensions.has(`${exercise.concept}/${exercise.dimension}`),
        );
      });
      if (addedExerciseIds.length === 0) return;
      const exerciseIds =
        coveredActivity.status === 'planned'
          ? interleaveReviewExercises(
              groupReviewExercisesByConcept(
                [...coveredActivity.exerciseIds, ...addedExerciseIds],
                index,
              ),
            )
          : [
              ...coveredActivity.exerciseIds,
              ...interleaveReviewExercises(groupReviewExercisesByConcept(addedExerciseIds, index)),
            ];
      const addedBaseMinutes = addedExerciseIds.reduce(
        (total, exerciseId) => total + (index.exercisesById.get(exerciseId)?.est_minutes ?? 0),
        0,
      );
      const plannedMinutes =
        coveredActivity.plannedMinutes +
        adjustedMinutesForLearnerPace(addedBaseMinutes, schedulerState.actualEstimateRatio);
      await tx.patchActivities(
        userId,
        { ids: [coveredActivity.id] },
        { exerciseIds, plannedMinutes },
      );
      return {
        activityId: coveredActivity.id,
        exerciseIds,
        plannedMinutes,
      };
    }
    const laterActivities = (await tx.listActivities(userId, { sessionIds: [activity.sessionId] }))
      .filter(({ idx }) => idx > activity.idx)
      .sort((left, right) => right.idx - left.idx);
    for (const laterActivity of laterActivities) {
      await tx.patchActivities(userId, { ids: [laterActivity.id] }, { idx: laterActivity.idx + 1 });
    }
    await tx.insertActivities(userId, activity.sessionId, [
      {
        idx: activity.idx + 1,
        kind: 'review',
        conceptId: weakest.conceptId,
        projectId: null,
        exerciseIds: reviewActivity.exerciseIds,
        plannedMinutes: reviewActivity.plannedMinutes,
        status: 'planned',
        reason: reviewActivity.reason,
        progress: {},
        startedAt: null,
        completedAt: null,
      },
    ]);
    return undefined;
  });
  return extension?.activityId === activity.id
    ? { ...activity, exerciseIds: extension.exerciseIds, plannedMinutes: extension.plannedMinutes }
    : activity;
}

export async function completeReviewActivity(
  store: PlacementReviewStore,
  { index, userId, timeZone, now, session }: ReviewContext,
  activity: Activity,
  progress: unknown,
  linkTimedQuizFollowUp: LinkTimedQuizFollowUp,
) {
  const { exerciseIds } = activity;
  await updateActivityAndAdvance(store, {
    activityId: activity.id,
    completed: true,
    now,
    session: session ?? undefined,
    exerciseIds,
    progress,
    userId,
    timeZone,
  });
  const reviewedConceptIds = [
    ...new Set(
      exerciseIds.flatMap((exerciseId) => {
        const reviewedExercise = index.exercisesById.get(exerciseId);
        return reviewedExercise ? [reviewedExercise.concept] : [];
      }),
    ),
  ];
  if (reviewedConceptIds.length > 0) {
    await linkTimedQuizFollowUp(userId, activity.id, reviewedConceptIds);
    await store.resolveRemediationFlags(
      userId,
      { targetPrereqIds: reviewedConceptIds, excludeOpenedByActivityId: activity.id },
      now,
    );
  }
}

export async function recordRecoveredReviewRatings(
  store: PlacementReviewStore,
  runtime: ReviewScheduler,
  context: ReviewContext,
  activity: Activity,
) {
  const savedAttempts = await store.listAttempts(context.userId, {
    activityIds: [activity.id],
    exerciseIds: activity.exerciseIds,
    order: 'final_evidence',
  });
  const rated = new Set<string>();
  for (const attempt of savedAttempts) {
    const exercise = context.index.exercisesById.get(attempt.exerciseId);
    if (!exercise) continue;
    const key = `${exercise.concept}/${exercise.dimension}`;
    if (rated.has(key)) continue;
    rated.add(key);
    activity = await recordReviewRating(store, runtime, context, activity, exercise, attempt.id);
  }
  return activity;
}
