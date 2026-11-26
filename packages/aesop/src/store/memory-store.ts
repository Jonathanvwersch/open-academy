import type { Dimension } from '../course/schemas.js';
import { startOfNextCalendarDay } from '../memory/fsrs.js';
import { TOPIC_SPEED_DECAY, TOPIC_SPEED_POLICY, type TopicSpeedEvidence } from '../memory/speed.js';
import type { MasteryRecord } from '../memory/types.js';
import type { Attempt, AttemptQuery, Enrollment, Settings, XpEvent } from './core-store.js';
import {
  type CourseProjectProgress,
  type CourseStore,
  compareCompletedActivities,
} from './course-store.js';
import { collectTimedQuizItemKeys, type TimedQuizItem, type TimedQuizRun } from './flow-store.js';
import type { MasteryEventRecord, OpenRemediationFlag, StoredReviewCard } from './learner-store.js';
import type {
  FlagQuery,
  LessonProblem,
  LessonQuizAttempt,
  LessonQuizItem,
  LessonRun,
  ReviewLogEntry,
} from './lesson-store.js';
import type { DiagnosticRun, PlacementGrant } from './placement-review-store.js';
import type {
  Activity,
  ActivityQuery,
  RemediationFlag,
  SchedulerFacts,
  Session,
} from './session-store.js';

export type MemoryLearnerStore = CourseStore & {
  addRemediationFlag(
    learnerId: string,
    flag: { conceptId: string; targetPrereqId: string | null; createdAt?: Date },
  ): OpenRemediationFlag;
  resolveRemediationFlag(learnerId: string, id: string): void;
};

type LearnerState = {
  mastery: Map<string, MasteryRecord>;
  topicSpeed: Map<string, TopicSpeedEvidence>;
  events: MasteryEventRecord[];
  cards: Map<string, StoredReviewCard>;
  reviewLogs: ReviewLogEntry[];
  diagnosticRuns: Map<string, DiagnosticRun>;
  placementGrants: Map<string, PlacementGrant>;
  flags: Map<string, RemediationFlag>;
  attempts: Attempt[];
  xpEvents: Map<string, XpEvent>;
  enrollments: Map<string, Enrollment>;
  sessions: Map<string, Session>;
  activities: Map<string, Activity>;
  lessonRuns: Map<string, LessonRun>;
  lessonProblems: Map<string, LessonProblem>;
  lessonQuizAttempts: Map<string, LessonQuizAttempt>;
  lessonQuizItems: Map<string, LessonQuizItem>;
  timedQuizRuns: Map<string, TimedQuizRun>;
  timedQuizItems: Map<string, TimedQuizItem[]>;
};

type Hint = { exerciseId: string; activityId: string | null; createdAt: Date; level: number };
type SeededProjections = Pick<SchedulerFacts, 'lessonRuns' | 'paperProgress'> & {
  projectProgress?: CourseProjectProgress[];
};

type MemorySeed = {
  settings?: ReadonlyMap<string, Settings>;
  hints?: ReadonlyMap<string, readonly Hint[]>;
  schedulerProjections?: ReadonlyMap<string, SeededProjections>;
};

type StoreState = {
  learners: Map<string, LearnerState>;
  settings: Map<string, Settings>;
  hints: Map<string, readonly Hint[]>;
  revisions: Map<string, number>;
  schedulerProjections: Map<string, SeededProjections>;
};

type IdCounters = {
  cardCount: number;
  reviewLogCount: number;
  diagnosticCount: number;
  grantCount: number;
  flagCount: number;
  xpCount: number;
  sessionCount: number;
  activityCount: number;
  lessonRunCount: number;
  lessonProblemCount: number;
  lessonQuizCount: number;
  lessonQuizItemCount: number;
  timedQuizCount: number;
};

const modeOrder: Attempt['mode'][] = ['practice', 'assessment', 'diagnostic', 'review'];

function compareAttempts(order: AttemptQuery['order'], left: Attempt, right: Attempt): number {
  const time = left.createdAt.getTime() - right.createdAt.getTime();
  const ordinal = left.attemptNo - right.attemptNo;
  switch (order) {
    case 'unordered':
      return 0;
    case 'scheduler':
      return (
        -time ||
        compare(left.exerciseId, right.exerciseId) ||
        -ordinal ||
        right.correct - left.correct ||
        modeOrder.indexOf(left.mode) - modeOrder.indexOf(right.mode) ||
        compare(left.id, right.id)
      );
    case 'activity_attempt_no':
      return ordinal;
    case 'review_chronological':
      return time || ordinal;
    case 'final_evidence':
      return -time || -ordinal;
    default:
      return -time;
  }
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareConceptDimension(
  left: { conceptId: string; dimension: Dimension },
  right: { conceptId: string; dimension: Dimension },
): number {
  return compare(left.conceptId, right.conceptId) || compare(left.dimension, right.dimension);
}

function key(conceptId: string, dimension: Dimension): string {
  return JSON.stringify([conceptId, dimension]);
}

export function memoryStore(seed: MemorySeed = {}): MemoryLearnerStore {
  return scopedStore(
    {
      learners: new Map(),
      settings: structuredClone(new Map(seed.settings)),
      hints: structuredClone(new Map(seed.hints)),
      revisions: new Map(),
      schedulerProjections: structuredClone(new Map(seed.schedulerProjections)),
    },
    {
      cardCount: 0,
      reviewLogCount: 0,
      diagnosticCount: 0,
      grantCount: 0,
      flagCount: 0,
      xpCount: 0,
      sessionCount: 0,
      activityCount: 0,
      lessonRunCount: 0,
      lessonProblemCount: 0,
      lessonQuizCount: 0,
      lessonQuizItemCount: 0,
      timedQuizCount: 0,
    },
  );
}

function scopedStore(
  data: StoreState,
  ids: IdCounters,
  assertOpen: () => void = () => {},
): MemoryLearnerStore {
  let pending = Promise.resolve();
  function markWrite(learnerId: string) {
    data.revisions.set(learnerId, (data.revisions.get(learnerId) ?? 0) + 1);
  }
  function stateFor(learnerId: string): LearnerState {
    let state = data.learners.get(learnerId);
    if (!state) {
      state = {
        mastery: new Map(),
        topicSpeed: new Map(),
        events: [],
        cards: new Map(),
        reviewLogs: [],
        diagnosticRuns: new Map(),
        placementGrants: new Map(),
        flags: new Map(),
        attempts: [],
        xpEvents: new Map(),
        enrollments: new Map(),
        sessions: new Map(),
        activities: new Map(),
        lessonRuns: new Map(),
        lessonProblems: new Map(),
        lessonQuizAttempts: new Map(),
        lessonQuizItems: new Map(),
        timedQuizRuns: new Map(),
        timedQuizItems: new Map(),
      };
      data.learners.set(learnerId, state);
    }
    return state;
  }

  function matchingActivities(learnerId: string, query: ActivityQuery) {
    return [...(data.learners.get(learnerId)?.activities.values() ?? [])].filter(
      (row) =>
        (!query.ids || query.ids.includes(row.id)) &&
        (!query.sessionIds || query.sessionIds.includes(row.sessionId)) &&
        (!query.statuses || query.statuses.includes(row.status)) &&
        (query.conceptId === undefined || row.conceptId === query.conceptId),
    );
  }

  function checkTimedQuizRun(learnerId: string, run: TimedQuizRun) {
    const runs = data.learners.get(learnerId)?.timedQuizRuns;
    if (
      run.finalizedAt === null &&
      [...(runs?.values() ?? [])].some((other) => other.id !== run.id && other.finalizedAt === null)
    )
      throw new Error('An active timed quiz already exists.');
    if (run.retakeOf !== null) {
      const allRuns = [...data.learners.values()].flatMap((state) => [
        ...state.timedQuizRuns.values(),
      ]);
      if (!allRuns.some(({ id }) => id === run.retakeOf) && run.id !== run.retakeOf) {
        throw new Error('Original timed quiz not found.');
      }
      if (allRuns.some((other) => other.id !== run.id && other.retakeOf === run.retakeOf)) {
        throw new Error('A retake already exists.');
      }
    }
    checkTimedQuizActivity(run.activityId);
  }

  function checkTimedQuizActivity(activityId: string | null) {
    if (
      activityId !== null &&
      ![...data.learners.values()].some((state) => state.activities.has(activityId))
    )
      throw new Error('Timed quiz activity not found.');
  }

  function matchingFlags(learnerId: string, query: FlagQuery) {
    const state = data.learners.get(learnerId);
    const excluded =
      query.excludeOpenedByActivityId === undefined
        ? undefined
        : new Set(
            [...data.learners.values()].flatMap(({ attempts }) =>
              attempts
                .filter(({ activityId }) => activityId === query.excludeOpenedByActivityId)
                .map(({ id }) => id),
            ),
          );
    return [...(state?.flags.values() ?? [])].filter(
      (flag) =>
        (query.conceptId === undefined || query.conceptId === flag.conceptId) &&
        (query.status === undefined || query.status === flag.status) &&
        (query.targetPrereqIds === undefined ||
          (flag.targetPrereqId !== null && query.targetPrereqIds.includes(flag.targetPrereqId))) &&
        (flag.openedByAttemptId === null || !excluded?.has(flag.openedByAttemptId)),
    );
  }

  function assertAttemptExists(id: string | null | undefined) {
    if (id == null) return;
    if ([...data.learners.values()].some(({ attempts }) => attempts.some((row) => row.id === id)))
      return;
    throw new Error('Attempt not found');
  }

  function assertUniqueProblem(state: LearnerState, row: LessonProblem) {
    if (
      [...state.lessonProblems.values()].some(
        (other) =>
          other.id !== row.id &&
          other.runId === row.runId &&
          other.knowledgePointId === row.knowledgePointId &&
          other.round === row.round &&
          other.position === row.position,
      )
    )
      throw new Error('Lesson problem position already exists');
  }

  function assertUniqueQuiz(state: LearnerState, row: LessonQuizAttempt) {
    if (row.score !== null && !(row.score >= 0 && row.score <= 1)) {
      throw new Error('Lesson quiz score is out of range');
    }
    if (
      [...state.lessonQuizAttempts.values()].some(
        (other) =>
          other.id !== row.id && other.runId === row.runId && other.attemptNo === row.attemptNo,
      )
    )
      throw new Error('Lesson quiz attempt already exists');
  }

  function applyPatch<T extends object>(row: T, patch: Partial<NoInfer<T>>): T {
    return structuredClone({
      ...row,
      ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)),
    });
  }

  return {
    async transaction(fn) {
      assertOpen();
      const run = async () => {
        assertOpen();
        const original = new Map(data.revisions);
        const snapshot = structuredClone(data);
        let open = true;
        const tx = scopedStore(snapshot, ids, () => {
          if (!open) throw new Error('This memory store transaction is closed.');
          assertOpen();
        });
        const result = await (async () => {
          try {
            return await fn(tx as typeof this);
          } finally {
            open = false;
          }
        })();
        assertOpen();
        const changed = new Set<string>();
        for (const [learnerId, revision] of snapshot.revisions) {
          if (revision === original.get(learnerId)) continue;
          if (data.revisions.get(learnerId) !== original.get(learnerId)) {
            throw new Error('Learner state changed outside this transaction.');
          }
          changed.add(learnerId);
        }
        if (changed.size) {
          const attemptIds = new Set<string>();
          for (const [learnerId, state] of data.learners) {
            if (changed.has(learnerId)) continue;
            for (const attempt of state.attempts) attemptIds.add(attempt.id);
          }
          for (const learnerId of changed) {
            if (snapshot.learners.get(learnerId)?.attempts.some(({ id }) => attemptIds.has(id))) {
              throw new Error('An attempt already exists with this ID.');
            }
          }
        }
        for (const learnerId of changed) {
          const state = snapshot.learners.get(learnerId);
          if (state) data.learners.set(learnerId, state);
          const settings = snapshot.settings.get(learnerId);
          if (settings) data.settings.set(learnerId, settings);
          const hints = snapshot.hints.get(learnerId);
          if (hints) data.hints.set(learnerId, hints);
          data.revisions.set(learnerId, snapshot.revisions.get(learnerId) ?? 0);
        }
        return result;
      };
      const result = pending.then(run);
      pending = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
    async lockLearner(learnerId) {
      assertOpen();
      data.settings.get(learnerId);
    },
    async listAttempts(learnerId, query) {
      assertOpen();
      const rows = (data.learners.get(learnerId)?.attempts ?? []).filter(
        (row) =>
          (!query.ids || query.ids.includes(row.id)) &&
          (!query.activityIds ||
            (row.activityId !== null && query.activityIds.includes(row.activityId))) &&
          (!query.exerciseIds || query.exerciseIds.includes(row.exerciseId)) &&
          (query.conceptId === undefined || row.conceptId === query.conceptId) &&
          (!query.since || row.createdAt >= query.since) &&
          (!query.through || row.createdAt <= query.through),
      );
      rows.sort((left, right) => compareAttempts(query.order, left, right));
      return structuredClone(query.limit === undefined ? rows : rows.slice(0, query.limit));
    },
    async listActivityAttemptKeys(learnerId, activityIds) {
      assertOpen();
      if (!activityIds.length) return [];
      const ids = new Set(activityIds);
      return (data.learners.get(learnerId)?.attempts ?? [])
        .filter(({ activityId }) => activityId !== null && ids.has(activityId))
        .map(({ activityId, exerciseId }) => ({ activityId, exerciseId }));
    },
    async insertAttempt(learnerId, attempt) {
      assertOpen();
      if (
        [...data.learners.values()].some(({ attempts }) =>
          attempts.some(({ id }) => id === attempt.id),
        )
      ) {
        throw new Error('An attempt already exists with this ID.');
      }
      stateFor(learnerId).attempts.push(structuredClone(attempt));
      markWrite(learnerId);
      return structuredClone(attempt);
    },
    async readHintEvidence(learnerId, exerciseId, activityId) {
      assertOpen();
      const inScope = (row: { exerciseId: string; activityId: string | null }) =>
        row.exerciseId === exerciseId &&
        (activityId === undefined || row.activityId === activityId);
      return structuredClone({
        attempts: (data.learners.get(learnerId)?.attempts ?? [])
          .filter(inScope)
          .map(({ activityId, createdAt }) => ({ activityId, createdAt })),
        hints: (data.hints.get(learnerId) ?? [])
          .filter(inScope)
          .map(({ activityId, createdAt, level }) => ({ activityId, createdAt, level })),
      });
    },
    async listXpEvents(learnerId, query) {
      assertOpen();
      return structuredClone(
        [...(data.learners.get(learnerId)?.xpEvents.values() ?? [])].filter(
          (row) =>
            (query.localDate === undefined || row.localDate === query.localDate) &&
            (!query.through || row.earnedAt <= query.through) &&
            (query.sourcePrefix === undefined || row.sourceKey.startsWith(query.sourcePrefix)) &&
            (query.sourceKey === undefined || row.sourceKey === query.sourceKey),
        ),
      );
    },
    async sumQuizEligibleXp(learnerId, through, lastQuizAt) {
      assertOpen();
      const state = data.learners.get(learnerId);
      const result = { throughLastQuiz: 0, sinceLastQuiz: 0 };
      const prefix = 'activity:';
      for (const event of state?.xpEvents.values() ?? []) {
        if (event.earnedAt > through) continue;
        const activity =
          event.kind === 'activity' && event.sourceKey.startsWith(prefix)
            ? state?.activities.get(event.sourceKey.slice(prefix.length))
            : undefined;
        if (
          event.kind === 'knowledge_point' ||
          event.kind === 'review' ||
          ((activity?.kind === 'learn' || activity?.kind === 'review') &&
            state?.sessions.has(activity.sessionId))
        ) {
          result[
            lastQuizAt && event.earnedAt <= lastQuizAt ? 'throughLastQuiz' : 'sinceLastQuiz'
          ] += event.amount;
        }
      }
      return result;
    },
    async insertXpEventOnce(learnerId, event) {
      assertOpen();
      const { xpEvents } = stateFor(learnerId);
      if (xpEvents.has(event.sourceKey)) return false;
      const id = `00000000-0000-4000-8000-${(++ids.xpCount).toString(16).padStart(12, '0')}`;
      xpEvents.set(event.sourceKey, structuredClone({ ...event, id }));
      markWrite(learnerId);
      return true;
    },
    async getSettings(learnerId) {
      assertOpen();
      return structuredClone(data.settings.get(learnerId));
    },
    async patchSettings(learnerId, patch) {
      assertOpen();
      const settings = data.settings.get(learnerId);
      if (settings) {
        const updated = { ...settings };
        let changed = false;
        for (const key of Object.keys(settings) as (keyof Settings)[]) {
          if (patch[key] !== undefined) {
            Object.assign(updated, { [key]: structuredClone(patch[key]) });
            changed = true;
          }
        }
        if (changed) {
          markWrite(learnerId);
          data.settings.set(learnerId, updated);
        }
      }
    },
    async listEnrollments(learnerId) {
      assertOpen();
      return structuredClone([...(data.learners.get(learnerId)?.enrollments.values() ?? [])]);
    },
    async writeEnrollments(learnerId, change) {
      assertOpen();
      const { enrollments } = stateFor(learnerId);
      switch (change.kind) {
        case 'insert_missing':
          for (const row of change.rows) {
            if (enrollments.has(row.courseId)) continue;
            enrollments.set(row.courseId, structuredClone(row));
            markWrite(learnerId);
          }
          break;
        case 'start': {
          const current = enrollments.get(change.row.courseId);
          if (current) current.status = 'active';
          else enrollments.set(change.row.courseId, structuredClone(change.row));
          markWrite(learnerId);
          break;
        }
        case 'complete':
          if (new Set(change.courseIds).size !== change.courseIds.length) {
            throw new Error('A course cannot be completed twice in one write.');
          }
          for (const courseId of change.courseIds) {
            const current = enrollments.get(courseId);
            if (current) {
              current.status = 'completed';
              current.completedAt = structuredClone(change.now);
            } else {
              enrollments.set(
                courseId,
                structuredClone({
                  courseId,
                  status: 'completed',
                  startMethod: 'beginning',
                  startedAt: change.now,
                  completedAt: change.now,
                }),
              );
            }
            markWrite(learnerId);
          }
          break;
        case 'set_status':
          for (const courseId of change.courseIds) {
            const current = enrollments.get(courseId);
            if (current && (change.ifStatus === undefined || current.status === change.ifStatus)) {
              current.status = change.status;
              current.completedAt = structuredClone(change.completedAt);
              markWrite(learnerId);
            }
          }
          break;
      }
    },
    async listMastery(learnerId) {
      assertOpen();
      const records = [...(data.learners.get(learnerId)?.mastery.values() ?? [])];
      return structuredClone(records.sort(compareConceptDimension));
    },
    async getMastery(learnerId, conceptId, dimension) {
      assertOpen();
      return structuredClone(data.learners.get(learnerId)?.mastery.get(key(conceptId, dimension)));
    },
    async saveMastery(learnerId, record) {
      assertOpen();
      stateFor(learnerId).mastery.set(
        key(record.conceptId, record.dimension),
        structuredClone(record),
      );
      markWrite(learnerId);
    },
    async addMasteryEvent(learnerId, event) {
      assertOpen();
      stateFor(learnerId).events.push(structuredClone(event));
      markWrite(learnerId);
    },
    async listTopicSpeedEvidence(learnerId, conceptIds) {
      assertOpen();
      const concepts = conceptIds && new Set(conceptIds);
      const records = [...(data.learners.get(learnerId)?.topicSpeed.values() ?? [])]
        .filter((record) => !concepts || concepts.has(record.conceptId))
        .sort((left, right) => compare(left.conceptId, right.conceptId));
      return structuredClone(records);
    },
    async saveTopicSpeedEvidence(learnerId, record) {
      assertOpen();
      stateFor(learnerId).topicSpeed.set(record.conceptId, structuredClone(record));
      markWrite(learnerId);
    },
    async addTopicSpeedAnswer(learnerId, conceptId, correct, now) {
      assertOpen();
      const records = stateFor(learnerId).topicSpeed;
      const previous = records.get(conceptId);
      records.set(conceptId, {
        conceptId,
        successes: Math.fround((previous?.successes ?? 0) * TOPIC_SPEED_DECAY + Number(correct)),
        trials: Math.fround((previous?.trials ?? 0) * TOPIC_SPEED_DECAY + 1),
        answers: (previous?.answers ?? 0) + 1,
        updatedAt: new Date(now),
        policyVersion: TOPIC_SPEED_POLICY,
      });
      markWrite(learnerId);
    },
    async listReviewCards(learnerId, conceptIds, options) {
      assertOpen();
      const concepts = conceptIds && new Set(conceptIds);
      const cards = [...(data.learners.get(learnerId)?.cards.values() ?? [])].filter(
        (card) =>
          (!concepts || concepts.has(card.conceptId)) &&
          (!options?.activeOnly || card.suspendedAt === null),
      );
      return structuredClone(
        cards.sort(
          (left, right) => compareConceptDimension(left, right) || compare(left.id, right.id),
        ),
      );
    },
    async getReviewCard(learnerId, conceptId, dimension) {
      assertOpen();
      return structuredClone(data.learners.get(learnerId)?.cards.get(key(conceptId, dimension)));
    },
    async insertReviewCard(learnerId, card) {
      assertOpen();
      const { cards } = stateFor(learnerId);
      const cardKey = key(card.conceptId, card.dimension);
      if (cards.has(cardKey)) {
        throw new Error('A review card already exists for this learner, concept and dimension.');
      }
      const stored = structuredClone({
        ...card,
        id: `card-${++ids.cardCount}`,
        suspendedAt: null,
      });
      cards.set(cardKey, stored);
      markWrite(learnerId);
      return structuredClone(stored);
    },
    async recordReview(learnerId, conceptId, dimension, compute) {
      assertOpen();
      const { cards } = stateFor(learnerId);
      const cardKey = key(conceptId, dimension);
      const current = cards.get(cardKey);
      if (current?.suspendedAt) return false;
      const { card, log } = compute(structuredClone(current));
      assertAttemptExists(log.attemptId);
      const id = current?.id ?? `card-${++ids.cardCount}`;
      cards.set(cardKey, structuredClone({ ...card, conceptId, dimension, id, suspendedAt: null }));
      await this.appendReviewLog(learnerId, id, log);
      return true;
    },
    async updateReviewCardIfDue(learnerId, cardId, expectedDueAt, next, options) {
      assertOpen();
      const card = [...(data.learners.get(learnerId)?.cards.values() ?? [])].find(
        ({ id }) => id === cardId,
      );
      if (
        !card ||
        (options?.activeOnly && card.suspendedAt !== null) ||
        card.dueAt.getTime() !== expectedDueAt.getTime()
      )
        return false;
      markWrite(learnerId);
      card.fsrs = structuredClone(next.fsrs);
      card.dueAt = structuredClone(next.dueAt);
      return true;
    },
    async listTimedQuizRuns(
      learnerId,
      { id, activityId, activityIds, retakeOf, active, original, finalizedThrough },
    ) {
      assertOpen();
      const rows = [...(data.learners.get(learnerId)?.timedQuizRuns.values() ?? [])].filter(
        (run) =>
          (id === undefined || run.id === id) &&
          (activityId === undefined || run.activityId === activityId) &&
          (activityIds === undefined ||
            (run.activityId !== null && activityIds.includes(run.activityId))) &&
          (retakeOf === undefined || run.retakeOf === retakeOf) &&
          (!active || run.finalizedAt === null) &&
          (!original || run.retakeOf === null) &&
          (finalizedThrough === undefined ||
            (run.finalizedAt !== null && run.finalizedAt <= finalizedThrough)),
      );
      if (original) {
        rows.sort(
          (left, right) =>
            (left.finalizedAt?.getTime() ?? Infinity) -
              (right.finalizedAt?.getTime() ?? Infinity) ||
            left.startedAt.getTime() - right.startedAt.getTime() ||
            left.seed - right.seed,
        );
      }
      return structuredClone(rows);
    },
    async listTimedQuizItems(learnerId, runIds) {
      assertOpen();
      const items = data.learners.get(learnerId)?.timedQuizItems;
      return structuredClone(
        [...new Set(runIds)]
          .flatMap((runId) => items?.get(runId) ?? [])
          .sort((left, right) => left.position - right.position),
      );
    },
    async listTimedQuizItemKeys(learnerId, runIds) {
      assertOpen();
      const items = data.learners.get(learnerId)?.timedQuizItems;
      return collectTimedQuizItemKeys(
        [...new Set(runIds)].flatMap((runId) =>
          (items?.get(runId) ?? []).map(({ conceptId, position, question, reserve, correct }) => ({
            runId,
            conceptId,
            position,
            questionKey: question.key,
            reserveKey: reserve?.key ?? null,
            correct,
          })),
        ),
      );
    },
    async insertTimedQuiz(learnerId, run, items) {
      assertOpen();
      const row = structuredClone({ ...run, id: `timed-quiz-${++ids.timedQuizCount}` });
      checkTimedQuizRun(learnerId, row);
      if (new Set(items.map(({ position }) => position)).size !== items.length) {
        throw new Error('A timed quiz item already exists at this position.');
      }
      for (const item of items) checkTimedQuizActivity(item.followUpActivityId);
      const state = stateFor(learnerId);
      state.timedQuizRuns.set(row.id, row);
      state.timedQuizItems.set(
        row.id,
        structuredClone(items.map((item) => ({ ...item, runId: row.id }))),
      );
      markWrite(learnerId);
      return structuredClone(row);
    },
    async patchTimedQuizRun(learnerId, runId, patch) {
      assertOpen();
      const runs = data.learners.get(learnerId)?.timedQuizRuns;
      const current = runs?.get(runId);
      if (!runs || !current) throw new Error('Timed quiz run not found.');
      const next = applyPatch(current, patch);
      checkTimedQuizRun(learnerId, next);
      runs.set(runId, next);
      markWrite(learnerId);
      return structuredClone(next);
    },
    async patchTimedQuizItem(learnerId, runId, position, patch) {
      assertOpen();
      const items = data.learners.get(learnerId)?.timedQuizItems.get(runId);
      const index = items?.findIndex((item) => item.position === position) ?? -1;
      if (!items || index < 0) return;
      const next = applyPatch(items[index], patch);
      checkTimedQuizActivity(next.followUpActivityId);
      items[index] = next;
      markWrite(learnerId);
    },
    async linkTimedQuizFollowUps(learnerId, conceptIds, activityId) {
      assertOpen();
      const state = data.learners.get(learnerId);
      if (!state) return;
      const pending = [...state.timedQuizRuns.values()]
        .filter((run) => run.finalizedAt !== null)
        .flatMap((run) => state.timedQuizItems.get(run.id) ?? [])
        .filter(
          (item) =>
            item.followUp &&
            item.followUpActivityId === null &&
            conceptIds.includes(item.conceptId),
        );
      if (!pending.length) return;
      checkTimedQuizActivity(activityId);
      for (const item of pending) item.followUpActivityId = activityId;
      markWrite(learnerId);
    },
    async listDiagnosticRuns(learnerId, { id, courseId, status }) {
      assertOpen();
      return structuredClone(
        [...(data.learners.get(learnerId)?.diagnosticRuns.values() ?? [])]
          .filter(
            (run) =>
              (id === undefined || run.id === id) &&
              (courseId === undefined || run.courseId === courseId) &&
              (status === undefined || run.status === status),
          )
          .sort((left, right) => right.startedAt.getTime() - left.startedAt.getTime()),
      );
    },
    async insertDiagnosticRun(learnerId, run) {
      assertOpen();
      const courseId = (run.state as { courseId?: unknown } | null)?.courseId;
      const row = structuredClone({
        ...run,
        id: `diagnostic-${++ids.diagnosticCount}`,
        courseId: typeof courseId === 'string' ? courseId : null,
      });
      stateFor(learnerId).diagnosticRuns.set(row.id, row);
      markWrite(learnerId);
      return structuredClone(row);
    },
    async patchDiagnosticRun(learnerId, runId, patch) {
      assertOpen();
      const runs = data.learners.get(learnerId)?.diagnosticRuns;
      const current = runs?.get(runId);
      if (!runs || !current) return;
      const next = applyPatch(current, patch);
      const courseId = (next.state as { courseId?: unknown } | null)?.courseId;
      runs.set(runId, { ...next, courseId: typeof courseId === 'string' ? courseId : null });
      markWrite(learnerId);
    },
    async listPlacementGrants(learnerId, query = {}) {
      assertOpen();
      return structuredClone(
        [...(data.learners.get(learnerId)?.placementGrants.values() ?? [])].filter(
          (row) =>
            (query.conceptIds === undefined || query.conceptIds.includes(row.conceptId)) &&
            (query.state === undefined || query.state === row.state) &&
            !query.excludeReasons?.includes(row.reason),
        ),
      );
    },
    async insertPlacementGrantsOnce(learnerId, grants) {
      assertOpen();
      if (grants.length === 0) return;
      const { placementGrants } = stateFor(learnerId);
      const existing = new Set(
        [...placementGrants.values()].map(({ runId, conceptId }) =>
          JSON.stringify([runId, conceptId]),
        ),
      );
      const inserts = grants.filter(({ runId, conceptId }) => {
        const grantKey = JSON.stringify([runId, conceptId]);
        if (existing.has(grantKey)) return false;
        existing.add(grantKey);
        return true;
      });
      for (const row of inserts) {
        if (
          ![...data.learners.values()].some(({ diagnosticRuns }) => diagnosticRuns.has(row.runId))
        ) {
          throw new Error('Diagnostic run not found');
        }
        assertAttemptExists(row.confirmedByAttemptId);
        assertAttemptExists(row.withdrawnByAttemptId);
      }
      for (const row of inserts) {
        const id = `grant-${++ids.grantCount}`;
        placementGrants.set(id, structuredClone({ ...row, id }));
        markWrite(learnerId);
      }
    },
    async patchPlacementGrants(learnerId, { ids, conceptId, ifState }, patch) {
      assertOpen();
      const grants = data.learners.get(learnerId)?.placementGrants;
      if (!grants) return;
      for (const [id, row] of grants) {
        if (
          (ids !== undefined && !ids.includes(id)) ||
          (conceptId !== undefined && conceptId !== row.conceptId) ||
          (ifState !== undefined && ifState !== row.state)
        )
          continue;
        assertAttemptExists(patch.confirmedByAttemptId);
        assertAttemptExists(patch.withdrawnByAttemptId);
        grants.set(id, applyPatch(row, patch));
        markWrite(learnerId);
      }
    },
    async setReviewCardSuspension(learnerId, conceptIds, suspendedAt) {
      assertOpen();
      for (const card of data.learners.get(learnerId)?.cards.values() ?? []) {
        if (!conceptIds.includes(card.conceptId) || (suspendedAt && card.suspendedAt)) continue;
        card.suspendedAt = structuredClone(suspendedAt);
        markWrite(learnerId);
      }
    },
    async listReviewLogs(learnerId, { cardIds, activityId, since, limit }) {
      assertOpen();
      const linkedAttempts =
        activityId === undefined
          ? undefined
          : new Set(
              [...data.learners.values()].flatMap(({ attempts }) =>
                attempts.filter((attempt) => attempt.activityId === activityId).map(({ id }) => id),
              ),
            );
      return structuredClone(
        (data.learners.get(learnerId)?.reviewLogs ?? [])
          .filter(
            (log) =>
              (cardIds === undefined || cardIds.includes(log.cardId)) &&
              (linkedAttempts === undefined ||
                (log.attemptId && linkedAttempts.has(log.attemptId))) &&
              (since === undefined || log.createdAt >= since),
          )
          .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
          .slice(0, limit),
      );
    },
    async patchReviewCard(learnerId, cardId, patch) {
      assertOpen();
      const cards = data.learners.get(learnerId)?.cards;
      if (!cards) return;
      for (const [cardKey, card] of cards) {
        if (card.id !== cardId) continue;
        cards.set(cardKey, applyPatch(card, patch));
        markWrite(learnerId);
        break;
      }
    },
    async appendReviewLog(learnerId, cardId, log) {
      assertOpen();
      const state = data.learners.get(learnerId);
      const card = [...(state?.cards.values() ?? [])].find(({ id }) => id === cardId);
      if (!state || !card) throw new Error('Review card not found');
      assertAttemptExists(log.attemptId);
      state.reviewLogs.push(
        structuredClone({
          ...log,
          id: `review-log-${++ids.reviewLogCount}`,
          cardId,
          conceptId: card.conceptId,
          attemptId: log.attemptId ?? null,
          speed: log.speed === undefined ? undefined : Math.fround(log.speed),
        }),
      );
      markWrite(learnerId);
    },
    async listSessions(learnerId, query) {
      assertOpen();
      return structuredClone(
        [...(data.learners.get(learnerId)?.sessions.values() ?? [])]
          .filter(
            (row) =>
              (!query.ids || query.ids.includes(row.id)) &&
              (query.status === undefined || row.status === query.status),
          )
          .sort(
            (left, right) =>
              (right.startedAt?.getTime() ?? Infinity) - (left.startedAt?.getTime() ?? Infinity),
          ),
      );
    },
    async lockSession(learnerId, sessionId) {
      assertOpen();
      return structuredClone(data.learners.get(learnerId)?.sessions.get(sessionId));
    },
    async insertSession(learnerId, session) {
      assertOpen();
      const row = structuredClone({ ...session, id: `session-${++ids.sessionCount}` });
      stateFor(learnerId).sessions.set(row.id, row);
      markWrite(learnerId);
      return structuredClone(row);
    },
    async patchSessions(learnerId, query, patch) {
      assertOpen();
      const edit = Object.fromEntries(
        Object.entries(patch).filter(([, value]) => value !== undefined),
      );
      if (!Object.keys(edit).length) return;
      for (const row of data.learners.get(learnerId)?.sessions.values() ?? []) {
        if (
          (!query.ids || query.ids.includes(row.id)) &&
          (query.status === undefined || row.status === query.status)
        ) {
          Object.assign(row, structuredClone(edit));
          markWrite(learnerId);
        }
      }
    },
    async listActivities(learnerId, query) {
      assertOpen();
      return structuredClone(
        matchingActivities(learnerId, query).sort(
          (left, right) => compare(left.sessionId, right.sessionId) || left.idx - right.idx,
        ),
      );
    },
    async insertActivities(learnerId, sessionId, rows) {
      assertOpen();
      if (!rows.length) return [];
      const state = data.learners.get(learnerId);
      if (!state?.sessions.has(sessionId)) throw new Error('Session not found.');
      const indices = new Set(
        matchingActivities(learnerId, { sessionIds: [sessionId] }).map(({ idx }) => idx),
      );
      for (const { idx } of rows) {
        if (indices.has(idx)) throw new Error('An activity already exists at this session index.');
        indices.add(idx);
      }
      const stored = rows.map((row) =>
        structuredClone({
          ...row,
          sessionId,
          id: `activity-${++ids.activityCount}`,
        }),
      );
      for (const row of stored) state.activities.set(row.id, row);
      markWrite(learnerId);
      return structuredClone(stored);
    },
    async patchActivities(learnerId, query, patch, expected) {
      assertOpen();
      const edit = Object.fromEntries(
        Object.entries(patch).filter(([, value]) => value !== undefined),
      );
      if (!Object.keys(edit).length) return [];
      const rows = matchingActivities(learnerId, query).filter(
        (row) =>
          (!expected?.statuses || expected.statuses.includes(row.status)) &&
          (!expected?.exerciseIds ||
            (expected.exerciseIds.length === row.exerciseIds.length &&
              expected.exerciseIds.every((id, i) => id === row.exerciseIds[i]))),
      );
      if (patch.idx !== undefined) {
        const seen = new Set<string>();
        for (const row of data.learners.get(learnerId)?.activities.values() ?? []) {
          const index = JSON.stringify([row.sessionId, rows.includes(row) ? patch.idx : row.idx]);
          if (seen.has(index)) throw new Error('An activity already exists at this session index.');
          seen.add(index);
        }
      }
      for (const row of rows) Object.assign(row, structuredClone(edit));
      if (rows.length) markWrite(learnerId);
      return structuredClone(rows);
    },
    async deleteActivities(learnerId, query) {
      assertOpen();
      const deleted = new Set(matchingActivities(learnerId, query).map(({ id }) => id));
      if (!deleted.size) return;
      const state = stateFor(learnerId);
      for (const id of deleted) state.activities.delete(id);
      markWrite(learnerId);
      for (const [owner, learner] of data.learners) {
        for (const run of learner.timedQuizRuns.values()) {
          if (run.activityId === null || !deleted.has(run.activityId)) continue;
          run.activityId = null;
          markWrite(owner);
        }
        for (const items of learner.timedQuizItems.values()) {
          for (const item of items) {
            if (item.followUpActivityId === null || !deleted.has(item.followUpActivityId)) continue;
            item.followUpActivityId = null;
            markWrite(owner);
          }
        }
        for (const attempt of learner.attempts) {
          if (attempt.activityId === null || !deleted.has(attempt.activityId)) continue;
          attempt.activityId = null;
          markWrite(owner);
        }
      }
      const linksToDeletedActivity = ({ activityId }: Hint) =>
        activityId !== null && deleted.has(activityId);
      for (const [owner, hints] of data.hints) {
        if (!hints.some(linksToDeletedActivity)) continue;
        data.hints.set(
          owner,
          hints.map((hint) =>
            linksToDeletedActivity(hint) ? { ...hint, activityId: null } : hint,
          ),
        );
        markWrite(owner);
      }
    },
    async listLessonRuns(learnerId) {
      assertOpen();
      return structuredClone([...(data.learners.get(learnerId)?.lessonRuns.values() ?? [])]);
    },
    async getLessonRun(learnerId, key) {
      assertOpen();
      const state = data.learners.get(learnerId);
      if (!state) return;
      const run =
        'runId' in key
          ? state.lessonRuns.get(key.runId)
          : [...state.lessonRuns.values()].find(({ conceptId }) => conceptId === key.conceptId);
      if (run && 'conceptId' in key && key.quizItemId !== undefined) {
        const item = state.lessonQuizItems.get(key.quizItemId);
        if (!item || state.lessonQuizAttempts.get(item.quizAttemptId)?.runId !== run.id) return;
      }
      return structuredClone(run);
    },
    async lockLessonProblem(learnerId, conceptId, problemId) {
      assertOpen();
      const state = data.learners.get(learnerId);
      const problem = state?.lessonProblems.get(problemId);
      const run = problem && state?.lessonRuns.get(problem.runId);
      if (!run || !problem || run.conceptId !== conceptId) return;
      return structuredClone({ run, problem });
    },
    async insertLessonRunIfAbsent(learnerId, input) {
      assertOpen();
      const state = stateFor(learnerId);
      if ([...state.lessonRuns.values()].some(({ conceptId }) => input.conceptId === conceptId))
        return;
      const row = structuredClone({ ...input, id: `lesson-run-${++ids.lessonRunCount}` });
      state.lessonRuns.set(row.id, row);
      markWrite(learnerId);
      return structuredClone(row);
    },
    async patchLessonRun(learnerId, runId, patch) {
      assertOpen();
      const state = stateFor(learnerId);
      const row = state.lessonRuns.get(runId);
      if (!row) throw new Error('Lesson run not found');
      const next = applyPatch(row, patch);
      state.lessonRuns.set(runId, next);
      markWrite(learnerId);
      return structuredClone(next);
    },
    async listLessonProblems(learnerId, runId) {
      assertOpen();
      return structuredClone(
        [...(data.learners.get(learnerId)?.lessonProblems.values() ?? [])]
          .filter((row) => row.runId === runId)
          .sort(
            (left, right) =>
              left.servedAt.getTime() - right.servedAt.getTime() ||
              left.position - right.position ||
              compare(left.id, right.id),
          ),
      );
    },
    async insertLessonProblem(learnerId, runId, problem) {
      assertOpen();
      const state = stateFor(learnerId);
      if (!state.lessonRuns.has(runId)) throw new Error('Lesson run not found');
      assertAttemptExists(problem.attemptId);
      const row = structuredClone({
        ...problem,
        runId,
        id: `lesson-problem-${++ids.lessonProblemCount}`,
      });
      assertUniqueProblem(state, row);
      state.lessonProblems.set(row.id, row);
      markWrite(learnerId);
      return structuredClone(row);
    },
    async patchLessonProblem(learnerId, runId, problemId, patch) {
      assertOpen();
      const state = data.learners.get(learnerId);
      const row = state?.lessonProblems.get(problemId);
      if (!state || !row || row.runId !== runId) return;
      const next = applyPatch(row, patch);
      assertAttemptExists(next.attemptId);
      assertUniqueProblem(state, next);
      state.lessonProblems.set(problemId, next);
      markWrite(learnerId);
    },
    async deleteLessonProblems(learnerId, runId, problemIds) {
      assertOpen();
      const state = data.learners.get(learnerId);
      for (const id of problemIds) {
        if (state?.lessonProblems.get(id)?.runId !== runId) continue;
        state.lessonProblems.delete(id);
        markWrite(learnerId);
      }
    },
    async readLessonQuiz(learnerId, runId) {
      assertOpen();
      const state = data.learners.get(learnerId);
      const quizAttempts = [...(state?.lessonQuizAttempts.values() ?? [])]
        .filter((row) => row.runId === runId)
        .sort((left, right) => left.attemptNo - right.attemptNo);
      const items = [...(state?.lessonQuizItems.values() ?? [])];
      const quizItems = quizAttempts.flatMap(({ id }) =>
        items
          .filter((row) => row.quizAttemptId === id)
          .sort((left, right) => left.position - right.position || compare(left.id, right.id)),
      );
      return structuredClone({ quizAttempts, quizItems });
    },
    async insertLessonQuiz(learnerId, runId, attempt, items) {
      assertOpen();
      const state = stateFor(learnerId);
      if (!state.lessonRuns.has(runId)) throw new Error('Lesson run not found');
      const row = structuredClone({
        ...attempt,
        runId,
        id: `lesson-quiz-${++ids.lessonQuizCount}`,
      });
      assertUniqueQuiz(state, row);
      state.lessonQuizAttempts.set(row.id, row);
      markWrite(learnerId);
      if (new Set(items.map(({ position }) => position)).size !== items.length) {
        throw new Error('Lesson quiz item position already exists');
      }
      const inserted = items.map((item) => {
        assertAttemptExists(item.attemptId);
        const id = `lesson-quiz-item-${++ids.lessonQuizItemCount}`;
        if ([...data.learners.values()].some(({ lessonQuizItems }) => lessonQuizItems.has(id))) {
          throw new Error('Lesson quiz item ID already exists');
        }
        return structuredClone({ ...item, quizAttemptId: row.id, id });
      });
      for (const item of inserted) state.lessonQuizItems.set(item.id, item);
      return structuredClone(row);
    },
    async patchLessonQuizAttempt(learnerId, runId, attemptId, patch) {
      assertOpen();
      const state = data.learners.get(learnerId);
      const row = state?.lessonQuizAttempts.get(attemptId);
      if (!state || !row || row.runId !== runId) return;
      const next = applyPatch(row, patch);
      assertUniqueQuiz(state, next);
      state.lessonQuizAttempts.set(attemptId, next);
      markWrite(learnerId);
    },
    async patchLessonQuizItem(learnerId, runId, itemId, { replacementId, ...patch }, expected) {
      assertOpen();
      const state = data.learners.get(learnerId);
      const row = state?.lessonQuizItems.get(itemId);
      if (!state || !row || state.lessonQuizAttempts.get(row.quizAttemptId)?.runId !== runId)
        return;
      if (expected?.unanswered && row.answeredAt !== null) return;
      if (
        replacementId &&
        replacementId !== itemId &&
        [...data.learners.values()].some(({ lessonQuizItems }) =>
          lessonQuizItems.has(replacementId),
        )
      ) {
        throw new Error('Lesson quiz item ID already exists');
      }
      const next = applyPatch(row, { ...patch, id: replacementId ?? itemId });
      assertAttemptExists(next.attemptId);
      if (
        [...state.lessonQuizItems.values()].some(
          (other) =>
            other.id !== itemId &&
            other.quizAttemptId === next.quizAttemptId &&
            other.position === next.position,
        )
      )
        throw new Error('Lesson quiz item position already exists');
      state.lessonQuizItems.delete(itemId);
      state.lessonQuizItems.set(next.id, next);
      markWrite(learnerId);
      return structuredClone(next);
    },
    async deleteLessonQuizRows(learnerId, runId, { itemIds, attemptIds }) {
      assertOpen();
      const state = data.learners.get(learnerId);
      if (!state) return;
      for (const [id, item] of state.lessonQuizItems) {
        if (state.lessonQuizAttempts.get(item.quizAttemptId)?.runId !== runId) continue;
        if (itemIds?.includes(id) || attemptIds?.includes(item.quizAttemptId)) {
          state.lessonQuizItems.delete(id);
          markWrite(learnerId);
        }
      }
      for (const id of attemptIds ?? []) {
        if (state.lessonQuizAttempts.get(id)?.runId !== runId) continue;
        state.lessonQuizAttempts.delete(id);
        markWrite(learnerId);
      }
    },
    async listRemediationFlags(learnerId, query) {
      assertOpen();
      return structuredClone(matchingFlags(learnerId, query));
    },
    async insertRemediationFlags(learnerId, flags) {
      assertOpen();
      if (!flags.length) return;
      const state = stateFor(learnerId);
      const rows = flags.map((flag) => {
        assertAttemptExists(flag.openedByAttemptId);
        return structuredClone({ ...flag, id: `flag-${++ids.flagCount}` });
      });
      for (const row of rows) state.flags.set(row.id, row);
      markWrite(learnerId);
    },
    async resolveRemediationFlags(learnerId, query, now) {
      assertOpen();
      if (query.status === 'resolved') return;
      for (const flag of matchingFlags(learnerId, { ...query, status: 'open' })) {
        flag.status = 'resolved';
        flag.resolvedAt = new Date(now);
        markWrite(learnerId);
      }
    },
    async clearTopicProgress(learnerId, conceptId) {
      assertOpen();
      const state = data.learners.get(learnerId);
      if (!state) return;
      state.events = state.events.filter((event) => event.conceptId !== conceptId);
      for (const [id, mastery] of state.mastery) {
        if (mastery.conceptId === conceptId) state.mastery.delete(id);
      }
      const cardIds = new Set<string>();
      for (const [id, card] of state.cards) {
        if (card.conceptId !== conceptId) continue;
        cardIds.add(card.id);
        state.cards.delete(id);
      }
      state.reviewLogs = state.reviewLogs.filter(({ cardId }) => !cardIds.has(cardId));
      for (const [id, run] of state.lessonRuns) {
        if (run.conceptId !== conceptId) continue;
        for (const [problemId, problem] of state.lessonProblems) {
          if (problem.runId === id) state.lessonProblems.delete(problemId);
        }
        const attemptIds = [...state.lessonQuizAttempts.values()]
          .filter(({ runId }) => runId === id)
          .map(({ id }) => id);
        await this.deleteLessonQuizRows(learnerId, id, { attemptIds });
        state.lessonRuns.delete(id);
      }
      for (const [id, flag] of state.flags) {
        if (flag.conceptId === conceptId || flag.targetPrereqId === conceptId)
          state.flags.delete(id);
      }
      markWrite(learnerId);
    },
    async listProjectProgress(learnerId) {
      assertOpen();
      return structuredClone(
        [...(data.schedulerProjections.get(learnerId)?.projectProgress ?? [])].sort((a, b) =>
          compare(a.projectId, b.projectId),
        ),
      );
    },
    async listPaperProgress(learnerId) {
      assertOpen();
      return structuredClone(
        [...(data.schedulerProjections.get(learnerId)?.paperProgress ?? [])].sort((a, b) =>
          compare(a.paperId, b.paperId),
        ),
      );
    },
    async listCompletedActivities(learnerId, since) {
      assertOpen();
      const sessions = data.learners.get(learnerId)?.sessions;
      return structuredClone(
        matchingActivities(learnerId, { statuses: ['completed'] })
          .filter(({ completedAt }) => completedAt !== null && completedAt >= since)
          .map((activity) => ({
            activity,
            sessionStartedAt: sessions?.get(activity.sessionId)?.startedAt ?? null,
          }))
          .sort(compareCompletedActivities)
          .map(({ activity }) => activity),
      );
    },
    async listCourseLessonProblems(learnerId, runIds) {
      assertOpen();
      const state = data.learners.get(learnerId);
      if (!state || !runIds.length) return [];
      return structuredClone(
        [...state.lessonProblems.values()]
          .filter(({ runId }) => runIds.includes(runId) && state.lessonRuns.has(runId))
          .sort(
            (a, b) =>
              compare(
                state.lessonRuns.get(a.runId)?.conceptId ?? '',
                state.lessonRuns.get(b.runId)?.conceptId ?? '',
              ) ||
              a.servedAt.getTime() - b.servedAt.getTime() ||
              compare(a.knowledgePointId, b.knowledgePointId) ||
              a.round - b.round ||
              a.position - b.position,
          ),
      );
    },
    async listCourseMasteryEvents(learnerId, conceptIds) {
      assertOpen();
      return structuredClone(
        (data.learners.get(learnerId)?.events ?? [])
          .filter(({ conceptId }) => conceptIds.includes(conceptId))
          .map(({ conceptId, createdAt, fromState, toState }) => ({
            conceptId,
            createdAt,
            fromState,
            toState,
          }))
          .sort(
            (a, b) =>
              compare(a.conceptId, b.conceptId) ||
              a.createdAt.getTime() - b.createdAt.getTime() ||
              compare(a.fromState, b.fromState) ||
              compare(a.toState, b.toState),
          ),
      );
    },
    async listDueReviewConcepts(learnerId, before) {
      assertOpen();
      return [...(data.learners.get(learnerId)?.cards.values() ?? [])]
        .filter((card) => !card.suspendedAt && card.dueAt < before)
        .sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime() || compareConceptDimension(a, b))
        .map(({ conceptId }) => conceptId);
    },
    async readSchedulerFacts(learnerId, query) {
      assertOpen();
      const state = data.learners.get(learnerId);
      const projection = data.schedulerProjections.get(learnerId);
      const storedLessonRuns = [...(state?.lessonRuns.values() ?? [])];
      const storedConceptIds = new Set(storedLessonRuns.map(({ conceptId }) => conceptId));
      const lessonRuns = [
        ...(projection?.lessonRuns ?? []).filter(
          ({ conceptId }) => !storedConceptIds.has(conceptId),
        ),
        ...storedLessonRuns.map(({ conceptId, status, startedAt, retryAfter }) => ({
          conceptId,
          status,
          startedAt,
          retryAfter,
        })),
      ];
      const cards = await this.listReviewCards(learnerId);
      const cardConcepts = new Map(cards.map(({ id, conceptId }) => [id, conceptId]));
      const activityIds = new Map(state?.attempts.map(({ id, activityId }) => [id, activityId]));
      const learnMinutes = new Map<string | null, number>();
      const learnSince = new Date(query.now.getTime() - 7 * 86_400_000);
      for (const activity of state?.activities.values() ?? []) {
        if (
          activity.kind !== 'learn' ||
          activity.status !== 'completed' ||
          !activity.completedAt ||
          activity.completedAt < learnSince ||
          activity.completedAt > query.now
        )
          continue;
        learnMinutes.set(
          activity.conceptId,
          (learnMinutes.get(activity.conceptId) ?? 0) + activity.plannedMinutes,
        );
      }
      const logSince = new Date(query.now.getTime() - 36 * 60 * 60 * 1000);
      const logThrough = startOfNextCalendarDay(
        query.now,
        data.settings.get(learnerId)?.timeZone ?? 'UTC',
      );
      const reviewLogFacts: SchedulerFacts['reviewLogFacts'] = [];
      const completedReviewLogFacts: SchedulerFacts['completedReviewLogFacts'] = [];
      for (const log of state?.reviewLogs ?? []) {
        const conceptId = cardConcepts.get(log.cardId);
        if (conceptId === undefined || log.createdAt < logSince || log.createdAt >= logThrough)
          continue;
        if (log.fsrsLog.source !== 'mixed_quiz')
          reviewLogFacts.push({ conceptId, createdAt: log.createdAt });
        const activityId = log.attemptId ? activityIds.get(log.attemptId) : undefined;
        const activity = activityId ? state?.activities.get(activityId) : undefined;
        if (activity?.kind === 'review' && activity.status === 'completed') {
          completedReviewLogFacts.push({
            activityId: activity.id,
            conceptId,
            rating: String(log.rating),
            createdAt: log.createdAt,
          });
        }
      }
      const recall = new Set(query.recallExerciseIds);
      const recallRows = (state?.attempts ?? [])
        .filter(({ exerciseId }) => recall.has(exerciseId))
        .sort(
          (left, right) =>
            compare(left.exerciseId, right.exerciseId) ||
            compareAttempts('final_evidence', left, right) ||
            right.correct - left.correct ||
            compare(right.id, left.id),
        );
      return structuredClone({
        mastery: query.skip?.includes('mastery') ? undefined : await this.listMastery(learnerId),
        lessonRuns: query.skip?.includes('lessonRuns')
          ? undefined
          : lessonRuns.sort(
              (left, right) =>
                compare(left.conceptId, right.conceptId) ||
                (right.startedAt ? new Date(right.startedAt).getTime() : 0) -
                  (left.startedAt ? new Date(left.startedAt).getTime() : 0),
            ),
        projectProgress: query.skip?.includes('projectProgress')
          ? undefined
          : [...(projection?.projectProgress ?? [])].sort((left, right) =>
              compare(left.projectId, right.projectId),
            ),
        paperProgress: [...(projection?.paperProgress ?? [])].sort((left, right) =>
          compare(left.paperId, right.paperId),
        ),
        cards: cards.filter(({ suspendedAt }) => !suspendedAt),
        topicSpeeds: await this.listTopicSpeedEvidence(learnerId),
        recentAttempts: await this.listAttempts(learnerId, { order: 'scheduler', limit: 100 }),
        flags: matchingFlags(learnerId, { status: 'open' }).sort(
          (left, right) =>
            compare(left.conceptId, right.conceptId) ||
            (left.targetPrereqId === null
              ? Number(right.targetPrereqId !== null)
              : right.targetPrereqId === null
                ? -1
                : compare(left.targetPrereqId, right.targetPrereqId)) ||
            compare(left.id, right.id),
        ),
        learnMinutes: [...learnMinutes].map(([conceptId, plannedMinutes]) => ({
          conceptId,
          plannedMinutes,
        })),
        reviewLogFacts,
        completedReviewLogFacts,
        recallAttempts: recallRows
          .filter(({ exerciseId }, i) => recallRows[i - 1]?.exerciseId !== exerciseId)
          .map(({ exerciseId, correct, createdAt }) => ({ exerciseId, correct, createdAt })),
      });
    },
    async listOpenRemediationFlags(learnerId) {
      assertOpen();
      return matchingFlags(learnerId, { status: 'open' }).map(
        ({ id, conceptId, targetPrereqId }) => ({ id, conceptId, targetPrereqId }),
      );
    },
    addRemediationFlag(learnerId, flag) {
      assertOpen();
      const { conceptId, targetPrereqId, createdAt = new Date(0) } = flag;
      const stored = { id: `flag-${++ids.flagCount}`, conceptId, targetPrereqId };
      stateFor(learnerId).flags.set(
        stored.id,
        structuredClone({
          ...stored,
          createdAt,
          status: 'open',
          openedByAttemptId: null,
          resolvedAt: null,
        }),
      );
      markWrite(learnerId);
      return structuredClone(stored);
    },
    resolveRemediationFlag(learnerId, id) {
      assertOpen();
      if (data.learners.get(learnerId)?.flags.delete(id)) markWrite(learnerId);
    },
  };
}
