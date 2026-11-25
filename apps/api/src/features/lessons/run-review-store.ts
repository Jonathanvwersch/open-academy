import type { QuizSubmitHost } from '@academy/aesop/lessons/run-commands';
import { and, eq } from 'drizzle-orm';
import type { Card } from 'ts-fsrs';
import type { drizzleLearnerStore } from '../../db/learner-store.js';
import { reviewCards, reviewLogs } from '../../db/schema.js';

type ReviewHost = QuizSubmitHost<ReturnType<typeof drizzleLearnerStore>>;

export const unsuspendReviewCards: ReviewHost['unsuspendReviewCards'] = async (
  { connection },
  learnerId,
  conceptId,
) => {
  await connection
    .update(reviewCards)
    .set({ suspendedAt: null })
    .where(and(eq(reviewCards.userId, learnerId), eq(reviewCards.conceptId, conceptId)));
};

export const writeInitialReview: ReviewHost['writeInitialReview'] = async (
  { connection },
  learnerId,
  conceptId,
  dimension,
  compute,
) => {
  const [existing] = await connection
    .select()
    .from(reviewCards)
    .where(
      and(
        eq(reviewCards.userId, learnerId),
        eq(reviewCards.conceptId, conceptId),
        eq(reviewCards.dimension, dimension),
      ),
    )
    .for('update')
    .limit(1);
  const { card, log } = compute(
    existing && { ...existing, dimension, fsrs: existing.fsrs as Card },
  );
  let cardId = existing?.id;
  if (existing) {
    await connection.update(reviewCards).set(card).where(eq(reviewCards.id, existing.id));
  } else {
    const [created] = await connection
      .insert(reviewCards)
      .values({ userId: learnerId, conceptId, dimension, ...card })
      .returning({ id: reviewCards.id });
    cardId = created?.id;
  }
  if (cardId) {
    await connection.insert(reviewLogs).values({ ...log, cardId, rating: String(log.rating) });
  }
};
