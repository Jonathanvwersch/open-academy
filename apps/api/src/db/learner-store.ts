import type { Dimension } from '@academy/aesop/course/schemas';
import { initialMastery, type MasteryRecord, type MasteryState } from '@academy/aesop/memory/types';
import type { LearnerStore, StoredReviewCard } from '@academy/aesop/store/learner-store';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Card } from 'ts-fsrs';
import type { Database } from './client.js';
import { mastery, masteryEvents, remediationFlags, reviewCards, reviewLogs } from './schema.js';

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

function mapReviewCard(row: typeof reviewCards.$inferSelect): StoredReviewCard {
  return {
    id: row.id,
    conceptId: row.conceptId,
    dimension: row.dimension as Dimension,
    fsrs: row.fsrs as Card,
    dueAt: row.dueAt,
    lastReviewAt: row.lastReviewAt,
    reps: row.reps,
    lapses: row.lapses,
  };
}

export function drizzleLearnerStore(db: Database | Transaction): LearnerStore {
  async function listMastery(learnerId: string): Promise<MasteryRecord[]> {
    const rows = await db
      .select()
      .from(mastery)
      .where(eq(mastery.userId, learnerId))
      .orderBy(asc(mastery.conceptId), asc(mastery.dimension));
    return rows.map((row) => {
      const evidence = row.evidence as Partial<MasteryRecord>;
      return {
        ...initialMastery(row.conceptId, row.dimension as Dimension),
        state: row.state as MasteryState,
        provisional: row.provisional,
        inferred: row.inferred,
        independentItemIds: evidence.independentItemIds ?? [],
        independentDeterministicCount: evidence.independentDeterministicCount ?? 0,
        lastIndependentCorrect: evidence.lastIndependentCorrect ?? false,
        attempts: evidence.attempts ?? [],
        lastAssessedAt: row.lastAssessedAt?.toISOString() ?? null,
        lastIndependentAt: row.lastIndependentAt?.toISOString() ?? null,
        firstIndependentAt: row.firstIndependentAt?.toISOString() ?? null,
      };
    });
  }

  return {
    listMastery,
    async getMastery(learnerId, conceptId, dimension) {
      return (await listMastery(learnerId)).find(
        (record) => record.conceptId === conceptId && record.dimension === dimension,
      );
    },
    async saveMastery(learnerId, record) {
      const values = {
        state: record.state,
        provisional: record.provisional,
        inferred: record.inferred,
        evidence: {
          independentItemIds: record.independentItemIds,
          independentDeterministicCount: record.independentDeterministicCount,
          lastIndependentCorrect: record.lastIndependentCorrect,
          attempts: record.attempts,
        },
        lastAssessedAt: record.lastAssessedAt ? new Date(record.lastAssessedAt) : null,
        lastIndependentAt: record.lastIndependentAt ? new Date(record.lastIndependentAt) : null,
        firstIndependentAt: record.firstIndependentAt ? new Date(record.firstIndependentAt) : null,
      };
      await db
        .insert(mastery)
        .values({
          userId: learnerId,
          conceptId: record.conceptId,
          dimension: record.dimension,
          ...values,
        })
        .onConflictDoUpdate({
          target: [mastery.userId, mastery.conceptId, mastery.dimension],
          set: values,
        });
    },
    async addMasteryEvent(learnerId, event) {
      await db.insert(masteryEvents).values({ ...event, userId: learnerId });
    },
    async listReviewCards(learnerId, conceptIds) {
      const rows = await db
        .select()
        .from(reviewCards)
        .where(
          and(
            eq(reviewCards.userId, learnerId),
            conceptIds === undefined ? undefined : inArray(reviewCards.conceptId, conceptIds),
          ),
        )
        .orderBy(asc(reviewCards.conceptId), asc(reviewCards.dimension), asc(reviewCards.id));
      return rows.map(mapReviewCard);
    },
    async getReviewCard(learnerId, conceptId, dimension) {
      const [row] = await db
        .select()
        .from(reviewCards)
        .where(
          and(
            eq(reviewCards.userId, learnerId),
            eq(reviewCards.conceptId, conceptId),
            eq(reviewCards.dimension, dimension),
          ),
        )
        .limit(1);
      return row && mapReviewCard(row);
    },
    async insertReviewCard(learnerId, card) {
      const [row] = await db
        .insert(reviewCards)
        .values({ ...card, userId: learnerId })
        .returning();
      if (!row) throw new Error('Unable to insert review card');
      return mapReviewCard(row);
    },
    async recordReview(learnerId, conceptId, dimension, compute) {
      await db.transaction(async (tx) => {
        const [current] = await tx
          .select()
          .from(reviewCards)
          .where(
            and(
              eq(reviewCards.userId, learnerId),
              eq(reviewCards.conceptId, conceptId),
              eq(reviewCards.dimension, dimension),
            ),
          )
          .for('update');
        const { card, log } = compute(current && mapReviewCard(current));
        const [saved] = await tx
          .insert(reviewCards)
          .values({ ...card, userId: learnerId, conceptId, dimension })
          .onConflictDoUpdate({
            target: [reviewCards.userId, reviewCards.conceptId, reviewCards.dimension],
            set: card,
          })
          .returning({ id: reviewCards.id });
        await tx.insert(reviewLogs).values({
          ...log,
          cardId: saved.id,
          rating: String(log.rating),
        });
      });
    },
    async updateReviewCardIfDue(learnerId, cardId, expectedDueAt, next) {
      const rows = await db
        .update(reviewCards)
        .set({ fsrs: next.fsrs, dueAt: next.dueAt })
        .where(
          and(
            eq(reviewCards.userId, learnerId),
            eq(reviewCards.id, cardId),
            eq(reviewCards.dueAt, expectedDueAt),
          ),
        )
        .returning({ id: reviewCards.id });
      return rows.length > 0;
    },
    async listOpenRemediationFlags(learnerId) {
      return db
        .select({
          id: remediationFlags.id,
          conceptId: remediationFlags.conceptId,
          targetPrereqId: remediationFlags.targetPrereqId,
        })
        .from(remediationFlags)
        .where(and(eq(remediationFlags.userId, learnerId), eq(remediationFlags.status, 'open')));
    },
  };
}
