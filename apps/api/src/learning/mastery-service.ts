import type { Dimension } from '@academy/aesop/course/schemas';
import type { ContentIndex, IndexedExercise } from '@academy/aesop/course/types';
import { buildEncompassingIndex } from '@academy/aesop/graph/encompassing';
import { mapReviewRating, newReviewCard, scheduleInitialReview } from '@academy/aesop/memory/fsrs';
import { implicitRepetition } from '@academy/aesop/memory/implicit-repetition';
import { DefaultMasteryModel } from '@academy/aesop/memory/mastery';
import type { LearningMode } from '@academy/aesop/memory/types';
import { masteryRank } from '@academy/aesop/memory/types';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Card } from 'ts-fsrs';
import { Rating } from 'ts-fsrs';
import type { Database } from '../db/client.js';
import type { LearnerRepository } from '../db/repository.js';
import { masteryEvents, reviewCards } from '../db/schema.js';

type ReviewCardDatabase = Pick<Database, 'select' | 'update'>;

export type ImplicitRepetitionTraceEvent = {
  sourceConceptId: string;
  rating: Rating;
  targetCardId: string;
  weight: number;
  before: { dueAt: Date; fsrs: Card; stability: number; difficulty: number };
  after: { dueAt: Date; fsrs: Card; stability: number; difficulty: number };
  applied: boolean;
};

let implicitRepetitionTrace: ((event: ImplicitRepetitionTraceEvent) => void) | undefined;

export function setImplicitRepetitionTrace(
  trace: ((event: ImplicitRepetitionTraceEvent) => void) | undefined,
) {
  implicitRepetitionTrace = trace;
}

export async function applyImplicitRepetitions(
  db: ReviewCardDatabase,
  input: {
    userId: string;
    conceptId: string;
    rating: Rating;
    index: ContentIndex;
    now: Date;
    timeZone: string;
  },
) {
  const encompassing = buildEncompassingIndex(input.index);
  const targets =
    input.rating === Rating.Again
      ? encompassing.descendants(input.conceptId)
      : encompassing.ancestors(input.conceptId);
  if (targets.size === 0) return;

  const cards = await db
    .select({
      id: reviewCards.id,
      conceptId: reviewCards.conceptId,
      dueAt: reviewCards.dueAt,
      fsrs: reviewCards.fsrs,
    })
    .from(reviewCards)
    .where(
      and(
        eq(reviewCards.userId, input.userId),
        inArray(reviewCards.conceptId, [...targets.keys()]),
      ),
    )
    .orderBy(asc(reviewCards.conceptId), asc(reviewCards.dimension), asc(reviewCards.id));
  for (const card of cards) {
    const before = { fsrs: card.fsrs as Card, dueAt: card.dueAt };
    const weight = targets.get(card.conceptId) ?? 0;
    const result = implicitRepetition(before, {
      weight,
      rating: input.rating,
      now: input.now,
      timeZone: input.timeZone,
      enableFuzz: process.env.NODE_ENV !== 'test',
    });
    const after = result ?? before;
    implicitRepetitionTrace?.({
      sourceConceptId: input.conceptId,
      rating: input.rating,
      targetCardId: card.id,
      weight,
      before: {
        ...before,
        fsrs: { ...before.fsrs },
        stability: before.fsrs.stability,
        difficulty: before.fsrs.difficulty,
      },
      after: {
        ...after,
        fsrs: { ...after.fsrs },
        stability: after.fsrs.stability,
        difficulty: after.fsrs.difficulty,
      },
      applied: result !== undefined,
    });
    if (!result) continue;
    await db
      .update(reviewCards)
      .set({
        fsrs: result.fsrs,
        dueAt: result.dueAt,
      })
      .where(and(eq(reviewCards.id, card.id), eq(reviewCards.dueAt, card.dueAt)));
  }
}

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
