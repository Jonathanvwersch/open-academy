import type { Dimension } from '@academy/aesop/course/schemas';
import { startOfNextCalendarDay } from '@academy/aesop/memory/fsrs';
import { TOPIC_SPEED_DECAY, TOPIC_SPEED_POLICY } from '@academy/aesop/memory/speed';
import { initialMastery, type MasteryRecord, type MasteryState } from '@academy/aesop/memory/types';
import type { AttemptQuery, Settings } from '@academy/aesop/store/core-store';
import type { FlowStore } from '@academy/aesop/store/flow-store';
import type { ReviewLogRecord, StoredReviewCard } from '@academy/aesop/store/learner-store';
import type { FlagQuery, LessonKey } from '@academy/aesop/store/lesson-store';
import type { DiagnosticRun, PlacementGrant } from '@academy/aesop/store/placement-review-store';
import type { ActivityQuery, SessionQuery } from '@academy/aesop/store/session-store';
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  gte,
  inArray,
  isNotNull,
  isNull,
  like,
  lt,
  lte,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';
import type { Card } from 'ts-fsrs';
import type { Database } from './client.js';
import {
  attempts,
  courseEnrollments,
  diagnosticRuns,
  hintEvents,
  lessonProblems,
  lessonQuizAttempts,
  lessonQuizItems,
  lessonRuns,
  mastery,
  masteryEvents,
  paperProgress,
  placementGrants,
  projectProgress,
  quizItems,
  quizRuns,
  remediationFlags,
  reviewCards,
  reviewLogs,
  sessionActivities,
  studySessions,
  topicSpeed,
  users,
  xpEvents,
} from './schema.js';

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

const { userId: _attemptOwner, ...attemptFields } = getTableColumns(attempts);
const { userId: _xpOwner, ...xpFields } = getTableColumns(xpEvents);
const { userId: _enrollmentOwner, ...enrollmentFields } = getTableColumns(courseEnrollments);
const { userId: _sessionOwner, ...sessionFields } = getTableColumns(studySessions);
const { userId: _flagOwner, ...flagFields } = getTableColumns(remediationFlags);
const { userId: _lessonOwner, ...lessonRunFields } = getTableColumns(lessonRuns);
const { userId: _diagnosticOwner, ...diagnosticFields } = getTableColumns(diagnosticRuns);
const { userId: _grantOwner, ...placementGrantFields } = getTableColumns(placementGrants);
const { userId: _timedQuizOwner, ...timedQuizFields } = getTableColumns(quizRuns);

function attemptOrder(order: AttemptQuery['order']) {
  switch (order) {
    case 'unordered':
      return [];
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
    suspendedAt: row.suspendedAt,
  };
}

function mapDiagnosticRun(row: Omit<typeof diagnosticRuns.$inferSelect, 'userId'>): DiagnosticRun {
  const courseId = (row.state as { courseId?: unknown } | null)?.courseId;
  return { ...row, courseId: typeof courseId === 'string' ? courseId : null };
}

export async function readPassedLessonQuizItems(
  db: Database,
  learnerId: string,
  conceptId: string,
  attemptId: string,
) {
  const rows = await db
    .select({ item: lessonQuizItems })
    .from(lessonQuizAttempts)
    .innerJoin(lessonRuns, eq(lessonRuns.id, lessonQuizAttempts.runId))
    .leftJoin(lessonQuizItems, eq(lessonQuizItems.quizAttemptId, lessonQuizAttempts.id))
    .where(
      and(
        eq(lessonQuizAttempts.id, attemptId),
        eq(lessonRuns.userId, learnerId),
        eq(lessonRuns.conceptId, conceptId),
        isNotNull(lessonQuizAttempts.submittedAt),
        eq(lessonQuizAttempts.passed, true),
      ),
    )
    .orderBy(lessonQuizItems.position, lessonQuizItems.id);
  if (rows.length === 0) return;
  return rows.flatMap(({ item }) => (item ? [item] : []));
}

export function drizzleLearnerStore(
  db: Database | Transaction,
  {
    activeReviewCardsOnly = false,
    schedulerTimezone,
  }: {
    activeReviewCardsOnly?: boolean;
    schedulerTimezone?: string;
  } = {},
): FlowStore & { connection: Database | Transaction } {
  const timedQuizOwner = (learnerId: string) => eq(quizRuns.userId, learnerId);
  const ownedTimedQuizRuns = (learnerId: string) =>
    db.select({ id: quizRuns.id }).from(quizRuns).where(timedQuizOwner(learnerId));

  function lessonWhere(learnerId: string, key: LessonKey) {
    return and(
      eq(lessonRuns.userId, learnerId),
      'runId' in key ? eq(lessonRuns.id, key.runId) : eq(lessonRuns.conceptId, key.conceptId),
    );
  }

  function ownedLesson(learnerId: string, runId: string) {
    return db
      .select({ id: lessonRuns.id })
      .from(lessonRuns)
      .where(lessonWhere(learnerId, { runId }));
  }

  function ownedQuizAttempts(learnerId: string, runId: string) {
    return db
      .select({ id: lessonQuizAttempts.id })
      .from(lessonQuizAttempts)
      .where(inArray(lessonQuizAttempts.runId, ownedLesson(learnerId, runId)));
  }

  function flagWhere(learnerId: string, query: FlagQuery) {
    return and(
      eq(remediationFlags.userId, learnerId),
      query.conceptId === undefined ? undefined : eq(remediationFlags.conceptId, query.conceptId),
      query.targetPrereqIds === undefined
        ? undefined
        : inArray(remediationFlags.targetPrereqId, query.targetPrereqIds),
      query.status === undefined ? undefined : eq(remediationFlags.status, query.status),
      query.excludeOpenedByActivityId === undefined
        ? undefined
        : or(
            isNull(remediationFlags.openedByAttemptId),
            notInArray(
              remediationFlags.openedByAttemptId,
              db
                .select({ id: attempts.id })
                .from(attempts)
                .where(eq(attempts.activityId, query.excludeOpenedByActivityId)),
            ),
          ),
    );
  }

  function sessionWhere(learnerId: string, query: SessionQuery) {
    return and(
      eq(studySessions.userId, learnerId),
      query.ids === undefined ? undefined : inArray(studySessions.id, query.ids),
      query.status === undefined ? undefined : eq(studySessions.status, query.status),
    );
  }

  function activityWhere(learnerId: string, query: ActivityQuery) {
    const owned = db
      .select({ id: studySessions.id })
      .from(studySessions)
      .where(sessionWhere(learnerId, { ids: query.sessionIds }));
    return and(
      inArray(sessionActivities.sessionId, owned),
      query.ids === undefined ? undefined : inArray(sessionActivities.id, query.ids),
      query.statuses === undefined ? undefined : inArray(sessionActivities.status, query.statuses),
      query.conceptId === undefined ? undefined : eq(sessionActivities.conceptId, query.conceptId),
    );
  }

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
    connection: db,
    async transaction(fn) {
      return db.transaction((tx) =>
        fn(drizzleLearnerStore(tx, { activeReviewCardsOnly, schedulerTimezone }) as typeof this),
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
    async listReviewCards(learnerId, conceptIds, options) {
      const rows = await db
        .select()
        .from(reviewCards)
        .where(
          and(
            eq(reviewCards.userId, learnerId),
            activeReviewCardsOnly || options?.activeOnly
              ? isNull(reviewCards.suspendedAt)
              : undefined,
            conceptIds === undefined ? undefined : inArray(reviewCards.conceptId, conceptIds),
          ),
        )
        .orderBy(asc(reviewCards.conceptId), asc(reviewCards.dimension), asc(reviewCards.id));
      return rows.map(mapReviewCard);
    },
    async getReviewCard(learnerId, conceptId, dimension, options) {
      const query = db
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
      const [row] = await (options?.forUpdate ? query.for('update') : query);
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
    async updateReviewCardIfDue(learnerId, cardId, expectedDueAt, next, options) {
      const rows = await db
        .update(reviewCards)
        .set({ fsrs: next.fsrs, dueAt: next.dueAt })
        .where(
          and(
            eq(reviewCards.userId, learnerId),
            eq(reviewCards.id, cardId),
            eq(reviewCards.dueAt, expectedDueAt),
            activeReviewCardsOnly || options?.activeOnly
              ? isNull(reviewCards.suspendedAt)
              : undefined,
          ),
        )
        .returning({ id: reviewCards.id });
      return rows.length > 0;
    },
    async listTimedQuizRuns(
      learnerId,
      { id, activityId, retakeOf, active, original, finalizedThrough },
    ) {
      const query = db
        .select(timedQuizFields)
        .from(quizRuns)
        .where(
          and(
            timedQuizOwner(learnerId),
            id === undefined ? undefined : eq(quizRuns.id, id),
            activityId === undefined ? undefined : eq(quizRuns.activityId, activityId),
            retakeOf === undefined ? undefined : eq(quizRuns.retakeOf, retakeOf),
            active ? isNull(quizRuns.finalizedAt) : undefined,
            original ? isNull(quizRuns.retakeOf) : undefined,
            finalizedThrough === undefined
              ? undefined
              : lte(quizRuns.finalizedAt, finalizedThrough),
          ),
        );
      return original
        ? query.orderBy(asc(quizRuns.finalizedAt), asc(quizRuns.startedAt), asc(quizRuns.seed))
        : query;
    },
    async listTimedQuizItems(learnerId, runIds) {
      if (!runIds.length) return [];
      return db
        .select()
        .from(quizItems)
        .where(
          and(
            inArray(quizItems.runId, runIds),
            inArray(quizItems.runId, ownedTimedQuizRuns(learnerId)),
          ),
        )
        .orderBy(asc(quizItems.position));
    },
    async insertTimedQuiz(learnerId, run, items) {
      const [row] = await db
        .insert(quizRuns)
        .values({ ...run, userId: learnerId })
        .returning(timedQuizFields);
      if (items.length)
        await db.insert(quizItems).values(items.map((item) => ({ ...item, runId: row.id })));
      return row;
    },
    async patchTimedQuizRun(learnerId, runId, patch) {
      const where = and(timedQuizOwner(learnerId), eq(quizRuns.id, runId));
      const [row] = await (Object.values(patch).some((value) => value !== undefined)
        ? db.update(quizRuns).set(patch).where(where).returning(timedQuizFields)
        : db.select(timedQuizFields).from(quizRuns).where(where));
      if (!row) throw new Error('Timed quiz run not found.');
      return row;
    },
    async patchTimedQuizItem(learnerId, runId, position, patch) {
      if (Object.values(patch).every((value) => value === undefined)) return;
      await db
        .update(quizItems)
        .set(patch)
        .where(
          and(
            eq(quizItems.runId, runId),
            eq(quizItems.position, position),
            inArray(quizItems.runId, ownedTimedQuizRuns(learnerId)),
          ),
        );
    },
    async linkTimedQuizFollowUps(learnerId, conceptIds, activityId) {
      if (!conceptIds.length) return;
      await db
        .update(quizItems)
        .set({ followUpActivityId: activityId })
        .where(
          and(
            eq(quizItems.followUp, true),
            isNull(quizItems.followUpActivityId),
            inArray(quizItems.conceptId, conceptIds),
            inArray(
              quizItems.runId,
              db
                .select({ id: quizRuns.id })
                .from(quizRuns)
                .where(and(timedQuizOwner(learnerId), isNotNull(quizRuns.finalizedAt))),
            ),
          ),
        );
    },
    async listDiagnosticRuns(learnerId, { id, courseId, status, forUpdate }) {
      const query = db
        .select(diagnosticFields)
        .from(diagnosticRuns)
        .where(
          and(
            eq(diagnosticRuns.userId, learnerId),
            id === undefined ? undefined : eq(diagnosticRuns.id, id),
            courseId === undefined
              ? undefined
              : sql`${diagnosticRuns.state} -> 'courseId' = to_jsonb(${courseId}::text)`,
            status === undefined ? undefined : eq(diagnosticRuns.status, status),
          ),
        )
        .orderBy(desc(diagnosticRuns.startedAt));
      return (await (forUpdate ? query.for('update') : query)).map(mapDiagnosticRun);
    },
    async insertDiagnosticRun(learnerId, { courseId: _courseId, ...run }) {
      const [row] = await db
        .insert(diagnosticRuns)
        .values({ ...run, userId: learnerId })
        .returning(diagnosticFields);
      return mapDiagnosticRun(row);
    },
    async patchDiagnosticRun(learnerId, runId, patch) {
      if (Object.values(patch).every((value) => value === undefined)) return;
      await db
        .update(diagnosticRuns)
        .set(patch)
        .where(and(eq(diagnosticRuns.userId, learnerId), eq(diagnosticRuns.id, runId)));
    },
    async listPlacementGrants(learnerId, query = {}) {
      const rows = await db
        .select(placementGrantFields)
        .from(placementGrants)
        .where(
          and(
            eq(placementGrants.userId, learnerId),
            query.conceptIds === undefined
              ? undefined
              : inArray(placementGrants.conceptId, query.conceptIds),
            query.state === undefined ? undefined : eq(placementGrants.state, query.state),
            query.excludeReasons?.length
              ? notInArray(placementGrants.reason, [...query.excludeReasons])
              : undefined,
          ),
        );
      return rows as PlacementGrant[];
    },
    async insertPlacementGrantsOnce(learnerId, grants) {
      if (grants.length === 0) return;
      await db
        .insert(placementGrants)
        .values(grants.map((grant) => ({ ...grant, userId: learnerId })))
        .onConflictDoNothing();
    },
    async patchPlacementGrants(learnerId, { ids, conceptId, ifState }, patch) {
      if (Object.values(patch).every((value) => value === undefined)) return;
      await db
        .update(placementGrants)
        .set(patch)
        .where(
          and(
            eq(placementGrants.userId, learnerId),
            ids === undefined ? undefined : inArray(placementGrants.id, ids),
            conceptId === undefined ? undefined : eq(placementGrants.conceptId, conceptId),
            ifState === undefined ? undefined : eq(placementGrants.state, ifState),
          ),
        );
    },
    async setReviewCardSuspension(learnerId, conceptIds, suspendedAt) {
      if (conceptIds.length === 0) return;
      await db
        .update(reviewCards)
        .set({ suspendedAt })
        .where(
          and(
            eq(reviewCards.userId, learnerId),
            inArray(reviewCards.conceptId, conceptIds),
            suspendedAt === null ? undefined : isNull(reviewCards.suspendedAt),
          ),
        );
    },
    async listReviewLogs(learnerId, { cardIds, activityId, since, limit }) {
      const rows = db
        .select({ ...getTableColumns(reviewLogs), conceptId: reviewCards.conceptId })
        .from(reviewLogs)
        .innerJoin(reviewCards, eq(reviewLogs.cardId, reviewCards.id))
        .where(
          and(
            eq(reviewCards.userId, learnerId),
            cardIds === undefined ? undefined : inArray(reviewLogs.cardId, cardIds),
            activityId === undefined ? undefined : eq(attempts.activityId, activityId),
            since === undefined ? undefined : gte(reviewLogs.createdAt, since),
          ),
        )
        .orderBy(desc(reviewLogs.createdAt))
        .$dynamic();
      if (activityId !== undefined) rows.innerJoin(attempts, eq(reviewLogs.attemptId, attempts.id));
      if (limit !== undefined) rows.limit(limit);
      return (await rows).map(({ fsrsLog: json, rawDueAt, speed, rating, ...row }) => {
        const fsrsLog = json as ReviewLogRecord['fsrsLog'];
        return {
          ...row,
          fsrsLog: {
            ...fsrsLog,
            ...(fsrsLog.due && { due: new Date(fsrsLog.due) }),
            ...(fsrsLog.review && { review: new Date(fsrsLog.review) }),
            ...(fsrsLog.effectiveDueAt && { effectiveDueAt: new Date(fsrsLog.effectiveDueAt) }),
          },
          rawDueAt: rawDueAt ?? undefined,
          speed: speed ?? undefined,
          rating: Number(rating) as ReviewLogRecord['rating'],
        };
      });
    },
    async patchReviewCard(learnerId, cardId, patch) {
      if (Object.values(patch).every((value) => value === undefined)) return;
      await db
        .update(reviewCards)
        .set(patch)
        .where(and(eq(reviewCards.userId, learnerId), eq(reviewCards.id, cardId)));
    },
    async appendReviewLog(learnerId, cardId, log) {
      const owned = db
        .select({ id: reviewCards.id })
        .from(reviewCards)
        .where(and(eq(reviewCards.userId, learnerId), eq(reviewCards.id, cardId)));
      await db
        .insert(reviewLogs)
        .values({ ...log, cardId: sql`(${owned})`, rating: String(log.rating) });
    },
    async listSessions(learnerId, query) {
      return db
        .select(sessionFields)
        .from(studySessions)
        .where(sessionWhere(learnerId, query))
        .orderBy(desc(studySessions.startedAt));
    },
    async lockSession(learnerId, sessionId) {
      const [row] = await db
        .select(sessionFields)
        .from(studySessions)
        .where(sessionWhere(learnerId, { ids: [sessionId] }))
        .for('update');
      return row;
    },
    async insertSession(learnerId, session) {
      const [row] = await db
        .insert(studySessions)
        .values({ ...session, userId: learnerId })
        .returning(sessionFields);
      if (!row) throw new Error('Unable to insert session');
      return row;
    },
    async patchSessions(learnerId, query, patch) {
      if (Object.values(patch).every((value) => value === undefined)) return;
      await db.update(studySessions).set(patch).where(sessionWhere(learnerId, query));
    },
    async listActivities(learnerId, query) {
      const ids = query.ids?.filter((id) =>
        /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id),
      );
      if (ids?.length === 0) return [];
      return db
        .select()
        .from(sessionActivities)
        .where(activityWhere(learnerId, { ...query, ids }))
        .orderBy(asc(sessionActivities.sessionId), asc(sessionActivities.idx));
    },
    async insertActivities(learnerId, sessionId, rows) {
      if (rows.length === 0) return [];
      const owned = db
        .select({ id: studySessions.id })
        .from(studySessions)
        .where(sessionWhere(learnerId, { ids: [sessionId] }));
      return db
        .insert(sessionActivities)
        .values(rows.map((row) => ({ ...row, sessionId: sql`(${owned})` })))
        .returning();
    },
    async patchActivities(learnerId, query, patch, expected) {
      if (Object.values(patch).every((value) => value === undefined)) return [];
      return db
        .update(sessionActivities)
        .set(patch)
        .where(
          and(
            activityWhere(learnerId, query),
            expected?.statuses === undefined
              ? undefined
              : inArray(sessionActivities.status, expected.statuses),
            expected?.exerciseIds === undefined
              ? undefined
              : eq(sessionActivities.exerciseIds, [...expected.exerciseIds]),
            expected?.reason === undefined
              ? undefined
              : sql`${sessionActivities.reason} = ${JSON.stringify(expected.reason)}::jsonb`,
          ),
        )
        .returning();
    },
    async deleteActivities(learnerId, query) {
      await db.delete(sessionActivities).where(activityWhere(learnerId, query));
    },
    async listLessonRuns(learnerId) {
      return db.select(lessonRunFields).from(lessonRuns).where(eq(lessonRuns.userId, learnerId));
    },
    async getLessonRun(learnerId, key, options) {
      if ('conceptId' in key && key.quizItemId !== undefined) {
        const joined = db
          .select(lessonRunFields)
          .from(lessonQuizItems)
          .innerJoin(lessonQuizAttempts, eq(lessonQuizItems.quizAttemptId, lessonQuizAttempts.id))
          .innerJoin(lessonRuns, eq(lessonQuizAttempts.runId, lessonRuns.id))
          .where(and(lessonWhere(learnerId, key), eq(lessonQuizItems.id, key.quizItemId)))
          .limit(1);
        const [row] = await (options?.forUpdate
          ? joined.for('update', { of: lessonRuns })
          : joined);
        return row;
      }
      const select = db
        .select(lessonRunFields)
        .from(lessonRuns)
        .where(lessonWhere(learnerId, key))
        .limit(1);
      const [row] = await (options?.forUpdate ? select.for('update') : select);
      return row;
    },
    async lockLessonProblem(learnerId, conceptId, problemId) {
      const [row] = await db
        .select({ run: lessonRunFields, problem: lessonProblems })
        .from(lessonProblems)
        .innerJoin(lessonRuns, eq(lessonProblems.runId, lessonRuns.id))
        .where(and(lessonWhere(learnerId, { conceptId }), eq(lessonProblems.id, problemId)))
        .for('update')
        .limit(1);
      return row;
    },
    async insertLessonRunIfAbsent(learnerId, run) {
      const [row] = await db
        .insert(lessonRuns)
        .values({ ...run, userId: learnerId })
        .onConflictDoNothing({ target: [lessonRuns.userId, lessonRuns.conceptId] })
        .returning(lessonRunFields);
      return row;
    },
    async patchLessonRun(learnerId, runId, patch) {
      const [row] = Object.values(patch).some((value) => value !== undefined)
        ? await db
            .update(lessonRuns)
            .set(patch)
            .where(lessonWhere(learnerId, { runId }))
            .returning(lessonRunFields)
        : [await this.getLessonRun(learnerId, { runId })];
      if (!row) throw new Error('Lesson run not found');
      return row;
    },
    async listLessonProblems(learnerId, runId) {
      return db
        .select(getTableColumns(lessonProblems))
        .from(lessonProblems)
        .innerJoin(lessonRuns, eq(lessonProblems.runId, lessonRuns.id))
        .where(lessonWhere(learnerId, { runId }))
        .orderBy(lessonProblems.servedAt, lessonProblems.position, lessonProblems.id);
    },
    async insertLessonProblem(learnerId, runId, problem) {
      const owned = ownedLesson(learnerId, runId);
      const [row] = await db
        .insert(lessonProblems)
        .values({ ...problem, runId: sql`(${owned})` })
        .returning();
      if (!row) throw new Error('Unable to insert lesson problem');
      return row;
    },
    async patchLessonProblem(learnerId, runId, problemId, patch) {
      if (Object.values(patch).every((value) => value === undefined)) return;
      await db
        .update(lessonProblems)
        .set(patch)
        .where(
          and(
            inArray(lessonProblems.runId, ownedLesson(learnerId, runId)),
            eq(lessonProblems.id, problemId),
          ),
        );
    },
    async deleteLessonProblems(learnerId, runId, ids) {
      if (ids.length === 0) return;
      await db
        .delete(lessonProblems)
        .where(
          and(
            inArray(lessonProblems.runId, ownedLesson(learnerId, runId)),
            inArray(lessonProblems.id, ids),
          ),
        );
    },
    async readLessonQuiz(learnerId, runId) {
      const rows = await db
        .select({ attempt: lessonQuizAttempts, item: lessonQuizItems })
        .from(lessonQuizAttempts)
        .leftJoin(lessonQuizItems, eq(lessonQuizItems.quizAttemptId, lessonQuizAttempts.id))
        .where(inArray(lessonQuizAttempts.runId, ownedLesson(learnerId, runId)))
        .orderBy(lessonQuizAttempts.attemptNo, lessonQuizItems.position, lessonQuizItems.id);
      return {
        quizAttempts: [...new Map(rows.map(({ attempt }) => [attempt.id, attempt])).values()],
        quizItems: rows.flatMap(({ item }) => (item ? [item] : [])),
      };
    },
    async insertLessonQuiz(learnerId, runId, attempt, items) {
      const owned = ownedLesson(learnerId, runId);
      const [row] = await db
        .insert(lessonQuizAttempts)
        .values({ ...attempt, runId: sql`(${owned})` })
        .returning();
      if (!row) throw new Error('Unable to insert lesson quiz');
      if (items.length) {
        await db
          .insert(lessonQuizItems)
          .values(items.map((item) => ({ ...item, quizAttemptId: row.id })));
      }
      return row;
    },
    async patchLessonQuizAttempt(learnerId, runId, attemptId, patch) {
      if (Object.values(patch).every((value) => value === undefined)) return;
      await db
        .update(lessonQuizAttempts)
        .set(patch)
        .where(
          and(
            inArray(lessonQuizAttempts.runId, ownedLesson(learnerId, runId)),
            eq(lessonQuizAttempts.id, attemptId),
          ),
        );
    },
    async patchLessonQuizItem(learnerId, runId, itemId, { replacementId, ...patch }, expected) {
      const where = and(
        inArray(lessonQuizItems.quizAttemptId, ownedQuizAttempts(learnerId, runId)),
        eq(lessonQuizItems.id, itemId),
        expected?.unanswered ? isNull(lessonQuizItems.answeredAt) : undefined,
      );
      const changes = { ...patch, id: replacementId };
      const [row] = Object.values(changes).some((value) => value !== undefined)
        ? await db.update(lessonQuizItems).set(changes).where(where).returning()
        : await db.select().from(lessonQuizItems).where(where);
      return row;
    },
    async deleteLessonQuizRows(learnerId, runId, { itemIds, attemptIds }) {
      if (itemIds?.length) {
        await db
          .delete(lessonQuizItems)
          .where(
            and(
              inArray(lessonQuizItems.quizAttemptId, ownedQuizAttempts(learnerId, runId)),
              inArray(lessonQuizItems.id, itemIds),
            ),
          );
      }
      if (attemptIds?.length) {
        await db
          .delete(lessonQuizAttempts)
          .where(
            and(
              inArray(lessonQuizAttempts.runId, ownedLesson(learnerId, runId)),
              inArray(lessonQuizAttempts.id, attemptIds),
            ),
          );
      }
    },
    async listRemediationFlags(learnerId, query) {
      return db.select(flagFields).from(remediationFlags).where(flagWhere(learnerId, query));
    },
    async insertRemediationFlags(learnerId, flags) {
      if (flags.length)
        await db
          .insert(remediationFlags)
          .values(flags.map((flag) => ({ ...flag, userId: learnerId })));
    },
    async resolveRemediationFlags(learnerId, query, now) {
      await db
        .update(remediationFlags)
        .set({ status: 'resolved', resolvedAt: now })
        .where(and(flagWhere(learnerId, query), eq(remediationFlags.status, 'open')));
    },
    async clearTopicProgress(learnerId, conceptId) {
      await db
        .delete(masteryEvents)
        .where(and(eq(masteryEvents.userId, learnerId), eq(masteryEvents.conceptId, conceptId)));
      await db
        .delete(mastery)
        .where(and(eq(mastery.userId, learnerId), eq(mastery.conceptId, conceptId)));
      await db
        .delete(reviewCards)
        .where(and(eq(reviewCards.userId, learnerId), eq(reviewCards.conceptId, conceptId)));
      await db.delete(lessonRuns).where(lessonWhere(learnerId, { conceptId }));
      await db
        .delete(remediationFlags)
        .where(
          and(
            eq(remediationFlags.userId, learnerId),
            or(
              eq(remediationFlags.conceptId, conceptId),
              eq(remediationFlags.targetPrereqId, conceptId),
            ),
          ),
        );
    },
    async readSchedulerFacts(learnerId, query) {
      const { now, recallExerciseIds } = query;
      const timezone = schedulerTimezone ?? (await this.getSettings(learnerId))?.timeZone ?? 'UTC';
      const endOfDay = startOfNextCalendarDay(now, timezone);
      const [
        masteryRows,
        cards,
        recentAttempts,
        flags,
        projects,
        lessonRunRows,
        paperRows,
        recentLearnActivities,
        todayReviewLogs,
        completedReviewLogsToday,
        recallAttemptRows,
        speedEvidence,
      ] = await Promise.all([
        query.skip?.includes('mastery') ? undefined : listMastery(learnerId),
        db
          .select()
          .from(reviewCards)
          .where(and(eq(reviewCards.userId, learnerId), isNull(reviewCards.suspendedAt)))
          .orderBy(asc(reviewCards.conceptId), asc(reviewCards.dimension), asc(reviewCards.id)),
        this.listAttempts(learnerId, { order: 'scheduler', limit: 100 }),
        db
          .select(flagFields)
          .from(remediationFlags)
          .where(and(eq(remediationFlags.userId, learnerId), eq(remediationFlags.status, 'open')))
          .orderBy(
            asc(remediationFlags.conceptId),
            asc(remediationFlags.targetPrereqId),
            asc(remediationFlags.id),
          ),
        query.skip?.includes('projectProgress')
          ? undefined
          : db
              .select({ projectId: projectProgress.projectId, status: projectProgress.status })
              .from(projectProgress)
              .where(eq(projectProgress.userId, learnerId))
              .orderBy(asc(projectProgress.projectId)),
        query.skip?.includes('lessonRuns')
          ? undefined
          : db
              .select({
                conceptId: lessonRuns.conceptId,
                status: lessonRuns.status,
                startedAt: lessonRuns.startedAt,
                retryAfter: lessonRuns.retryAfter,
              })
              .from(lessonRuns)
              .where(eq(lessonRuns.userId, learnerId))
              .orderBy(asc(lessonRuns.conceptId), desc(lessonRuns.startedAt), desc(lessonRuns.id)),
        db
          .select({ paperId: paperProgress.paperId, completedAt: paperProgress.completedAt })
          .from(paperProgress)
          .where(eq(paperProgress.userId, learnerId))
          .orderBy(asc(paperProgress.paperId)),
        db
          .select({
            conceptId: sessionActivities.conceptId,
            plannedMinutes: sql<number>`coalesce(sum(${sessionActivities.plannedMinutes}), 0)::int`,
          })
          .from(sessionActivities)
          .innerJoin(studySessions, eq(sessionActivities.sessionId, studySessions.id))
          .where(
            and(
              eq(studySessions.userId, learnerId),
              eq(sessionActivities.kind, 'learn'),
              eq(sessionActivities.status, 'completed'),
              gte(sessionActivities.completedAt, new Date(now.getTime() - 7 * 86_400_000)),
              lte(sessionActivities.completedAt, now),
            ),
          )
          .groupBy(sessionActivities.conceptId),
        db
          .select({ conceptId: reviewCards.conceptId, createdAt: reviewLogs.createdAt })
          .from(reviewLogs)
          .innerJoin(reviewCards, eq(reviewLogs.cardId, reviewCards.id))
          .where(
            and(
              eq(reviewCards.userId, learnerId),
              sql`coalesce(${reviewLogs.fsrsLog}->>'source', '') <> 'mixed_quiz'`,
              gte(reviewLogs.createdAt, new Date(now.getTime() - 36 * 60 * 60 * 1000)),
              lt(reviewLogs.createdAt, endOfDay),
            ),
          ),
        db
          .select({
            activityId: attempts.activityId,
            conceptId: reviewCards.conceptId,
            rating: reviewLogs.rating,
            createdAt: reviewLogs.createdAt,
          })
          .from(reviewLogs)
          .innerJoin(reviewCards, eq(reviewLogs.cardId, reviewCards.id))
          .innerJoin(attempts, eq(reviewLogs.attemptId, attempts.id))
          .innerJoin(sessionActivities, eq(attempts.activityId, sessionActivities.id))
          .where(
            and(
              eq(reviewCards.userId, learnerId),
              eq(sessionActivities.kind, 'review'),
              eq(sessionActivities.status, 'completed'),
              gte(reviewLogs.createdAt, new Date(now.getTime() - 36 * 60 * 60 * 1000)),
              lt(reviewLogs.createdAt, endOfDay),
            ),
          ),
        recallExerciseIds.length > 0
          ? db
              .selectDistinctOn([attempts.exerciseId], {
                exerciseId: attempts.exerciseId,
                correct: attempts.correct,
                createdAt: attempts.createdAt,
              })
              .from(attempts)
              .where(
                and(
                  eq(attempts.userId, learnerId),
                  sql`${attempts.exerciseId} = any(array[${sql.join(
                    recallExerciseIds.map((exerciseId) => sql`${exerciseId}`),
                    sql`, `,
                  )}]::text[])`,
                ),
              )
              .orderBy(
                asc(attempts.exerciseId),
                desc(attempts.createdAt),
                desc(attempts.attemptNo),
                desc(attempts.correct),
                desc(attempts.id),
              )
          : Promise.resolve(
              [] as Array<{
                exerciseId: string;
                correct: number;
                createdAt: Date;
              }>,
            ),
        this.listTopicSpeedEvidence(learnerId),
      ]);
      return {
        mastery: masteryRows,
        lessonRuns: lessonRunRows,
        projectProgress: projects,
        cards: cards.map(mapReviewCard),
        topicSpeeds: speedEvidence,
        recentAttempts,
        flags,
        paperProgress: paperRows,
        learnMinutes: recentLearnActivities,
        reviewLogFacts: todayReviewLogs,
        completedReviewLogFacts: completedReviewLogsToday,
        recallAttempts: recallAttemptRows,
      };
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
