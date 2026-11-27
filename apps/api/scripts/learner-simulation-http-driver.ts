import type { ContentIndex } from '@academy/aesop/course/types';
import { EngineLearnerRepository } from '@academy/aesop/engine/repository';
import {
  type ImplicitRepetitionTraceEvent,
  setImplicitRepetitionTrace,
} from '@academy/aesop/memory/mastery-service';
import { localDateKey } from '@academy/aesop/progress/xp';
import { and, asc, desc, eq, exists, inArray, notInArray, sql } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import type { Database } from '../src/db/client.js';
import { drizzleLearnerStore } from '../src/db/learner-store.js';
import {
  attempts,
  lessonProblems,
  lessonQuizAttempts,
  lessonQuizItems,
  lessonRuns,
  mastery,
  masteryEvents,
  placementGrants,
  quizItems,
  quizRuns,
  remediationFlags,
  reviewCards,
  reviewLogs,
  sessionActivities,
  studySessions,
  tutorMessages,
  users,
  xpEvents,
} from '../src/db/schema.js';
import { fsrsFuzzEnabled } from '../src/learning/fsrs-fuzz.js';
import type { SimulatorAudit, SimulatorFixtures } from './learner-simulation-audit.js';
import {
  type ApiResult,
  httpRequestFor,
  QuizClock,
  RequestRandomness,
  type SimulatedApiFailure,
  SimulatedApiFailureError,
  type SimulatorAfterCall,
  type SimulatorDriver,
  type SimulatorDriverFactory,
  type SimulatorDriverInput,
  type SimulatorOperation,
} from './learner-simulation-driver.js';

const repositoryFor = (db: Database, userId: string) =>
  new EngineLearnerRepository(
    drizzleLearnerStore(db),
    userId,
    undefined,
    undefined,
    fsrsFuzzEnabled(),
  );

/** Drives the real Hono app with a fake clock, and checks learner state in PostgreSQL. */
export class HttpPostgresDriver implements SimulatorDriver {
  private readonly quizClock = new QuizClock();
  private readonly randomness: RequestRandomness;
  private app: ReturnType<typeof createApp>;
  private content: ContentIndex;
  private readonly timeZone: string;
  private now: Date;
  private cookie: string | undefined;
  afterCall: SimulatorAfterCall | undefined;
  activityTrace: ((trace: readonly ImplicitRepetitionTraceEvent[]) => void) | undefined;
  readonly failedRequests: SimulatedApiFailure[] = [];
  readonly audit: SimulatorAudit;
  readonly fixtures: SimulatorFixtures;

  constructor(
    readonly db: Database,
    input: SimulatorDriverInput,
  ) {
    this.content = input.content;
    this.timeZone = input.timeZone;
    this.now = input.initialNow;
    this.randomness = new RequestRandomness(input.profile, (now) =>
      localDateKey(now, this.timeZone),
    );
    this.app = this.createApp();
    this.audit = postgresSimulatorAudit(db);
    this.fixtures = postgresSimulatorFixtures(db);
  }

  private createApp() {
    return createApp({
      db: this.db,
      content: this.content,
      demo: { ttlHours: 9_600 },
      tutorProvider: null,
      authClock: () => this.now,
    });
  }

  setContent(content: ContentIndex) {
    this.content = content;
    this.app = this.createApp();
  }

  get userId(): string | undefined {
    return this.cookie?.match(/^academy_demo=([^;]+)/)?.[1];
  }

  nextQuizTime(now: Date): Date {
    return this.quizClock.next(now);
  }

  async call(operation: SimulatorOperation, now: Date): Promise<ApiResult> {
    const { method, path, body } = httpRequestFor(operation);
    this.now = now;
    const random = this.randomness.next({ method, path, body }, now);
    const originalRandom = Math.random;
    Math.random = random;
    const headers = new Headers({
      'X-Now': now.toISOString(),
      'X-Time-Zone': this.timeZone,
    });
    if (this.cookie) headers.set('cookie', this.cookie);
    if (body !== undefined) headers.set('content-type', 'application/json');
    const trace: ImplicitRepetitionTraceEvent[] = [];
    setImplicitRepetitionTrace((event) => trace.push(event));
    try {
      const response = await this.app.request(`http://academy.local/api${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const setCookie = response.headers.get('set-cookie');
      if (setCookie) this.cookie = setCookie.split(';', 1)[0];
      let data: unknown = null;
      try {
        data = await response.json();
      } catch {
        data = null;
      }
      if (response.status >= 500) {
        const failure: SimulatedApiFailure = {
          method,
          path,
          status: response.status,
          ...(body === undefined ? {} : { requestBody: body }),
          responseBody: data,
        };
        this.failedRequests.push(failure);
        throw new SimulatedApiFailureError(failure);
      }
      await this.afterCall?.(method, path, now, trace);
      this.activityTrace?.(trace);
      return { ok: response.ok, status: response.status, data };
    } finally {
      setImplicitRepetitionTrace(undefined);
      Math.random = originalRandom;
    }
  }

  async require<T>(operation: SimulatorOperation, now: Date): Promise<T> {
    const result = await this.call(operation, now);
    if (!result.ok) {
      const { method, path } = httpRequestFor(operation);
      throw new Error(
        `${method} ${path} failed (${result.status}): ${JSON.stringify(result.data)}`,
      );
    }
    return result.data as T;
  }

  async cleanup() {
    if (this.userId) {
      await this.db.delete(users).where(eq(users.id, this.userId));
    }
  }
}

async function attemptHistory(db: Database, userId: string) {
  const [attemptRows, xpRows] = await Promise.all([
    db.select().from(attempts).where(eq(attempts.userId, userId)),
    db.select().from(xpEvents).where(eq(xpEvents.userId, userId)),
  ]);
  return {
    attempts: new Map(attemptRows.map((row) => [row.id, JSON.stringify(row)])),
    xp: new Map(xpRows.map((row) => [row.id, JSON.stringify(row)])),
  };
}

/** Builds one HTTP+PostgreSQL driver per simulated learner. */
export function httpPostgresDriver(db: Database): SimulatorDriverFactory {
  return (input) => new HttpPostgresDriver(db, input);
}

export function postgresSimulatorAudit(db: Database): SimulatorAudit {
  return {
    async progressRows(userId) {
      const [masteryRows, runs, placements, flags] = await Promise.all([
        db
          .select()
          .from(mastery)
          .where(eq(mastery.userId, userId))
          .orderBy(asc(mastery.conceptId), asc(mastery.dimension)),
        db
          .select()
          .from(lessonRuns)
          .where(eq(lessonRuns.userId, userId))
          .orderBy(asc(lessonRuns.conceptId), desc(lessonRuns.startedAt), desc(lessonRuns.id)),
        db
          .select({ conceptId: placementGrants.conceptId, state: placementGrants.state })
          .from(placementGrants)
          .where(eq(placementGrants.userId, userId))
          .orderBy(asc(placementGrants.createdAt), asc(placementGrants.id)),
        db
          .select()
          .from(remediationFlags)
          .where(and(eq(remediationFlags.userId, userId), eq(remediationFlags.status, 'open')))
          .orderBy(
            asc(remediationFlags.conceptId),
            asc(remediationFlags.targetPrereqId),
            asc(remediationFlags.id),
          ),
      ]);
      return { mastery: masteryRows, lessonRuns: runs, placements, openFlags: flags };
    },
    schedulerState: (userId, now, content) =>
      repositoryFor(db, userId).schedulerState(now, content),
    reviewCards: (userId) =>
      db
        .select()
        .from(reviewCards)
        .where(eq(reviewCards.userId, userId))
        .orderBy(asc(reviewCards.conceptId), asc(reviewCards.dimension), asc(reviewCards.id)),
    reviewCardDueDates: (userId, conceptIds) =>
      db
        .select({ conceptId: reviewCards.conceptId, dueAt: reviewCards.dueAt })
        .from(reviewCards)
        .where(and(eq(reviewCards.userId, userId), inArray(reviewCards.conceptId, conceptIds))),
    firstReviewCardsAt: (userId, now) =>
      db
        .select()
        .from(reviewCards)
        .where(
          and(
            eq(reviewCards.userId, userId),
            eq(reviewCards.lastReviewAt, now),
            eq(reviewCards.reps, 1),
          ),
        )
        .orderBy(asc(reviewCards.conceptId), asc(reviewCards.dimension)),
    activityReviewLogsAt: (userId, now) =>
      db
        .select({
          id: reviewLogs.id,
          cardId: reviewLogs.cardId,
          rating: reviewLogs.rating,
          conceptId: reviewCards.conceptId,
          dimension: reviewCards.dimension,
        })
        .from(reviewLogs)
        .innerJoin(reviewCards, eq(reviewLogs.cardId, reviewCards.id))
        .where(and(eq(reviewCards.userId, userId), eq(reviewLogs.createdAt, now)))
        .orderBy(
          asc(reviewLogs.createdAt),
          asc(reviewCards.conceptId),
          asc(reviewCards.dimension),
          asc(reviewLogs.rating),
          asc(reviewLogs.id),
        ),
    timedReviewLogsAt: (userId, now) =>
      db
        .select({
          id: reviewLogs.id,
          cardId: reviewLogs.cardId,
          rating: reviewLogs.rating,
          speed: reviewLogs.speed,
          rawDueAt: reviewLogs.rawDueAt,
          fsrsLog: reviewLogs.fsrsLog,
          cardDueAt: reviewCards.dueAt,
          conceptId: reviewCards.conceptId,
          dimension: reviewCards.dimension,
        })
        .from(reviewLogs)
        .innerJoin(reviewCards, eq(reviewCards.id, reviewLogs.cardId))
        .where(and(eq(reviewCards.userId, userId), eq(reviewLogs.createdAt, now)))
        .orderBy(asc(reviewCards.conceptId), asc(reviewCards.dimension)),
    reviewLogHistory: (cardIds) =>
      db
        .select({
          cardId: reviewLogs.cardId,
          rating: reviewLogs.rating,
          createdAt: reviewLogs.createdAt,
        })
        .from(reviewLogs)
        .where(inArray(reviewLogs.cardId, cardIds))
        .orderBy(desc(reviewLogs.createdAt)),
    attemptsAt: (userId, now) =>
      db
        .select({
          id: attempts.id,
          conceptId: attempts.conceptId,
          correct: attempts.correct,
          gradedBy: attempts.gradedBy,
          hintsUsed: attempts.hintsUsed,
          attemptNo: attempts.attemptNo,
          answer: attempts.answer,
          tutorHelped: exists(
            db
              .select({ id: tutorMessages.id })
              .from(tutorMessages)
              .innerJoin(lessonProblems, eq(lessonProblems.id, tutorMessages.lessonProblemId))
              .where(
                and(
                  eq(lessonProblems.attemptId, attempts.id),
                  eq(tutorMessages.userId, userId),
                  sql`${tutorMessages.role} = 'assistant'`,
                ),
              ),
          ),
        })
        .from(attempts)
        .leftJoin(lessonQuizItems, eq(lessonQuizItems.attemptId, attempts.id))
        .where(and(eq(attempts.userId, userId), eq(attempts.createdAt, now)))
        .orderBy(asc(lessonQuizItems.position), asc(attempts.conceptId), asc(attempts.id)),
    async latestLessonRun(userId, conceptId) {
      const [run] = await db
        .select({ id: lessonRuns.id, status: lessonRuns.status })
        .from(lessonRuns)
        .where(and(eq(lessonRuns.userId, userId), eq(lessonRuns.conceptId, conceptId)))
        .orderBy(desc(lessonRuns.updatedAt), desc(lessonRuns.id))
        .limit(1);
      return run;
    },
    async lessonRunTopics(userId) {
      const runs = await db
        .select({ conceptId: lessonRuns.conceptId })
        .from(lessonRuns)
        .where(eq(lessonRuns.userId, userId));
      return runs.map((run) => run.conceptId);
    },
    async completedLessonTopics(userId) {
      const runs = await db
        .select({ topic: lessonRuns.conceptId })
        .from(lessonRuns)
        .where(and(eq(lessonRuns.userId, userId), eq(lessonRuns.status, 'completed')));
      return runs.map(({ topic }) => topic);
    },
    lessonQuizAttempts: (runId) =>
      db
        .select()
        .from(lessonQuizAttempts)
        .where(eq(lessonQuizAttempts.runId, runId))
        .orderBy(lessonQuizAttempts.attemptNo),
    lessonQuizItems: (quizAttemptId) =>
      db
        .select()
        .from(lessonQuizItems)
        .where(eq(lessonQuizItems.quizAttemptId, quizAttemptId))
        .orderBy(asc(lessonQuizItems.position), asc(lessonQuizItems.id)),
    async lessonQuizItem(itemId) {
      const [item] = await db
        .select()
        .from(lessonQuizItems)
        .where(eq(lessonQuizItems.id, itemId))
        .limit(1);
      return item;
    },
    timedQuizRuns: (userId) =>
      db
        .select({ finalizedAt: quizRuns.finalizedAt, retakeOf: quizRuns.retakeOf })
        .from(quizRuns)
        .where(eq(quizRuns.userId, userId)),
    timedQuizItems: (runId) =>
      db
        .select()
        .from(quizItems)
        .where(eq(quizItems.runId, runId))
        .orderBy(asc(quizItems.position)),
    timedQuizHistory: (userId) =>
      db
        .select({ question: quizItems.question, runId: quizItems.runId })
        .from(quizItems)
        .innerJoin(quizRuns, eq(quizRuns.id, quizItems.runId))
        .where(eq(quizRuns.userId, userId)),
    async openTimedQuizActivityIds(userId) {
      const rows = await db
        .select({ id: sessionActivities.id })
        .from(sessionActivities)
        .innerJoin(studySessions, eq(studySessions.id, sessionActivities.sessionId))
        .where(
          and(
            eq(studySessions.userId, userId),
            eq(studySessions.status, 'active'),
            eq(sessionActivities.kind, 'mixed_quiz'),
            inArray(sessionActivities.status, ['planned', 'in_progress']),
          ),
        );
      return rows.map(({ id }) => id);
    },
    async xpAmounts(userId, sourceKey) {
      const rows = await db
        .select({ amount: xpEvents.amount })
        .from(xpEvents)
        .where(and(eq(xpEvents.userId, userId), eq(xpEvents.sourceKey, sourceKey)));
      return rows.map(({ amount }) => amount);
    },
    async activityStatus(activityId) {
      const [row] = await db
        .select({ status: sessionActivities.status })
        .from(sessionActivities)
        .where(eq(sessionActivities.id, activityId))
        .limit(1);
      return row?.status;
    },
    sessionActivities: (sessionId) =>
      db
        .select()
        .from(sessionActivities)
        .where(eq(sessionActivities.sessionId, sessionId))
        .orderBy(asc(sessionActivities.idx)),
    placementGrants: (userId) =>
      db
        .select()
        .from(placementGrants)
        .where(eq(placementGrants.userId, userId))
        .orderBy(asc(placementGrants.createdAt), asc(placementGrants.id)),
    async confirmedGrantTopics(userId) {
      const grants = await db
        .select({ topic: placementGrants.conceptId })
        .from(placementGrants)
        .where(
          and(
            eq(placementGrants.userId, userId),
            eq(placementGrants.state, 'confirmed'),
            notInArray(placementGrants.reason, ['legacy_confirmed', 'legacy_provisional']),
          ),
        );
      return grants.map(({ topic }) => topic);
    },
    withdrawnGrants: (userId) =>
      db
        .select({ id: placementGrants.id, conceptId: placementGrants.conceptId })
        .from(placementGrants)
        .where(and(eq(placementGrants.userId, userId), eq(placementGrants.state, 'withdrawn'))),
    lessonRuns: (userId) => db.select().from(lessonRuns).where(eq(lessonRuns.userId, userId)),
    attempts: (userId) => db.select().from(attempts).where(eq(attempts.userId, userId)),
    remediationFlags: (userId) =>
      db.select().from(remediationFlags).where(eq(remediationFlags.userId, userId)),
    attemptHistory: (userId) => attemptHistory(db, userId),
    async learnerSnapshot(userId) {
      const [grants, masteryRows, events, cards, flags, history] = await Promise.all([
        db
          .select()
          .from(placementGrants)
          .where(eq(placementGrants.userId, userId))
          .orderBy(asc(placementGrants.id)),
        db
          .select()
          .from(mastery)
          .where(eq(mastery.userId, userId))
          .orderBy(asc(mastery.conceptId), asc(mastery.dimension)),
        db
          .select({ id: masteryEvents.id })
          .from(masteryEvents)
          .where(eq(masteryEvents.userId, userId)),
        db
          .select()
          .from(reviewCards)
          .where(eq(reviewCards.userId, userId))
          .orderBy(asc(reviewCards.id)),
        db
          .select()
          .from(remediationFlags)
          .where(eq(remediationFlags.userId, userId))
          .orderBy(asc(remediationFlags.id)),
        attemptHistory(db, userId),
      ]);
      return JSON.stringify({
        grants,
        mastery: masteryRows,
        masteryEvents: events.length,
        cards,
        flags,
        attempts: [...history.attempts].sort(),
        xp: [...history.xp].sort(),
      });
    },
    store: () => drizzleLearnerStore(db),
  };
}

export function postgresSimulatorFixtures(db: Database): SimulatorFixtures {
  return {
    async seedScriptedScenario({ userId, now, courseId, masteryRows, reviewCards: cards }) {
      await repositoryFor(db, userId).startCourse(courseId, 'beginning', now);
      await db
        .update(users)
        .set({
          activeCourseId: courseId,
          studySetInitializedAt: now,
          timezone: 'UTC',
          startDate: '2026-01-05',
        })
        .where(eq(users.id, userId));
      await db.delete(reviewCards).where(eq(reviewCards.userId, userId));
      await db.delete(lessonRuns).where(eq(lessonRuns.userId, userId));
      await db.delete(mastery).where(eq(mastery.userId, userId));
      await db.insert(mastery).values(masteryRows);
      await db.insert(reviewCards).values(cards);
    },
    async seedCompletedLessons({ userId, conceptIds, now, xp }) {
      await db
        .insert(lessonRuns)
        .values(
          conceptIds.map((conceptId) => ({
            userId,
            conceptId,
            status: 'completed' as const,
            startedAt: now,
            updatedAt: now,
            completedAt: now,
          })),
        )
        .onConflictDoNothing();
      await db.insert(xpEvents).values({
        userId,
        kind: 'knowledge_point',
        sourceKey: xp.sourceKey,
        amount: xp.amount,
        earnedAt: now,
        localDate: xp.localDate,
      });
    },
  };
}
