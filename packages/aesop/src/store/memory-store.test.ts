import { expect, it } from 'vitest';
import { newReviewCard } from '../memory/fsrs.js';
import { initialMastery } from '../memory/types.js';
import { describeLearnerStoreContract } from './learner-store.contract.js';
import { memoryStore } from './memory-store.js';

const learnerId = 'learner';

describeLearnerStoreContract('memoryStore', async () => {
  const otherLearnerId = 'other';
  const activityId = 'activity';
  const settings = {
    activeCourseId: null,
    studySetInitializedAt: null,
    startDate: '',
    timeZone: 'Europe/London',
    prefs: {},
  };
  const store = memoryStore({
    settings: new Map([
      [learnerId, settings],
      [otherLearnerId, settings],
    ]),
    hints: new Map([
      [
        learnerId,
        [
          {
            exerciseId: 'vectors-q1',
            activityId,
            level: 5,
            createdAt: new Date('2026-01-17T12:00:01Z'),
          },
          {
            exerciseId: 'vectors-q1',
            activityId,
            level: 1,
            createdAt: new Date('2026-01-17T12:00:00Z'),
          },
        ],
      ],
      [
        otherLearnerId,
        [
          {
            exerciseId: 'vectors-q1',
            activityId,
            level: 5,
            createdAt: new Date('2026-01-19T12:00:00Z'),
          },
        ],
      ],
    ]),
  });
  return {
    store,
    learnerId,
    otherLearnerId,
    activityId,
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

it('preserves writes for other learners made while a transaction is open', async () => {
  const store = memoryStore();
  const otherLearnerId = 'other';
  const { inside, outside } = await store.transaction(async (tx) => {
    const inside = tx.addRemediationFlag(learnerId, {
      conceptId: 'vectors',
      targetPrereqId: null,
    });
    const outside = store.addRemediationFlag(otherLearnerId, {
      conceptId: 'vectors',
      targetPrereqId: null,
    });
    return { inside, outside };
  });

  expect(await store.listOpenRemediationFlags(learnerId)).toEqual([inside]);
  expect(await store.listOpenRemediationFlags(otherLearnerId)).toEqual([outside]);
  expect(inside.id).not.toBe(outside.id);
});

it('does not overwrite a parent write for the same learner on conflict', async () => {
  const store = memoryStore();
  const outside = initialMastery('vectors', 'math');
  await expect(
    store.transaction(async (tx) => {
      await tx.saveMastery(learnerId, initialMastery('matrices', 'math'));
      await store.saveMastery(learnerId, outside);
    }),
  ).rejects.toThrow('Learner state changed outside this transaction.');
  expect(await store.listMastery(learnerId)).toEqual([outside]);
});
