import type { Dimension } from '../course/schemas.js';
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
      cardCount: 0,
      flagCount: 0,
      xpCount: 0,
    },
    hints,
  );
}

function scopedStore(
  data: StoreState,
  hints: ReadonlyMap<string, readonly Hint[]>,
): MemoryLearnerStore {
  let pending = Promise.resolve();
  function stateFor(learnerId: string): LearnerState {
    let state = data.learners.get(learnerId);
    if (!state) {
      state = {
        mastery: new Map(),
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
      const run = async () => {
        const snapshot = structuredClone(data);
        const tx = scopedStore(snapshot, hints);
        const result = await fn(tx as typeof this);
        Object.assign(data, snapshot);
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
      data.settings.get(learnerId);
    },
    async listAttempts(learnerId, query) {
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
      const { xpEvents } = stateFor(learnerId);
      if (xpEvents.has(event.sourceKey)) return false;
      const id = `00000000-0000-4000-8000-${(++data.xpCount).toString(16).padStart(12, '0')}`;
      xpEvents.set(event.sourceKey, structuredClone({ ...event, id }));
      return true;
    },
    async getSettings(learnerId) {
      return structuredClone(data.settings.get(learnerId));
    },
    async patchSettings(learnerId, patch) {
      const settings = data.settings.get(learnerId);
      if (settings) {
        const updated = { ...settings };
        for (const key of Object.keys(settings) as (keyof Settings)[]) {
          if (patch[key] !== undefined)
            Object.assign(updated, { [key]: structuredClone(patch[key]) });
        }
        data.settings.set(learnerId, updated);
      }
    },
    async listEnrollments(learnerId) {
      return structuredClone([...(data.learners.get(learnerId)?.enrollments.values() ?? [])]);
    },
    async writeEnrollments(learnerId, change) {
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
      const records = [...(data.learners.get(learnerId)?.mastery.values() ?? [])];
      return structuredClone(records.sort(compareConceptDimension));
    },
    async getMastery(learnerId, conceptId, dimension) {
      return structuredClone(data.learners.get(learnerId)?.mastery.get(key(conceptId, dimension)));
    },
    async saveMastery(learnerId, record) {
      stateFor(learnerId).mastery.set(
        key(record.conceptId, record.dimension),
        structuredClone(record),
      );
    },
    async addMasteryEvent(learnerId, event) {
      stateFor(learnerId).events.push(structuredClone(event));
    },
    async listReviewCards(learnerId, conceptIds) {
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
      return structuredClone(data.learners.get(learnerId)?.cards.get(key(conceptId, dimension)));
    },
    async insertReviewCard(learnerId, card) {
      const { cards } = stateFor(learnerId);
      const cardKey = key(card.conceptId, card.dimension);
      if (cards.has(cardKey)) {
        throw new Error('A review card already exists for this learner, concept and dimension.');
      }
      const stored = structuredClone({ ...card, id: `card-${++data.cardCount}` });
      cards.set(cardKey, stored);
      return structuredClone(stored);
    },
    async recordReview(learnerId, conceptId, dimension, compute) {
      const { cards, reviewLogs } = stateFor(learnerId);
      const cardKey = key(conceptId, dimension);
      const current = cards.get(cardKey);
      const { card, log } = compute(structuredClone(current));
      const id = current?.id ?? `card-${++data.cardCount}`;
      cards.set(cardKey, structuredClone({ ...card, conceptId, dimension, id }));
      reviewLogs.push(structuredClone({ ...log, cardId: id }));
      return true;
    },
    async updateReviewCardIfDue(learnerId, cardId, expectedDueAt, next) {
      const card = [...(data.learners.get(learnerId)?.cards.values() ?? [])].find(
        ({ id }) => id === cardId,
      );
      if (!card || card.dueAt.getTime() !== expectedDueAt.getTime()) return false;
      card.fsrs = structuredClone(next.fsrs);
      card.dueAt = structuredClone(next.dueAt);
      return true;
    },
    async listOpenRemediationFlags(learnerId) {
      return structuredClone([...(data.learners.get(learnerId)?.flags.values() ?? [])]);
    },
    addRemediationFlag(learnerId, flag) {
      const stored = { ...flag, id: `flag-${++data.flagCount}` };
      stateFor(learnerId).flags.set(stored.id, stored);
      return structuredClone(stored);
    },
    resolveRemediationFlag(learnerId, id) {
      data.learners.get(learnerId)?.flags.delete(id);
    },
  };
}
