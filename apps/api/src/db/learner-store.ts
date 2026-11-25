import type { Dimension } from '@academy/aesop/course/schemas';
import { TOPIC_SPEED_DECAY, TOPIC_SPEED_POLICY } from '@academy/aesop/memory/speed';
import { initialMastery, type MasteryRecord, type MasteryState } from '@academy/aesop/memory/types';
import type { AttemptQuery, CoreStore, Settings } from '@academy/aesop/store/core-store';
import type { StoredReviewCard } from '@academy/aesop/store/learner-store';
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  gte,
  inArray,
  isNull,
  like,
  lte,
  sql,
} from 'drizzle-orm';
import type { Card } from 'ts-fsrs';
import type { Database } from './client.js';
import {
  attempts,
  courseEnrollments,
  hintEvents,
  mastery,
  masteryEvents,
  remediationFlags,
  reviewCards,
  reviewLogs,
  topicSpeed,
  users,
  xpEvents,
} from './schema.js';

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

const { userId: _attemptOwner, ...attemptFields } = getTableColumns(attempts);
const { userId: _xpOwner, ...xpFields } = getTableColumns(xpEvents);
const { userId: _enrollmentOwner, ...enrollmentFields } = getTableColumns(courseEnrollments);

function attemptOrder(order: AttemptQuery['order']) {
  switch (order) {
    case 'scheduler':
      return [
        desc(attempts.createdAt),
        asc(attempts.exerciseId),
        desc(attempts.attemptNo),
        desc(attempts.correct),
        asc(attempts.mode),
        asc(attempts.id),
      ];
    case 'activity_attempt_no':
      return [asc(attempts.attemptNo)];
    case 'review_chronological':
      return [asc(attempts.createdAt), asc(attempts.attemptNo)];
    case 'final_evidence':
      return [desc(attempts.createdAt), desc(attempts.attemptNo)];
    default:
      return [desc(attempts.createdAt)];
  }
}
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

export function drizzleLearnerStore(
  db: Database | Transaction,
  { activeReviewCardsOnly = false } = {},
): CoreStore {
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
    async transaction(fn) {
      return db.transaction((tx) =>
        fn(drizzleLearnerStore(tx, { activeReviewCardsOnly }) as typeof this),
      );
    },
    async lockLearner(learnerId, strength) {
      await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, learnerId))
        .for(strength === 'no_key_update' ? 'no key update' : 'update');
    },
    async listAttempts(learnerId, query) {
      const rows = db
        .select(attemptFields)
        .from(attempts)
        .where(
          and(
            eq(attempts.userId, learnerId),
            query.ids === undefined ? undefined : inArray(attempts.id, query.ids),
            query.activityIds === undefined
              ? undefined
              : inArray(attempts.activityId, query.activityIds),
            query.exerciseIds === undefined
              ? undefined
              : inArray(attempts.exerciseId, query.exerciseIds),
            query.conceptId === undefined ? undefined : eq(attempts.conceptId, query.conceptId),
            query.since === undefined ? undefined : gte(attempts.createdAt, query.since),
            query.through === undefined ? undefined : lte(attempts.createdAt, query.through),
          ),
        )
        .orderBy(...attemptOrder(query.order));
      return query.limit === undefined ? rows : rows.limit(query.limit);
    },
    async insertAttempt(learnerId, attempt) {
      const [row] = await db
        .insert(attempts)
        .values({ ...attempt, userId: learnerId })
        .returning(attemptFields);
      if (!row) throw new Error('Unable to insert attempt');
      return row;
    },
    async readHintEvidence(learnerId, exerciseId, activityId) {
      const [attemptRows, hints] = await Promise.all([
        db
          .select({ activityId: attempts.activityId, createdAt: attempts.createdAt })
          .from(attempts)
          .where(
            and(
              eq(attempts.userId, learnerId),
              eq(attempts.exerciseId, exerciseId),
              activityId === undefined ? undefined : eq(attempts.activityId, activityId),
            ),
          ),
        db
          .select({
            activityId: hintEvents.activityId,
            createdAt: hintEvents.createdAt,
            level: hintEvents.level,
          })
          .from(hintEvents)
          .where(
            and(
              eq(hintEvents.userId, learnerId),
              eq(hintEvents.exerciseId, exerciseId),
              activityId === undefined ? undefined : eq(hintEvents.activityId, activityId),
            ),
          ),
      ]);
      return { attempts: attemptRows, hints };
    },
    async listXpEvents(learnerId, query) {
      return db
        .select(xpFields)
        .from(xpEvents)
        .where(
          and(
            eq(xpEvents.userId, learnerId),
            query.localDate === undefined ? undefined : eq(xpEvents.localDate, query.localDate),
            query.through === undefined ? undefined : lte(xpEvents.earnedAt, query.through),
            query.sourcePrefix === undefined
              ? undefined
              : like(xpEvents.sourceKey, `${query.sourcePrefix.replace(/[\\%_]/g, '\\$&')}%`),
            query.sourceKey === undefined ? undefined : eq(xpEvents.sourceKey, query.sourceKey),
          ),
        );
    },
    async insertXpEventOnce(learnerId, event) {
      const rows = await db
        .insert(xpEvents)
        .values({ ...event, userId: learnerId })
        .onConflictDoNothing()
        .returning({ id: xpEvents.id });
      return rows.length > 0;
    },
    async getSettings(learnerId) {
      const [row] = await db
        .select({
          activeCourseId: users.activeCourseId,
          studySetInitializedAt: users.studySetInitializedAt,
          startDate: users.startDate,
          timeZone: users.timezone,
          prefs: users.prefs,
        })
        .from(users)
        .where(eq(users.id, learnerId));
      return row && { ...row, prefs: row.prefs as Settings['prefs'] };
    },
    async patchSettings(
      learnerId,
      { activeCourseId, studySetInitializedAt, startDate, timeZone, prefs },
    ) {
      const values = {
        activeCourseId,
        studySetInitializedAt,
        startDate,
        timezone: timeZone,
        prefs,
      };
      if (Object.values(values).every((value) => value === undefined)) return;
      await db.update(users).set(values).where(eq(users.id, learnerId));
    },
    async listEnrollments(learnerId) {
      return db
        .select(enrollmentFields)
        .from(courseEnrollments)
        .where(eq(courseEnrollments.userId, learnerId));
    },
    async writeEnrollments(learnerId, change) {
      switch (change.kind) {
        case 'insert_missing':
          if (!change.rows.length) return;
          await db
            .insert(courseEnrollments)
            .values(change.rows.map((row) => ({ ...row, userId: learnerId })))
            .onConflictDoNothing();
          return;
        case 'start':
          await db
            .insert(courseEnrollments)
            .values({ ...change.row, userId: learnerId })
            .onConflictDoUpdate({
              target: [courseEnrollments.userId, courseEnrollments.courseId],
              set: { status: 'active' },
            });
          return;
        case 'complete':
          if (!change.courseIds.length) return;
          await db
            .insert(courseEnrollments)
            .values(
              change.courseIds.map((courseId): typeof courseEnrollments.$inferInsert => ({
                userId: learnerId,
                courseId,
                status: 'completed',
                startMethod: 'beginning',
                startedAt: change.now,
                completedAt: change.now,
              })),
            )
            .onConflictDoUpdate({
              target: [courseEnrollments.userId, courseEnrollments.courseId],
              set: { status: 'completed', completedAt: change.now },
            });
          return;
        case 'set_status':
          await db
            .update(courseEnrollments)
            .set({ status: change.status, completedAt: change.completedAt })
            .where(
              and(
                eq(courseEnrollments.userId, learnerId),
                inArray(courseEnrollments.courseId, change.courseIds),
                change.ifStatus === undefined
                  ? undefined
                  : eq(courseEnrollments.status, change.ifStatus),
              ),
            );
          return;
      }
    },
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
    async listTopicSpeedEvidence(learnerId, conceptIds) {
      const rows = await db
        .select()
        .from(topicSpeed)
        .where(
          and(
            eq(topicSpeed.userId, learnerId),
            conceptIds === undefined ? undefined : inArray(topicSpeed.conceptId, conceptIds),
          ),
        )
        .orderBy(asc(topicSpeed.conceptId));
      return rows.map(({ userId: _, ...record }) => record);
    },
    async saveTopicSpeedEvidence(learnerId, record) {
      await db
        .insert(topicSpeed)
        .values({ ...record, userId: learnerId })
        .onConflictDoUpdate({
          target: [topicSpeed.userId, topicSpeed.conceptId],
          set: record,
        });
    },
    async addTopicSpeedAnswer(learnerId, conceptId, correct, now) {
      await db
        .insert(topicSpeed)
        .values({
          userId: learnerId,
          conceptId,
          successes: Number(correct),
          trials: 1,
          answers: 1,
          updatedAt: now,
          policyVersion: TOPIC_SPEED_POLICY,
        })
        .onConflictDoUpdate({
          target: [topicSpeed.userId, topicSpeed.conceptId],
          set: {
            successes: sql`${topicSpeed.successes}::double precision * ${TOPIC_SPEED_DECAY} + ${Number(correct)}`,
            trials: sql`${topicSpeed.trials}::double precision * ${TOPIC_SPEED_DECAY} + 1`,
            answers: sql`${topicSpeed.answers} + 1`,
            updatedAt: now,
            policyVersion: TOPIC_SPEED_POLICY,
          },
        });
    },
    async listReviewCards(learnerId, conceptIds) {
      const rows = await db
        .select()
        .from(reviewCards)
        .where(
          and(
            eq(reviewCards.userId, learnerId),
            activeReviewCardsOnly ? isNull(reviewCards.suspendedAt) : undefined,
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
      return db.transaction(async (tx) => {
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
        if (current?.suspendedAt) return false;
        const { card, log } = compute(current && mapReviewCard(current));
        const [saved] = await tx
          .insert(reviewCards)
          .values({ ...card, userId: learnerId, conceptId, dimension })
          .onConflictDoUpdate({
            target: [reviewCards.userId, reviewCards.conceptId, reviewCards.dimension],
            set: card,
            setWhere: isNull(reviewCards.suspendedAt),
          })
          .returning({ id: reviewCards.id });
        if (!saved) return false;
        await tx.insert(reviewLogs).values({
          ...log,
          cardId: saved.id,
          rating: String(log.rating),
        });
        return true;
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
            activeReviewCardsOnly ? isNull(reviewCards.suspendedAt) : undefined,
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
