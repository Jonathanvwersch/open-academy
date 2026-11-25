import { expect, it } from 'vitest';
import { newReviewCard } from '../memory/fsrs.js';
import { initialMastery } from '../memory/types.js';
import { describeLearnerStoreContract } from './learner-store.contract.js';
import { memoryStore } from './memory-store.js';

const learnerId = 'learner';

describeLearnerStoreContract('memoryStore', async () => {
  const store = memoryStore();
  return {
    store,
    learnerId,
    async addOpenFlag(conceptId, targetPrereqId) {
      store.addRemediationFlag(learnerId, { conceptId, targetPrereqId });
    },
    async resolveOpenFlag(id) {
      store.resolveRemediationFlag(learnerId, id);
    },
  };
});

it('does not expose mutable mastery records or cards from memoryStore', async () => {
  const store = memoryStore();
  const record = initialMastery('vectors', 'math');
  const dueAt = new Date('2026-01-17T12:00:00.000Z');
  await store.saveMastery(learnerId, record);
  const inserted = await store.insertReviewCard(learnerId, {
    conceptId: 'vectors',
    dimension: 'math',
    fsrs: newReviewCard(dueAt),
    dueAt,
    lastReviewAt: null,
    reps: 0,
    lapses: 0,
  });
  const [listedMastery] = await store.listMastery(learnerId);
  const [listedCard] = await store.listReviewCards(learnerId);
  listedMastery.independentItemIds.push('vectors-1');
  listedCard.fsrs.due.setUTCDate(18);
  listedCard.dueAt.setUTCDate(19);
  expect(await store.getMastery(learnerId, 'vectors', 'math')).toEqual(record);
  expect(await store.getReviewCard(learnerId, 'vectors', 'math')).toEqual(inserted);
});
