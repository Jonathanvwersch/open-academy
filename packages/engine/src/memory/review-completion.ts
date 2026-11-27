import { Rating } from 'ts-fsrs';
import { DimensionSchema } from '../course/schemas.js';
import type { ContentIndex, IndexedExercise } from '../course/types.js';
import {
  bringWeakestPrerequisiteCardDueNow,
  canBringPrerequisiteDueNow,
} from '../lessons/prerequisite-review.js';
import { updateActivityAndAdvance } from '../planner/activity-advance.js';
import { reviewActivityReason } from '../planner/review-topics.js';
import {
  adjustedMinutesForLearnerPace,
  buildReviewActivityForConcept,
  interleaveReviewExercises,
  type SchedulerState,
} from '../planner/scheduler.js';
import type { Attempt } from '../store/core-store.js';
import type { FlowStore } from '../store/flow-store.js';
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
  savedAttempts?: Attempt[],
): Promise<Activity> {
  const { index, userId, timeZone, now } = context;
  const card = await store.getReviewCard(userId, exercise.concept, exercise.dimension);
  if (!card) return activity;
  const topicExerciseIds = activity.exerciseIds.filter((id) => {
    const candidate = index.exercisesById.get(id);
    return candidate?.concept === card.conceptId && candidate.dimension === card.dimension;
  });
  const recovered = reviewActivityReason(activity.reason).removedQuestions === true;
  const attempts = (
    savedAttempts ??
    (await store.listAttempts(userId, {
      activityIds: [activity.id],
      ...(recovered ? {} : { exerciseIds: topicExerciseIds }),
      order: 'review_chronological',
    }))
  ).filter(
    (attempt) =>
      attempt.mode === 'review' &&
      attempt.conceptId === card.conceptId &&
      attempt.dimension === card.dimension,
  );
  if (attempts.length === 0) return activity;
  const ids = new Set(topicExerciseIds);
  if (recovered) {
    for (const attempt of attempts) {
      if (!index.exercisesById.has(attempt.exerciseId)) ids.add(attempt.exerciseId);
    }
  }
  const exerciseAttempts = [...ids].map((id) =>
    attempts.filter((attempt) => attempt.exerciseId === id),
  );
  if (exerciseAttempts.length === 0) return activity;
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
  if (!recovered) {
    const expectedReviewLogCount = new Set(
      activity.exerciseIds.flatMap((id) => {
        const candidate = index.exercisesById.get(id);
        return candidate?.concept === card.conceptId ? [candidate.dimension] : [];
      }),
    ).size;
    await applyReviewFireOnce(
      store,
      runtime,
      context,
      activity.id,
      card.conceptId,
      expectedReviewLogCount,
    );
  }
  if (rating === Rating.Again && previousLog?.rating === Rating.Again) {
    return bringPrerequisiteReviewForward(store, runtime, context, activity, card.conceptId);
  }
  return activity;
}

async function applyReviewFireOnce(
  store: PlacementReviewStore,
  runtime: ReviewScheduler,
  { index, userId, timeZone, now }: ReviewContext,
  activityId: string,
  conceptId: string,
  expectedLogCount?: number,
) {
  const logs = (await store.listReviewLogs(userId, { activityId })).filter(
    (log) => log.conceptId === conceptId,
  );
  if (logs.length === 0 || (expectedLogCount !== undefined && logs.length !== expectedLogCount))
    return;
  await store.transaction(async (tx) => {
    while (true) {
      const [activity] = await tx.listActivities(userId, { ids: [activityId] });
      if (!activity) return;
      const reason = reviewActivityReason(activity.reason);
      if (
        reason.fireAppliedTopicIds?.includes(conceptId) ||
        (expectedLogCount !== undefined && reason.removedQuestions)
      )
        return;
      const [claimed] = await tx.patchActivities(
        userId,
        { ids: [activityId] },
        {
          reason: {
            ...reason,
            fireAppliedTopicIds: [...(reason.fireAppliedTopicIds ?? []), conceptId],
          },
        },
        { reason: activity.reason },
      );
      if (!claimed) continue;
      await applyImplicitRepetitions(tx, {
        learnerId: userId,
        conceptId,
        rating: Math.min(...logs.map((log) => log.rating)) as Rating,
        index,
        now,
        timeZone,
        enableFuzz: runtime.enableFsrsFuzz,
      });
      return;
    }
  });
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
    { preferBasics: true },
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
  store: FlowStore,
  { index, userId, timeZone, now, session }: ReviewContext,
  activity: Activity,
  progress: unknown,
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
  if (reviewActivityReason(activity.reason).removedQuestions) {
    for (const { mode, conceptId, exerciseId } of await store.listAttempts(userId, {
      activityIds: [activity.id],
    })) {
      if (
        mode === 'review' &&
        !index.exercisesById.has(exerciseId) &&
        index.conceptsById.has(conceptId) &&
        !reviewedConceptIds.includes(conceptId)
      )
        reviewedConceptIds.push(conceptId);
    }
  }
  if (reviewedConceptIds.length > 0) {
    await store.linkTimedQuizFollowUps(userId, reviewedConceptIds, activity.id);
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
    order: 'review_chronological',
  });
  const rated = new Set<string>();
  const usedAttempts = savedAttempts.filter((attempt) => attempt.mode === 'review');
  for (const attempt of [...usedAttempts].reverse()) {
    const dimension = DimensionSchema.safeParse(attempt.dimension);
    if (!dimension.success) continue;
    const exercise = { concept: attempt.conceptId, dimension: dimension.data };
    const key = `${exercise.concept}/${exercise.dimension}`;
    if (rated.has(key)) continue;
    rated.add(key);
    activity = await recordReviewRating(
      store,
      runtime,
      context,
      activity,
      exercise,
      attempt.id,
      usedAttempts,
    );
  }
  if (reviewActivityReason(activity.reason).removedQuestions) {
    const attemptedIds = new Set(usedAttempts.map(({ exerciseId }) => exerciseId));
    if (activity.exerciseIds.every((id) => attemptedIds.has(id))) {
      for (const conceptId of new Set(usedAttempts.map((attempt) => attempt.conceptId))) {
        await applyReviewFireOnce(store, runtime, context, activity.id, conceptId);
      }
    }
  }
  return activity;
}
