import type { Dimension } from '../course/schemas.js';
import { startOfNextCalendarDay } from '../memory/fsrs.js';
import { TOPIC_SPEED_DECAY, TOPIC_SPEED_POLICY, type TopicSpeedEvidence } from '../memory/speed.js';
import type { MasteryRecord } from '../memory/types.js';
import type { Attempt, AttemptQuery, Enrollment, Settings, XpEvent } from './core-store.js';
import type {
  MasteryEventRecord,
  OpenRemediationFlag,
  ReviewLogRecord,
  StoredReviewCard,
} from './learner-store.js';
import type {
  Activity,
  ActivityQuery,
  RemediationFlag,
  SchedulerFacts,
  Session,
  SessionStore,
} from './session-store.js';

export type MemoryLearnerStore = SessionStore & {
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
  reviewLogs: Array<ReviewLogRecord & { cardId: string }>;
  flags: Map<string, RemediationFlag>;
  attempts: Attempt[];
  xpEvents: Map<string, XpEvent>;
  enrollments: Map<string, Enrollment>;
  sessions: Map<string, Session>;
  activities: Map<string, Activity>;
};

type Hint = { exerciseId: string; activityId: string | null; createdAt: Date; level: number };

type MemorySeed = {
  settings?: ReadonlyMap<string, Settings>;
  hints?: ReadonlyMap<string, readonly Hint[]>;
  schedulerProjections?: ReadonlyMap<
    string,
    Pick<SchedulerFacts, 'lessonRuns' | 'projectProgress' | 'paperProgress'>
  >;
};

type StoreState = {
  learners: Map<string, LearnerState>;
  settings: Map<string, Settings>;
  hints: Map<string, readonly Hint[]>;
  revisions: Map<string, number>;
  schedulerProjections: Map<
    string,
    Pick<SchedulerFacts, 'lessonRuns' | 'projectProgress' | 'paperProgress'>
  >;
};

type IdCounters = {
  cardCount: number;
  flagCount: number;
  xpCount: number;
  sessionCount: number;
  activityCount: number;
};

const modeOrder: Attempt['mode'][] = ['practice', 'assessment', 'diagnostic', 'review'];

function compareAttempts(order: AttemptQuery['order'], left: Attempt, right: Attempt): number {
  const time = left.createdAt.getTime() - right.createdAt.getTime();
  const ordinal = left.attemptNo - right.attemptNo;
  switch (order) {
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
    { cardCount: 0, flagCount: 0, xpCount: 0, sessionCount: 0, activityCount: 0 },
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
        flags: new Map(),
        attempts: [],
        xpEvents: new Map(),
        enrollments: new Map(),
        sessions: new Map(),
        activities: new Map(),
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
    async listReviewCards(learnerId, conceptIds) {
      assertOpen();
      const concepts = conceptIds && new Set(conceptIds);
      const cards = [...(data.learners.get(learnerId)?.cards.values() ?? [])].filter(
        (card) => !concepts || concepts.has(card.conceptId),
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
      const stored = structuredClone({ ...card, id: `card-${++ids.cardCount}` });
      cards.set(cardKey, stored);
      markWrite(learnerId);
      return structuredClone(stored);
    },
    async recordReview(learnerId, conceptId, dimension, compute) {
      assertOpen();
      const { cards, reviewLogs } = stateFor(learnerId);
      const cardKey = key(conceptId, dimension);
      const current = cards.get(cardKey);
      const { card, log } = compute(structuredClone(current));
      const id = current?.id ?? `card-${++ids.cardCount}`;
      cards.set(cardKey, structuredClone({ ...card, conceptId, dimension, id }));
      markWrite(learnerId);
      reviewLogs.push(structuredClone({ ...log, cardId: id }));
      return true;
    },
    async updateReviewCardIfDue(learnerId, cardId, expectedDueAt, next) {
      assertOpen();
      const card = [...(data.learners.get(learnerId)?.cards.values() ?? [])].find(
        ({ id }) => id === cardId,
      );
      if (!card || card.dueAt.getTime() !== expectedDueAt.getTime()) return false;
      markWrite(learnerId);
      card.fsrs = structuredClone(next.fsrs);
      card.dueAt = structuredClone(next.dueAt);
      return true;
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
    async readSchedulerFacts(learnerId, query) {
      assertOpen();
      const state = data.learners.get(learnerId);
      const projection = data.schedulerProjections.get(learnerId);
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
          : [...(projection?.lessonRuns ?? [])].sort(
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
        cards,
        topicSpeeds: await this.listTopicSpeedEvidence(learnerId),
        recentAttempts: await this.listAttempts(learnerId, { order: 'scheduler', limit: 100 }),
        flags: [...(state?.flags.values() ?? [])].sort(
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
      return [...(data.learners.get(learnerId)?.flags.values() ?? [])].map(
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
