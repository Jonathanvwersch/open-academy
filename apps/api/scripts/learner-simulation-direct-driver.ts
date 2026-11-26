import type { ContentIndex } from '@academy/aesop/course/types';
import {
  type ImplicitRepetitionTraceEvent,
  setImplicitRepetitionTrace,
} from '@academy/aesop/memory/mastery-service';
import type { MasteryRecord } from '@academy/aesop/memory/types';
import { localDateKey } from '@academy/aesop/progress/xp';
import { type MemoryLearnerStore, memoryStore } from '@academy/aesop/store/memory-store';
import type {
  AuditAttemptRow,
  AuditLessonRunRow,
  AuditMasteryRow,
  AuditPlacementGrantRow,
  AuditRemediationFlagRow,
  AuditReviewCardRow,
  SimulatorAudit,
  SimulatorFixtures,
} from './learner-simulation-audit.js';
import type { DirectRequest } from './learner-simulation-direct-lessons.js';
import { directOperation, type PaperProgressRow } from './learner-simulation-direct-ops.js';
import { DirectLearnerRepository, directUser } from './learner-simulation-direct-repo.js';
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

const learnerId = '00000000-0000-4000-8000-000000000001';

/** Deterministic UUID-shaped ids, so ids look the same to every check as they do over HTTP. */
function uuidCounter() {
  let count = 0;
  return () => `00000000-0000-4000-8000-${(++count).toString(16).padStart(12, '0')}`;
}

/** Calls Aesop use cases on a fresh in-memory store for each learner: no app, database or keys. */
export class DirectMemoryDriver implements SimulatorDriver {
  private readonly quizClock = new QuizClock();
  private readonly randomness: RequestRandomness;
  private readonly papers = new Map<string, PaperProgressRow>();
  private readonly newId = uuidCounter();
  private content: ContentIndex;
  private readonly timeZone: string;
  private store: MemoryLearnerStore | undefined;
  private createdAt: Date | undefined;
  afterCall: SimulatorAfterCall | undefined;
  activityTrace: ((trace: readonly ImplicitRepetitionTraceEvent[]) => void) | undefined;
  readonly failedRequests: SimulatedApiFailure[] = [];
  readonly audit: SimulatorAudit;
  readonly fixtures: SimulatorFixtures;

  constructor(input: SimulatorDriverInput) {
    this.content = input.content;
    this.timeZone = input.timeZone;
    this.randomness = new RequestRandomness(input.profile, (now) =>
      localDateKey(now, this.timeZone),
    );
    const store = () => {
      if (!this.store) throw new Error('The simulated learner has not made a request yet');
      return this.store;
    };
    this.audit = memorySimulatorAudit(store, () => this.createdAt ?? new Date(0));
    this.fixtures = memorySimulatorFixtures(store);
  }

  get userId(): string | undefined {
    return this.store ? learnerId : undefined;
  }

  setContent(content: ContentIndex) {
    this.content = content;
  }

  nextQuizTime(now: Date): Date {
    return this.quizClock.next(now);
  }

  private learnerStore(now: Date) {
    if (!this.store) {
      this.createdAt = now;
      this.store = memoryStore({
        settings: new Map([
          [
            learnerId,
            {
              activeCourseId: null,
              studySetInitializedAt: null,
              startDate: localDateKey(now, this.timeZone),
              timeZone: this.timeZone,
              prefs: { scheduleMinutes: 60, demo: true },
            },
          ],
        ]),
      });
    }
    return this.store;
  }

  async call(operation: SimulatorOperation, now: Date): Promise<ApiResult> {
    const { method, path, body } = httpRequestFor(operation);
    const store = this.learnerStore(now);
    const createdAt = this.createdAt ?? now;
    const random = this.randomness.next({ method, path, body }, now);
    const trace: ImplicitRepetitionTraceEvent[] = [];
    setImplicitRepetitionTrace((event) => trace.push(event));
    try {
      let settings = await store.getSettings(learnerId);
      if (settings && settings.timeZone !== this.timeZone) {
        if ((await store.listXpEvents(learnerId, {})).length > 0) {
          throw new Error('The direct driver cannot move XP days to a new time zone');
        }
        await store.patchSettings(learnerId, { timeZone: this.timeZone });
        settings = await store.getSettings(learnerId);
      }
      const content = this.content;
      const clock = () => now;
      const repository = (
        target: MemoryLearnerStore,
        requestUser: boolean,
        sessionContent: boolean,
      ) =>
        new DirectLearnerRepository(
          target,
          learnerId,
          createdAt,
          requestUser ? directUser(learnerId, createdAt, settings) : undefined,
          sessionContent ? { load: async () => content, now: clock } : undefined,
        );
      const request: DirectRequest = {
        store,
        userId: learnerId,
        timeZone: this.timeZone,
        now: clock,
        content,
        random,
        newId: this.newId,
        repo: repository(store, true, true),
        freshRepo: (target, sessionContent) => repository(target, false, sessionContent),
      };
      let response: { status: number; body: unknown };
      try {
        response = await directOperation(request, operation, this.papers);
      } catch (error) {
        response = {
          status: 500,
          body: { error: error instanceof Error ? error.message : String(error) },
        };
      }
      const data: unknown =
        response.body === undefined ? null : JSON.parse(JSON.stringify(response.body));
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
      return { ok: response.status >= 200 && response.status < 300, status: response.status, data };
    } finally {
      setImplicitRepetitionTrace(undefined);
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
    this.store = undefined;
  }
}

/** Builds one in-memory driver per simulated learner. */
export const directMemoryDriver: SimulatorDriverFactory = (input) => new DirectMemoryDriver(input);

/**
 * The value a Drizzle `jsonb` column returns: plain JSON with keys ordered by length, then bytes.
 * Drizzle parses a top-level string once more, keeping its text order, so "0" reads back as 0.
 */
function jsonb(value: unknown): unknown {
  const order = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(order);
    if (entry === null || typeof entry !== 'object') return entry;
    const keys = Object.keys(entry).sort((left, right) =>
      left.length !== right.length
        ? left.length - right.length
        : Buffer.compare(Buffer.from(left), Buffer.from(right)),
    );
    return Object.fromEntries(
      keys.map((key) => [key, order((entry as Record<string, unknown>)[key])]),
    );
  };
  if (value === undefined) return null;
  const json: unknown = JSON.parse(JSON.stringify(value));
  if (typeof json !== 'string') return order(json);
  try {
    return JSON.parse(json);
  } catch {
    return json;
  }
}

const date = (value: Date | string | null | undefined) =>
  value === null || value === undefined ? null : new Date(value);

function masteryRow(userId: string, record: MasteryRecord): AuditMasteryRow {
  return {
    userId,
    conceptId: record.conceptId,
    dimension: record.dimension,
    state: record.state,
    provisional: record.provisional,
    inferred: record.inferred,
    evidence: jsonb({
      independentItemIds: record.independentItemIds,
      independentDeterministicCount: record.independentDeterministicCount,
      lastIndependentCorrect: record.lastIndependentCorrect,
      attempts: record.attempts,
    }),
    lastAssessedAt: date(record.lastAssessedAt),
    lastIndependentAt: date(record.lastIndependentAt),
    firstIndependentAt: date(record.firstIndependentAt),
  } as AuditMasteryRow;
}

const jsonbRows = <R>(rows: readonly object[], jsonbFields: readonly string[], extra = {}) =>
  rows.map((row) => {
    const copy: Record<string, unknown> = { ...row, ...extra };
    for (const field of jsonbFields) if (field in copy) copy[field] = jsonb(copy[field]);
    return copy as R;
  });

const withUser = <T extends object, R>(
  userId: string,
  rows: readonly T[],
  jsonbFields: readonly string[] = [],
) => jsonbRows<R>(rows, jsonbFields, { userId });

const compare = (...pairs: Array<[string | number, string | number]>) => {
  for (const [left, right] of pairs) {
    if (left < right) return -1;
    if (left > right) return 1;
  }
  return 0;
};

const time = (value: Date | string | null | undefined) =>
  value === null || value === undefined ? 0 : new Date(value).getTime();

/** Reads the same audit facts as the PostgreSQL audit, in the same row order. */
export function memorySimulatorAudit(
  store: () => MemoryLearnerStore,
  createdAt: () => Date,
): SimulatorAudit {
  const masteryRows = async (userId: string) =>
    (await store().listMastery(userId))
      .map((record) => masteryRow(userId, record))
      .sort((left, right) =>
        compare([left.conceptId, right.conceptId], [left.dimension, right.dimension]),
      );
  const lessonRuns = async (userId: string) =>
    withUser<object, AuditLessonRunRow>(userId, await store().listLessonRuns(userId));
  const grants = async (userId: string) =>
    withUser<object, AuditPlacementGrantRow>(userId, await store().listPlacementGrants(userId), [
      'evidenceAttemptIds',
    ]).sort((left, right) =>
      compare([time(left.createdAt), time(right.createdAt)], [left.id, right.id]),
    );
  const flags = async (userId: string) =>
    withUser<object, AuditRemediationFlagRow>(
      userId,
      await store().listRemediationFlags(userId, {}),
    );
  const cards = async (userId: string) =>
    withUser<object, AuditReviewCardRow>(userId, await store().listReviewCards(userId), [
      'fsrs',
    ]).sort((left, right) =>
      compare(
        [left.conceptId, right.conceptId],
        [left.dimension, right.dimension],
        [left.id, right.id],
      ),
    );
  const logs = async (userId: string) => {
    const all = await cards(userId);
    const byId = new Map(all.map((card) => [card.id, card]));
    const rows = await store().listReviewLogs(userId, { cardIds: [...byId.keys()] });
    return rows.map((log) => ({ log, card: byId.get(log.cardId) as AuditReviewCardRow }));
  };
  const attemptRows = async (userId: string) =>
    withUser<object, AuditAttemptRow>(userId, await store().listAttempts(userId, {}), [
      'answer',
      'feedback',
    ]);
  const xpRows = async (userId: string) =>
    withUser<object, { id: string; amount: number; sourceKey: string }>(
      userId,
      await store().listXpEvents(userId, {}),
    );
  const attemptHistory = async (userId: string) => {
    const [attemptList, xpList] = await Promise.all([attemptRows(userId), xpRows(userId)]);
    return {
      attempts: new Map(attemptList.map((row) => [row.id, JSON.stringify(row)])),
      xp: new Map(xpList.map((row) => [row.id, JSON.stringify(row)])),
    };
  };
  const repository = (userId: string) => new DirectLearnerRepository(store(), userId, createdAt());
  const audit: SimulatorAudit = {
    async progressRows(userId) {
      const [mastery, runs, placements, open] = await Promise.all([
        masteryRows(userId),
        lessonRuns(userId),
        grants(userId),
        flags(userId),
      ]);
      return {
        mastery,
        lessonRuns: runs.sort((left, right) =>
          compare(
            [left.conceptId, right.conceptId],
            [time(right.startedAt), time(left.startedAt)],
            [right.id, left.id],
          ),
        ),
        placements: placements.map(({ conceptId, state }) => ({ conceptId, state })),
        openFlags: open
          .filter((flag) => flag.status === 'open')
          .sort((left, right) =>
            compare(
              [left.conceptId, right.conceptId],
              [left.targetPrereqId ?? '\uffff', right.targetPrereqId ?? '\uffff'],
              [left.id, right.id],
            ),
          ),
      };
    },
    schedulerState: (userId, now, content) => repository(userId).schedulerState(now, content),
    reviewCards: cards,
    async reviewCardDueDates(userId, conceptIds) {
      return (await cards(userId))
        .filter((card) => conceptIds.includes(card.conceptId))
        .map(({ conceptId, dueAt }) => ({ conceptId, dueAt }));
    },
    async firstReviewCardsAt(userId, now) {
      return (await cards(userId)).filter(
        (card) => time(card.lastReviewAt) === now.getTime() && card.reps === 1,
      );
    },
    async activityReviewLogsAt(userId, now) {
      return (await logs(userId))
        .filter(({ log }) => time(log.createdAt) === now.getTime())
        .sort((left, right) =>
          compare(
            [left.card.conceptId, right.card.conceptId],
            [left.card.dimension, right.card.dimension],
            [left.log.rating, right.log.rating],
            [left.log.id, right.log.id],
          ),
        )
        .map(({ log, card }) => ({
          id: log.id,
          cardId: log.cardId,
          rating: String(log.rating),
          conceptId: card.conceptId,
          dimension: card.dimension,
        })) as unknown as Awaited<ReturnType<SimulatorAudit['activityReviewLogsAt']>>;
    },
    async timedReviewLogsAt(userId, now) {
      return (await logs(userId))
        .filter(({ log }) => time(log.createdAt) === now.getTime())
        .sort((left, right) =>
          compare(
            [left.card.conceptId, right.card.conceptId],
            [left.card.dimension, right.card.dimension],
          ),
        )
        .map(({ log, card }) => ({
          id: log.id,
          cardId: log.cardId,
          rating: String(log.rating),
          speed: log.speed,
          rawDueAt: date(log.rawDueAt),
          fsrsLog: jsonb(log.fsrsLog),
          cardDueAt: new Date(card.dueAt),
          conceptId: card.conceptId,
          dimension: card.dimension,
        })) as unknown as Awaited<ReturnType<SimulatorAudit['timedReviewLogsAt']>>;
    },
    async reviewLogHistory(cardIds) {
      const userId = learnerOf(cardIds);
      const rows = await store().listReviewLogs(userId, { cardIds });
      return rows
        .map(({ cardId, rating, createdAt: at }) => ({
          cardId,
          rating: String(rating),
          createdAt: new Date(at),
        }))
        .sort(
          (left, right) => right.createdAt.getTime() - left.createdAt.getTime(),
        ) as unknown as Awaited<ReturnType<SimulatorAudit['reviewLogHistory']>>;
    },
    async attemptsAt(userId, now) {
      const runs = await store().listLessonRuns(userId);
      const positions = new Map<string, number>();
      for (const run of runs) {
        const quiz = await store().readLessonQuiz(userId, run.id);
        for (const item of quiz.quizItems) {
          if (item.attemptId) positions.set(item.attemptId, item.position);
        }
      }
      const position = (id: string) => positions.get(id) ?? Number.POSITIVE_INFINITY;
      return (await attemptRows(userId))
        .filter((attempt) => time(attempt.createdAt) === now.getTime())
        .sort((left, right) =>
          compare(
            [position(left.id), position(right.id)],
            [left.conceptId, right.conceptId],
            [left.id, right.id],
          ),
        )
        .map(({ id, conceptId, correct, gradedBy, hintsUsed, attemptNo, answer }) => ({
          id,
          conceptId,
          correct,
          gradedBy,
          hintsUsed,
          attemptNo,
          answer,
          tutorHelped: false,
        }));
    },
    async latestLessonRun(userId, conceptId) {
      const [run] = (await lessonRuns(userId))
        .filter((row) => row.conceptId === conceptId)
        .sort((left, right) =>
          compare([time(right.updatedAt), time(left.updatedAt)], [right.id, left.id]),
        );
      return run && { id: run.id, status: run.status };
    },
    async lessonRunTopics(userId) {
      return (await lessonRuns(userId)).map((run) => run.conceptId);
    },
    async completedLessonTopics(userId) {
      return (await lessonRuns(userId))
        .filter((run) => run.status === 'completed')
        .map((run) => run.conceptId);
    },
    async lessonQuizAttempts(runId) {
      const quiz = await store().readLessonQuiz(learnerId, runId);
      return [...quiz.quizAttempts].sort((left, right) => left.attemptNo - right.attemptNo);
    },
    async lessonQuizItems(quizAttemptId) {
      return (await allLessonQuizItems())
        .filter((item) => item.quizAttemptId === quizAttemptId)
        .sort((left, right) => compare([left.position, right.position], [left.id, right.id]));
    },
    async lessonQuizItem(itemId) {
      return (await allLessonQuizItems()).find((item) => item.id === itemId);
    },
    async timedQuizRuns(userId) {
      return (await store().listTimedQuizRuns(userId, {})).map(({ finalizedAt, retakeOf }) => ({
        finalizedAt: date(finalizedAt),
        retakeOf,
      }));
    },
    async timedQuizItems(runId) {
      return jsonbRows<{ position: number }>(await store().listTimedQuizItems(learnerId, [runId]), [
        'question',
        'submission',
      ]).sort((left, right) => left.position - right.position) as Awaited<
        ReturnType<SimulatorAudit['timedQuizItems']>
      >;
    },
    async timedQuizHistory(userId) {
      const runs = await store().listTimedQuizRuns(userId, {});
      const items = await store().listTimedQuizItems(
        userId,
        runs.map((run) => run.id),
      );
      return items.map(({ question, runId }) => ({ question, runId })) as Awaited<
        ReturnType<SimulatorAudit['timedQuizHistory']>
      >;
    },
    async openTimedQuizActivityIds(userId) {
      const sessions = await store().listSessions(userId, { status: 'active' });
      if (sessions.length === 0) return [];
      const activities = await store().listActivities(userId, {
        sessionIds: sessions.map((session) => session.id),
        statuses: ['planned', 'in_progress'],
      });
      return activities.filter((row) => row.kind === 'mixed_quiz').map(({ id }) => id);
    },
    async xpAmounts(userId, sourceKey) {
      return (await store().listXpEvents(userId, { sourceKey })).map(({ amount }) => amount);
    },
    async activityStatus(activityId) {
      const [row] = await store().listActivities(learnerId, { ids: [activityId] });
      return row?.status;
    },
    async sessionActivities(sessionId) {
      return jsonbRows<{ idx: number }>(
        await store().listActivities(learnerId, { sessionIds: [sessionId] }),
        ['progress', 'reason'],
      ).sort((left, right) => left.idx - right.idx) as Awaited<
        ReturnType<SimulatorAudit['sessionActivities']>
      >;
    },
    placementGrants: grants,
    async confirmedGrantTopics(userId) {
      return (await grants(userId))
        .filter(
          (grant) =>
            grant.state === 'confirmed' &&
            grant.reason !== 'legacy_confirmed' &&
            grant.reason !== 'legacy_provisional',
        )
        .map((grant) => grant.conceptId);
    },
    async withdrawnGrants(userId) {
      return (await grants(userId))
        .filter((grant) => grant.state === 'withdrawn')
        .map(({ id, conceptId }) => ({ id, conceptId }));
    },
    lessonRuns,
    attempts: attemptRows,
    remediationFlags: flags,
    attemptHistory,
    async learnerSnapshot(userId) {
      const [grantRows, mastery, cardRows, flagRows, history] = await Promise.all([
        grants(userId),
        masteryRows(userId),
        cards(userId),
        flags(userId),
        attemptHistory(userId),
      ]);
      const content = await store().listMastery(userId);
      const events = await store().listCourseMasteryEvents(userId, [
        ...new Set(content.map((record) => record.conceptId)),
      ]);
      return JSON.stringify({
        grants: [...grantRows].sort((left, right) => compare([left.id, right.id])),
        mastery,
        masteryEvents: events.length,
        cards: [...cardRows].sort((left, right) => compare([left.id, right.id])),
        flags: [...flagRows].sort((left, right) => compare([left.id, right.id])),
        attempts: [...history.attempts].sort(),
        xp: [...history.xp].sort(),
      });
    },
    store: () => store(),
  };
  const allLessonQuizItems = async () => {
    const items = [];
    for (const run of await store().listLessonRuns(learnerId)) {
      items.push(...(await store().readLessonQuiz(learnerId, run.id)).quizItems);
    }
    return items;
  };
  const learnerOf = (_cardIds: readonly string[]) => learnerId;
  return audit;
}

/** Writes scripted starting states into a fresh memory store. */
export function memorySimulatorFixtures(store: () => MemoryLearnerStore): SimulatorFixtures {
  return {
    async seedScriptedScenario({ userId, now, courseId, masteryRows, reviewCards }) {
      const target = store();
      const [existingCards, existingRuns, existingMastery] = await Promise.all([
        target.listReviewCards(userId),
        target.listLessonRuns(userId),
        target.listMastery(userId),
      ]);
      if (existingCards.length || existingRuns.length || existingMastery.length) {
        throw new Error('Scripted scenarios start from a learner with no progress');
      }
      await new DirectLearnerRepository(target, userId, now).startCourse(
        courseId,
        'beginning',
        now,
      );
      await target.patchSettings(userId, {
        activeCourseId: courseId,
        studySetInitializedAt: now,
        timeZone: 'UTC',
        startDate: '2026-01-05',
      });
      for (const row of masteryRows) {
        const evidence = (row.evidence ?? {}) as Partial<MasteryRecord>;
        await target.saveMastery(userId, {
          conceptId: row.conceptId,
          dimension: row.dimension,
          state: row.state ?? 'not_started',
          provisional: row.provisional ?? false,
          inferred: row.inferred ?? false,
          independentItemIds: evidence.independentItemIds ?? [],
          independentDeterministicCount: evidence.independentDeterministicCount ?? 0,
          lastIndependentCorrect: evidence.lastIndependentCorrect ?? false,
          attempts: evidence.attempts ?? [],
          lastAssessedAt: row.lastAssessedAt ?? null,
          lastIndependentAt: row.lastIndependentAt ?? null,
          firstIndependentAt: row.firstIndependentAt ?? null,
        } as MasteryRecord);
      }
      for (const card of reviewCards) {
        await target.insertReviewCard(userId, {
          conceptId: card.conceptId,
          dimension: card.dimension,
          fsrs: card.fsrs,
          dueAt: card.dueAt,
          lastReviewAt: card.lastReviewAt ?? null,
          reps: card.reps ?? 0,
          lapses: card.lapses ?? 0,
          suspendedAt: card.suspendedAt ?? null,
        } as Parameters<MemoryLearnerStore['insertReviewCard']>[1]);
      }
    },
    async seedCompletedLessons({ userId, conceptIds, now, xp }) {
      const target = store();
      for (const conceptId of conceptIds) {
        await target.insertLessonRunIfAbsent(userId, {
          conceptId,
          status: 'completed',
          startedAt: now,
          updatedAt: now,
          completedAt: now,
          quizPassedAt: null,
          attempt: 1,
          haltedAt: null,
          retryAfter: null,
          haltedPointIndex: null,
          haltCount: 0,
        });
      }
      await target.insertXpEventOnce(userId, {
        kind: 'knowledge_point',
        sourceKey: xp.sourceKey,
        conceptId: null,
        amount: xp.amount,
        earnedAt: now,
        localDate: xp.localDate,
      });
    },
  };
}
