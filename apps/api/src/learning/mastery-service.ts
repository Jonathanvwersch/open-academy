import { and, eq } from 'drizzle-orm';
import type { Dimension } from '../content/schemas.js';
import type { IndexedExercise } from '../content/types.js';
import type { LearnerRepository } from '../db/repository.js';
import { masteryEvents, reviewCards } from '../db/schema.js';
import { mapReviewRating, newReviewCard, scheduleInitialReview } from './fsrs.js';
import { DefaultMasteryModel } from './mastery.js';
import type { LearningMode } from './types.js';
import { masteryRank } from './types.js';
export async function applyMastery(input: {
  repo: LearnerRepository;
  userId: string;
  exercise: IndexedExercise;
  attemptId: string;
  correct: number;
  credit: number;
  hintsUsed: number;
  attemptNo: number;
  mode: LearningMode;
  gradedBy: 'deterministic' | 'llm' | 'self';
  followUp?: boolean;
  createReviewCard?: boolean;
  now: Date;
  timeZone: string;
}) {
  const previous = await input.repo.masteryRecord(input.exercise.concept, input.exercise.dimension);
  const open = await input.repo.openFlags();
  const model = new DefaultMasteryModel();
  const result = model.applyAttempt(
    previous,
    {
      conceptId: input.exercise.concept,
      dimension: input.exercise.dimension,
      attemptId: input.attemptId,
      exerciseId: input.exercise.id,
      correct: input.correct,
      hintsUsed: input.hintsUsed,
      attemptNo: input.attemptNo,
      mode: input.mode,
      itemRole: input.exercise.role,
      gradedBy: input.gradedBy,
      followUp: input.followUp,
    },
    input.now,
    { remediationOpen: open.some((flag) => flag.conceptId === input.exercise.concept) },
  );
  await input.repo.saveMastery(result.mastery);
  if (result.event) {
    await input.repo.db.insert(masteryEvents).values({
      userId: input.userId,
      conceptId: result.event.conceptId,
      dimension: result.event.dimension,
      fromState: result.event.fromState,
      toState: result.event.toState,
      rule: result.event.rule,
      attemptId: result.event.attemptId,
      createdAt: input.now,
    });
  }
  if (
    input.createReviewCard !== false &&
    masteryRank(result.mastery.state) >= masteryRank('assisted')
  ) {
    await ensureReviewCard({
      repo: input.repo,
      userId: input.userId,
      conceptId: input.exercise.concept,
      dimension: input.exercise.dimension,
      correct: input.correct,
      hintsUsed: input.hintsUsed,
      attemptNo: input.attemptNo,
      now: input.now,
      timeZone: input.timeZone,
    });
  }
  return { mastery: result.mastery, event: result.event, credit: result.credit };
}

export async function ensureReviewCard(input: {
  repo: LearnerRepository;
  userId: string;
  conceptId: string;
  dimension: Dimension;
  correct: number;
  hintsUsed: number;
  attemptNo: number;
  now: Date;
  timeZone: string;
}) {
  const existingCard = await input.repo.db
    .select()
    .from(reviewCards)
    .where(
      and(
        eq(reviewCards.userId, input.userId),
        eq(reviewCards.conceptId, input.conceptId),
        eq(reviewCards.dimension, input.dimension),
      ),
    )
    .limit(1);
  if (existingCard[0]) return;

  const card = newReviewCard(input.now);
  const rating = mapReviewRating({
    correct: input.correct,
    hintsUsed: input.hintsUsed,
    attemptNo: input.attemptNo,
  });
  const scheduled = scheduleInitialReview(
    card,
    input.now,
    rating,
    input.timeZone,
    process.env.NODE_ENV !== 'test',
  );
  await input.repo.db.insert(reviewCards).values({
    userId: input.userId,
    conceptId: input.conceptId,
    dimension: input.dimension,
    fsrs: scheduled.card,
    dueAt: scheduled.card.due,
    lastReviewAt: input.now,
    reps: scheduled.card.reps,
    lapses: scheduled.card.lapses,
  });
}
