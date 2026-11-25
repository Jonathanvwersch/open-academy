import type { ContentIndex, IndexedExercise } from '@academy/aesop/course/types';
import {
  bringWeakestPrerequisiteCardDueNow,
  canBringPrerequisiteDueNow,
} from '@academy/aesop/lessons/prerequisite-review';
import {
  isDueToday,
  reviewActivityRating,
  scheduleReviewWithDetails,
} from '@academy/aesop/memory/fsrs';
import { applyImplicitRepetitions, getTopicSpeed } from '@academy/aesop/memory/mastery-service';
import {
  adjustedMinutesForLearnerPace,
  buildReviewActivityForConcept,
  interleaveReviewExercises,
} from '@academy/aesop/planner/scheduler';
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, notInArray, or } from 'drizzle-orm';
import { type Card, Rating } from 'ts-fsrs';
import type { Database } from '../db/client.js';
import { drizzleLearnerStore } from '../db/learner-store.js';
import type { LearnerRepository } from '../db/repository.js';
import {
  attempts,
  quizItems,
  quizRuns,
  remediationFlags,
  reviewCards,
  reviewLogs,
  sessionActivities,
} from '../db/schema.js';
import { updateActivityAndAdvance } from './activity-completion.js';
import { fsrsFuzzEnabled } from './fsrs-fuzz.js';

type Activity = typeof sessionActivities.$inferSelect;
type Session = { activities: Activity[] };
type ReviewContext = {
  index: ContentIndex;
  userId: string;
  timeZone: string;
  now: Date;
  session?: Session | null;
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
  db: Database,
  repo: LearnerRepository,
  { index, userId, timeZone, now, session }: ReviewContext,
  activity: Activity,
  exercise: Pick<IndexedExercise, 'concept' | 'dimension'>,
  attemptId: string,
) {
  const [card] = await db
    .select()
    .from(reviewCards)
    .where(
      and(
        eq(reviewCards.userId, userId),
        eq(reviewCards.conceptId, exercise.concept),
        eq(reviewCards.dimension, exercise.dimension),
      ),
    )
    .limit(1);
  if (card) {
    if (activity.exerciseIds.length > 0) {
      const topicExerciseIds = activity.exerciseIds.filter((exerciseId) => {
        const indexedExercise = index.exercisesById.get(exerciseId);
        return (
          indexedExercise?.concept === card.conceptId &&
          indexedExercise.dimension === card.dimension
        );
      });
      const activityAttempts = await db
        .select()
        .from(attempts)
        .where(
          and(eq(attempts.activityId, activity.id), inArray(attempts.exerciseId, topicExerciseIds)),
        )
        .orderBy(asc(attempts.createdAt), asc(attempts.attemptNo));
      const exerciseAttempts = topicExerciseIds.map((exerciseId) =>
        activityAttempts.filter((attempt) => attempt.exerciseId === exerciseId),
      );
      if (exerciseAttempts.every((items) => items.length > 0)) {
        const [existingLog] = await db
          .select({ id: reviewLogs.id })
          .from(reviewLogs)
          .innerJoin(attempts, eq(reviewLogs.attemptId, attempts.id))
          .where(and(eq(attempts.activityId, activity.id), eq(reviewLogs.cardId, card.id)))
          .limit(1);
        if (!existingLog) {
          const rating = reviewActivityRating(
            exerciseAttempts.map((items) => {
              const lastAttempt = items.at(-1);
              const reviewedExercise = lastAttempt
                ? index.exercisesById.get(lastAttempt.exerciseId)
                : undefined;
              return {
                correct: lastAttempt?.correct ?? 0,
                hintsUsed: items.reduce((total, attempt) => total + attempt.hintsUsed, 0),
                durationMs: lastAttempt?.durationMs,
                targetSeconds: reviewedExercise?.target_seconds,
              };
            }),
          );
          const [previousLog] =
            rating === Rating.Again
              ? await db
                  .select({ rating: reviewLogs.rating })
                  .from(reviewLogs)
                  .where(eq(reviewLogs.cardId, card.id))
                  .orderBy(desc(reviewLogs.createdAt))
                  .limit(1)
              : [];
          const store = drizzleLearnerStore(db);
          const speed = await getTopicSpeed(store, userId, card.conceptId);
          const scheduled = scheduleReviewWithDetails(
            card.fsrs as never,
            now,
            rating,
            timeZone,
            process.env.NODE_ENV !== 'test',
            speed,
          );
          await db
            .update(reviewCards)
            .set({
              fsrs: scheduled.card,
              dueAt: scheduled.card.due,
              lastReviewAt: now,
              reps: scheduled.card.reps,
              lapses: scheduled.card.lapses,
            })
            .where(eq(reviewCards.id, card.id));
          await db.insert(reviewLogs).values({
            cardId: card.id,
            attemptId,
            rating: String(rating),
            fsrsLog: { ...scheduled.log, effectiveDueAt: scheduled.card.due },
            speed,
            rawDueAt: scheduled.rawDueAt,
            createdAt: now,
          });
          const conceptExerciseIds = activity.exerciseIds.filter(
            (exerciseId) => index.exercisesById.get(exerciseId)?.concept === card.conceptId,
          );
          const expectedReviewLogCount = new Set(
            conceptExerciseIds.flatMap((exerciseId) => {
              const dimension = index.exercisesById.get(exerciseId)?.dimension;
              return dimension ? [dimension] : [];
            }),
          ).size;
          const conceptReviewLogs = await db
            .select({ rating: reviewLogs.rating })
            .from(reviewLogs)
            .innerJoin(attempts, eq(reviewLogs.attemptId, attempts.id))
            .innerJoin(reviewCards, eq(reviewLogs.cardId, reviewCards.id))
            .where(
              and(eq(attempts.activityId, activity.id), eq(reviewCards.conceptId, card.conceptId)),
            );
          if (conceptReviewLogs.length === expectedReviewLogCount) {
            const ratings = conceptReviewLogs.map(({ rating }) => Number(rating));
            if (ratings.length > 0) {
              await applyImplicitRepetitions(store, {
                learnerId: userId,
                conceptId: card.conceptId,
                rating: Math.min(...ratings) as Rating,
                index,
                now,
                timeZone: timeZone,
                enableFuzz: fsrsFuzzEnabled(),
              });
            }
          }
          if (rating === Rating.Again && previousLog?.rating === String(Rating.Again)) {
            const hardPrerequisiteIds =
              index.conceptsById
                .get(card.conceptId)
                ?.prereqs.filter((prerequisite) => prerequisite.strength === 'hard')
                .map((prerequisite) => prerequisite.id) ?? [];
            if (hardPrerequisiteIds.length > 0) {
              const prerequisiteCards = await db
                .select({
                  id: reviewCards.id,
                  conceptId: reviewCards.conceptId,
                  dimension: reviewCards.dimension,
                  dueAt: reviewCards.dueAt,
                  lastReviewAt: reviewCards.lastReviewAt,
                  fsrs: reviewCards.fsrs,
                })
                .from(reviewCards)
                .where(
                  and(
                    eq(reviewCards.userId, userId),
                    inArray(reviewCards.conceptId, hardPrerequisiteIds),
                    isNull(reviewCards.suspendedAt),
                  ),
                );
              const coveredDimensionKeys = new Set(
                (activity?.exerciseIds ?? []).flatMap((exerciseId) => {
                  const exercise = index.exercisesById.get(exerciseId);
                  return exercise ? [`${exercise.concept}/${exercise.dimension}`] : [];
                }),
              );
              const completedReviewConceptIds = new Set(
                (session?.activities ?? [])
                  .filter(
                    (sessionActivity) =>
                      sessionActivity.kind === 'review' && sessionActivity.status === 'completed',
                  )
                  .flatMap((sessionActivity) =>
                    sessionActivity.exerciseIds.flatMap((exerciseId) => {
                      const conceptId = index.exercisesById.get(exerciseId)?.concept;
                      return conceptId ? [conceptId] : [];
                    }),
                  ),
              );
              const weakest = bringWeakestPrerequisiteCardDueNow(
                prerequisiteCards
                  .filter((prerequisiteCard) =>
                    canBringPrerequisiteDueNow({
                      lastReviewAt: prerequisiteCard.lastReviewAt,
                      now,
                      timeZone: timeZone,
                      coveredByActivity:
                        completedReviewConceptIds.has(prerequisiteCard.conceptId) ||
                        coveredDimensionKeys.has(
                          `${prerequisiteCard.conceptId}/${prerequisiteCard.dimension}`,
                        ),
                    }),
                  )
                  .map((prerequisiteCard) => ({
                    ...prerequisiteCard,
                    fsrs: prerequisiteCard.fsrs as Card,
                  })),
                now,
                process.env.NODE_ENV !== 'test',
              );
              if (weakest) {
                const schedulerState = await repo.schedulerState(now, index);
                const stateWithWeakestDueNow = {
                  ...schedulerState,
                  cards: schedulerState.cards.map((card) =>
                    card.conceptId === weakest.conceptId && card.dimension === weakest.dimension
                      ? { ...card, dueAt: weakest.dueAt.toISOString() }
                      : card,
                  ),
                };
                const dueCardsForConcept = stateWithWeakestDueNow.cards.filter(
                  (card) =>
                    card.conceptId === weakest.conceptId &&
                    isDueToday(card.dueAt, now, stateWithWeakestDueNow.timezone ?? timeZone),
                );
                const usedExerciseIds = [
                  ...(schedulerState.usedExerciseIds ?? []),
                  ...(session?.activities.flatMap(
                    (sessionActivity) => sessionActivity.exerciseIds,
                  ) ?? []),
                ];
                const reviewActivity = buildReviewActivityForConcept(
                  { ...stateWithWeakestDueNow, usedExerciseIds },
                  index,
                  now,
                  weakest.conceptId,
                  dueCardsForConcept,
                );
                const extension = await db.transaction(async (tx) => {
                  await tx
                    .update(reviewCards)
                    .set({ dueAt: weakest.dueAt, fsrs: weakest.fsrs })
                    .where(eq(reviewCards.id, weakest.id));
                  if (!reviewActivity) return;
                  const sessionReviewActivities = await tx
                    .select({
                      id: sessionActivities.id,
                      idx: sessionActivities.idx,
                      kind: sessionActivities.kind,
                      status: sessionActivities.status,
                      exerciseIds: sessionActivities.exerciseIds,
                      plannedMinutes: sessionActivities.plannedMinutes,
                    })
                    .from(sessionActivities)
                    .where(eq(sessionActivities.sessionId, activity.sessionId))
                    .orderBy(asc(sessionActivities.idx));
                  const coversPrerequisite = (
                    sessionActivity: (typeof sessionReviewActivities)[number],
                  ) =>
                    sessionActivity.kind === 'review' &&
                    sessionActivity.exerciseIds.some(
                      (exerciseId) =>
                        index.exercisesById.get(exerciseId)?.concept === weakest.conceptId,
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
                    const addedExerciseIds = [...new Set(reviewActivity.exerciseIds)].filter(
                      (exerciseId) => {
                        const exercise = index.exercisesById.get(exerciseId);
                        return Boolean(
                          exercise &&
                            !existingExerciseIds.has(exerciseId) &&
                            !usedElsewhere.has(exerciseId) &&
                            !coveredDimensions.has(`${exercise.concept}/${exercise.dimension}`),
                        );
                      },
                    );
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
                            ...interleaveReviewExercises(
                              groupReviewExercisesByConcept(addedExerciseIds, index),
                            ),
                          ];
                    const addedBaseMinutes = addedExerciseIds.reduce(
                      (total, exerciseId) =>
                        total + (index.exercisesById.get(exerciseId)?.est_minutes ?? 0),
                      0,
                    );
                    const plannedMinutes =
                      coveredActivity.plannedMinutes +
                      adjustedMinutesForLearnerPace(
                        addedBaseMinutes,
                        schedulerState.actualEstimateRatio,
                      );
                    await tx
                      .update(sessionActivities)
                      .set({ exerciseIds, plannedMinutes })
                      .where(eq(sessionActivities.id, coveredActivity.id));
                    return {
                      activityId: coveredActivity.id,
                      exerciseIds,
                      plannedMinutes,
                    };
                  }
                  const laterActivities = await tx
                    .select({ id: sessionActivities.id, idx: sessionActivities.idx })
                    .from(sessionActivities)
                    .where(
                      and(
                        eq(sessionActivities.sessionId, activity.sessionId),
                        gt(sessionActivities.idx, activity.idx),
                      ),
                    )
                    .orderBy(desc(sessionActivities.idx));
                  for (const laterActivity of laterActivities) {
                    await tx
                      .update(sessionActivities)
                      .set({ idx: laterActivity.idx + 1 })
                      .where(eq(sessionActivities.id, laterActivity.id));
                  }
                  await tx.insert(sessionActivities).values({
                    sessionId: activity.sessionId,
                    idx: activity.idx + 1,
                    kind: 'review',
                    conceptId: weakest.conceptId,
                    exerciseIds: reviewActivity.exerciseIds,
                    plannedMinutes: reviewActivity.plannedMinutes,
                    status: 'planned',
                    reason: reviewActivity.reason,
                  });
                  return undefined;
                });
                if (extension && activity.id === extension.activityId) {
                  activity = {
                    ...activity,
                    exerciseIds: extension.exerciseIds,
                    plannedMinutes: extension.plannedMinutes,
                  };
                }
              }
            }
          }
        }
      }
    }
  }
  return activity;
}

export async function completeReviewActivity(
  db: Database,
  { index, userId, timeZone, now, session }: ReviewContext,
  activity: Activity,
  progress: unknown,
) {
  const { exerciseIds } = activity;
  await updateActivityAndAdvance(db, {
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
    await db
      .update(quizItems)
      .set({ followUpActivityId: activity.id })
      .where(
        and(
          eq(quizItems.followUp, true),
          isNull(quizItems.followUpActivityId),
          inArray(quizItems.conceptId, reviewedConceptIds),
          inArray(
            quizItems.runId,
            db
              .select({ id: quizRuns.id })
              .from(quizRuns)
              .where(and(eq(quizRuns.userId, userId), isNotNull(quizRuns.finalizedAt))),
          ),
        ),
      );
    await db
      .update(remediationFlags)
      .set({ status: 'resolved', resolvedAt: now })
      .where(
        and(
          eq(remediationFlags.userId, userId),
          eq(remediationFlags.status, 'open'),
          inArray(remediationFlags.targetPrereqId, reviewedConceptIds),
          or(
            isNull(remediationFlags.openedByAttemptId),
            notInArray(
              remediationFlags.openedByAttemptId,
              db
                .select({ id: attempts.id })
                .from(attempts)
                .where(eq(attempts.activityId, activity.id)),
            ),
          ),
        ),
      );
  }
}

export async function recordRecoveredReviewRatings(
  db: Database,
  repo: LearnerRepository,
  context: ReviewContext,
  activity: Activity,
) {
  const savedAttempts = await db
    .select({ id: attempts.id, exerciseId: attempts.exerciseId })
    .from(attempts)
    .where(
      and(
        eq(attempts.userId, context.userId),
        eq(attempts.activityId, activity.id),
        inArray(attempts.exerciseId, activity.exerciseIds),
      ),
    )
    .orderBy(desc(attempts.createdAt), desc(attempts.attemptNo));
  const rated = new Set<string>();
  for (const attempt of savedAttempts) {
    const exercise = context.index.exercisesById.get(attempt.exerciseId);
    if (!exercise) continue;
    const key = `${exercise.concept}/${exercise.dimension}`;
    if (rated.has(key)) continue;
    rated.add(key);
    activity = await recordReviewRating(db, repo, context, activity, exercise, attempt.id);
  }
  return activity;
}
