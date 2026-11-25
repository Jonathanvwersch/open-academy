import type { Dimension } from '../course/schemas.js';
import { TOPIC_SPEED_DECAY, TOPIC_SPEED_POLICY, type TopicSpeedEvidence } from '../memory/speed.js';
import type { MasteryRecord } from '../memory/types.js';
import type {
  Attempt,
  AttemptQuery,
  CoreStore,
  Enrollment,
  Settings,
  XpEvent,
} from './core-store.js';
import type {
  MasteryEventRecord,
  OpenRemediationFlag,
  ReviewLogRecord,
  StoredReviewCard,
} from './learner-store.js';

export type MemoryLearnerStore = CoreStore & {
  addRemediationFlag(
    learnerId: string,
    flag: { conceptId: string; targetPrereqId: string | null },
  ): OpenRemediationFlag;
  resolveRemediationFlag(learnerId: string, id: string): void;
};

type LearnerState = {
  mastery: Map<string, MasteryRecord>;
  topicSpeed: Map<string, TopicSpeedEvidence>;
  events: MasteryEventRecord[];
  cards: Map<string, StoredReviewCard>;
  reviewLogs: Array<ReviewLogRecord & { cardId: string }>;
  flags: Map<string, OpenRemediationFlag>;
  attempts: Attempt[];
  xpEvents: Map<string, XpEvent>;
  enrollments: Map<string, Enrollment>;
};

type Hint = { exerciseId: string; activityId: string | null; createdAt: Date; level: number };

type MemorySeed = {
  settings?: ReadonlyMap<string, Settings>;
  hints?: ReadonlyMap<string, readonly Hint[]>;
};

type StoreState = {
  learners: Map<string, LearnerState>;
  settings: Map<string, Settings>;
  revisions: Map<string, number>;
};

type IdCounters = {
  cardCount: number;
  flagCount: number;
  xpCount: number;
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
  const hints = structuredClone(new Map(seed.hints));
  return scopedStore(
    {
      learners: new Map(),
      settings: structuredClone(new Map(seed.settings)),
      revisions: new Map(),
    },
    hints,
    { cardCount: 0, flagCount: 0, xpCount: 0 },
  );
}

function scopedStore(
  data: StoreState,
  hints: ReadonlyMap<string, readonly Hint[]>,
  ids: IdCounters,
  assertOpen: () => void = () => {},
): MemoryLearnerStore {
  let pending = Promise.resolve();
  function markWrite(learnerId: string) {
    data.revisions.set(learnerId, (data.revisions.get(learnerId) ?? 0) + 1);
  }
  function stateFor(learnerId: string): LearnerState {
    markWrite(learnerId);
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
      };
      data.learners.set(learnerId, state);
    }
    return state;
  }

  return {
    async transaction(fn) {
      assertOpen();
      const run = async () => {
        assertOpen();
        const original = new Map(data.revisions);
        const snapshot = structuredClone(data);
        let open = true;
        const tx = scopedStore(snapshot, hints, ids, () => {
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
        hints: (hints.get(learnerId) ?? [])
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
        for (const key of Object.keys(settings) as (keyof Settings)[]) {
          if (patch[key] !== undefined)
            Object.assign(updated, { [key]: structuredClone(patch[key]) });
        }
        markWrite(learnerId);
        data.settings.set(learnerId, updated);
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
            if (!enrollments.has(row.courseId)) enrollments.set(row.courseId, structuredClone(row));
          }
          break;
        case 'start': {
          const current = enrollments.get(change.row.courseId);
          if (current) current.status = 'active';
          else enrollments.set(change.row.courseId, structuredClone(change.row));
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
          }
          break;
        case 'set_status':
          for (const courseId of change.courseIds) {
            const current = enrollments.get(courseId);
            if (current && (change.ifStatus === undefined || current.status === change.ifStatus)) {
              current.status = change.status;
              current.completedAt = structuredClone(change.completedAt);
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
    },
    async addMasteryEvent(learnerId, event) {
      assertOpen();
      stateFor(learnerId).events.push(structuredClone(event));
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
    async listOpenRemediationFlags(learnerId) {
      assertOpen();
      return structuredClone([...(data.learners.get(learnerId)?.flags.values() ?? [])]);
    },
    addRemediationFlag(learnerId, flag) {
      assertOpen();
      const stored = { ...flag, id: `flag-${++ids.flagCount}` };
      stateFor(learnerId).flags.set(stored.id, stored);
      return structuredClone(stored);
    },
    resolveRemediationFlag(learnerId, id) {
      assertOpen();
      if (data.learners.get(learnerId)?.flags.delete(id)) markWrite(learnerId);
    },
  };
}
