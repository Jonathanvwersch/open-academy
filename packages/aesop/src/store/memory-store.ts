import type { Dimension } from '../course/schemas.js';
import type { MasteryRecord } from '../memory/types.js';
import type {
  LearnerStore,
  MasteryEventRecord,
  OpenRemediationFlag,
  ReviewLogRecord,
  StoredReviewCard,
} from './learner-store.js';

export type MemoryLearnerStore = LearnerStore & {
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
};

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

export function memoryStore(): MemoryLearnerStore {
  const learners = new Map<string, LearnerState>();
  let cardCount = 0;
  let flagCount = 0;

  function stateFor(learnerId: string): LearnerState {
    let state = learners.get(learnerId);
    if (!state) {
      state = {
        mastery: new Map(),
        events: [],
        cards: new Map(),
        reviewLogs: [],
        flags: new Map(),
      };
      learners.set(learnerId, state);
    }
    return state;
  }

  return {
    async listMastery(learnerId) {
      const records = [...(learners.get(learnerId)?.mastery.values() ?? [])];
      return structuredClone(records.sort(compareConceptDimension));
    },
    async getMastery(learnerId, conceptId, dimension) {
      return structuredClone(learners.get(learnerId)?.mastery.get(key(conceptId, dimension)));
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
      const cards = [...(learners.get(learnerId)?.cards.values() ?? [])].filter(
        (card) => !concepts || concepts.has(card.conceptId),
      );
      return structuredClone(
        cards.sort(
          (left, right) => compareConceptDimension(left, right) || compare(left.id, right.id),
        ),
      );
    },
    async getReviewCard(learnerId, conceptId, dimension) {
      return structuredClone(learners.get(learnerId)?.cards.get(key(conceptId, dimension)));
    },
    async insertReviewCard(learnerId, card) {
      const { cards } = stateFor(learnerId);
      const cardKey = key(card.conceptId, card.dimension);
      if (cards.has(cardKey)) {
        throw new Error('A review card already exists for this learner, concept and dimension.');
      }
      const stored = structuredClone({ ...card, id: `card-${++cardCount}` });
      cards.set(cardKey, stored);
      return structuredClone(stored);
    },
    async recordReview(learnerId, conceptId, dimension, compute) {
      const { cards, reviewLogs } = stateFor(learnerId);
      const cardKey = key(conceptId, dimension);
      const current = cards.get(cardKey);
      const { card, log } = compute(structuredClone(current));
      const id = current?.id ?? `card-${++cardCount}`;
      cards.set(cardKey, structuredClone({ ...card, conceptId, dimension, id }));
      reviewLogs.push(structuredClone({ ...log, cardId: id }));
      return true;
    },
    async updateReviewCardIfDue(learnerId, cardId, expectedDueAt, next) {
      const card = [...(learners.get(learnerId)?.cards.values() ?? [])].find(
        ({ id }) => id === cardId,
      );
      if (!card || card.dueAt.getTime() !== expectedDueAt.getTime()) return false;
      card.fsrs = structuredClone(next.fsrs);
      card.dueAt = structuredClone(next.dueAt);
      return true;
    },
    async listOpenRemediationFlags(learnerId) {
      return structuredClone([...(learners.get(learnerId)?.flags.values() ?? [])]);
    },
    addRemediationFlag(learnerId, flag) {
      const stored = { ...flag, id: `flag-${++flagCount}` };
      stateFor(learnerId).flags.set(stored.id, stored);
      return structuredClone(stored);
    },
    resolveRemediationFlag(learnerId, id) {
      learners.get(learnerId)?.flags.delete(id);
    },
  };
}
