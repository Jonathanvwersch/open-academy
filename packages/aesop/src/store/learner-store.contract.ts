import { Rating } from 'ts-fsrs';
import { describe, expect, it } from 'vitest';
import type { Dimension } from '../course/schemas.js';
import { newReviewCard, scheduleReview } from '../memory/fsrs.js';
import { initialMastery, type MasteryRecord } from '../memory/types.js';
import type { LearnerStore, NewReviewCard } from './learner-store.js';

type StoreFixture = {
  store: LearnerStore;
  learnerId: string;
  addOpenFlag(conceptId: string, targetPrereqId: string | null): Promise<void>;
  resolveOpenFlag(id: string): Promise<void>;
};

const date = new Date('2026-01-17T12:00:00.000Z');

function cardFor(conceptId: string, dimension: Dimension = 'math'): NewReviewCard {
  return {
    conceptId,
    dimension,
    fsrs: newReviewCard(date),
    dueAt: date,
    lastReviewAt: null,
    reps: 0,
    lapses: 0,
  };
}

export function describeLearnerStoreContract(name: string, makeStore: () => Promise<StoreFixture>) {
  describe(name, () => {
    it('returns empty lists and undefined getters for a new learner', async () => {
      const { store, learnerId } = await makeStore();
      expect(await store.listMastery(learnerId)).toEqual([]);
      expect(await store.listTopicSpeedEvidence(learnerId)).toEqual([]);
      expect(await store.getMastery(learnerId, 'vectors', 'math')).toBeUndefined();
      expect(await store.listReviewCards(learnerId)).toEqual([]);
      expect(await store.getReviewCard(learnerId, 'vectors', 'math')).toBeUndefined();
      expect(await store.listOpenRemediationFlags(learnerId)).toEqual([]);
    });

    it('round-trips every mastery field and overwrites on a second save', async () => {
      const { store, learnerId } = await makeStore();
      const record: MasteryRecord = {
        conceptId: 'vectors',
        dimension: 'math',
        state: 'independent',
        provisional: true,
        inferred: true,
        independentItemIds: ['vectors-1'],
        independentDeterministicCount: 1,
        lastIndependentCorrect: true,
        lastAssessedAt: '2026-01-17T12:00:00.000Z',
        lastIndependentAt: '2026-01-14T12:00:00.000Z',
        firstIndependentAt: '2026-01-13T12:00:00.000Z',
        attempts: [
          {
            attemptId: 'attempt-1',
            exerciseId: 'vectors-1',
            correct: 1,
            credit: 1,
            hintsUsed: 0,
            attemptNo: 1,
            mode: 'practice',
            itemRole: 'core',
            gradedBy: 'deterministic',
            independent: true,
            createdAt: '2026-01-13T12:00:00.000Z',
          },
        ],
      };
      await store.saveMastery(learnerId, record);
      expect(await store.getMastery(learnerId, 'vectors', 'math')).toEqual(record);
      const updated = initialMastery('vectors', 'math');
      await store.saveMastery(learnerId, updated);
      expect(await store.getMastery(learnerId, 'vectors', 'math')).toEqual(updated);
      expect(await store.listMastery(learnerId)).toEqual([updated]);
    });

    it('orders mastery by concept then dimension', async () => {
      const { store, learnerId } = await makeStore();
      const algebraMath = initialMastery('algebra', 'math');
      const algebraConceptual = initialMastery('algebra', 'conceptual');
      const vectorsMath = initialMastery('vectors', 'math');
      for (const record of [vectorsMath, algebraMath, algebraConceptual]) {
        await store.saveMastery(learnerId, record);
      }
      expect(await store.listMastery(learnerId)).toEqual([
        algebraConceptual,
        algebraMath,
        vectorsMath,
      ]);
    });

    it('returns an inserted review card and rejects a duplicate', async () => {
      const { store, learnerId } = await makeStore();
      const card = cardFor('vectors');
      const inserted = await store.insertReviewCard(learnerId, card);
      expect(inserted.id).toBeTruthy();
      expect(inserted).toMatchObject({
        ...card,
        fsrs: { state: card.fsrs.state, reps: card.fsrs.reps },
      });
      expect(await store.getReviewCard(learnerId, 'vectors', 'math')).toEqual(inserted);
      await expect(store.insertReviewCard(learnerId, card)).rejects.toThrow();
    });

    it('upserts, sorts, filters and deep copies topic speed evidence', async () => {
      const { store, learnerId } = await makeStore();
      const vectors = {
        conceptId: 'vectors',
        successes: 1.5,
        trials: 2.5,
        answers: 3,
        updatedAt: new Date(date),
        policyVersion: 'speed-v1',
      };
      const algebra = { ...vectors, conceptId: 'algebra', updatedAt: new Date(date) };
      await store.saveTopicSpeedEvidence(learnerId, vectors);
      await store.saveTopicSpeedEvidence(learnerId, algebra);
      vectors.updatedAt.setUTCDate(1);
      const ordered = await store.listTopicSpeedEvidence(learnerId, ['vectors', 'algebra']);
      expect(ordered).toEqual([algebra, { ...vectors, updatedAt: date }]);
      ordered[0].updatedAt.setUTCDate(2);
      ordered[0].successes = 0;
      expect(await store.listTopicSpeedEvidence(learnerId, ['algebra'])).toEqual([algebra]);
      expect(await store.listTopicSpeedEvidence(learnerId, [])).toEqual([]);
      const updated = { ...algebra, conceptId: 'vectors', successes: 2, answers: 4 };
      await store.saveTopicSpeedEvidence(learnerId, updated);
      expect(await store.listTopicSpeedEvidence(learnerId)).toEqual([algebra, updated]);
      await store.addTopicSpeedAnswer(learnerId, 'vectors', true, date);
      expect(await store.listTopicSpeedEvidence(learnerId, ['vectors'])).toEqual([
        { ...updated, successes: expect.closeTo(2.6), trials: 3, answers: 5 },
      ]);
    });

    it('orders all and filtered review cards by concept and dimension', async () => {
      const { store, learnerId } = await makeStore();
      const vectors = await store.insertReviewCard(learnerId, cardFor('vectors'));
      const matrices = await store.insertReviewCard(learnerId, cardFor('matrices'));
      const algebraMath = await store.insertReviewCard(learnerId, cardFor('algebra'));
      const algebraConceptual = await store.insertReviewCard(
        learnerId,
        cardFor('algebra', 'conceptual'),
      );
      expect(await store.listReviewCards(learnerId)).toEqual([
        algebraConceptual,
        algebraMath,
        matrices,
        vectors,
      ]);
      expect(await store.listReviewCards(learnerId, ['vectors', 'algebra'])).toEqual([
        algebraConceptual,
        algebraMath,
        vectors,
      ]);
      expect(await store.listReviewCards(learnerId, [])).toEqual([]);
    });

    it('records a review on a new card and then updates the same card', async () => {
      const { store, learnerId } = await makeStore();
      const firstReview = scheduleReview(newReviewCard(date), date, Rating.Good, 'UTC', false);
      await store.recordReview(learnerId, 'vectors', 'math', (current) => {
        expect(current).toBeUndefined();
        return {
          card: {
            fsrs: firstReview.card,
            dueAt: firstReview.card.due,
            lastReviewAt: date,
            reps: firstReview.card.reps,
            lapses: firstReview.card.lapses,
          },
          log: { rating: Rating.Good, fsrsLog: firstReview.log, createdAt: date },
        };
      });
      const first = await store.getReviewCard(learnerId, 'vectors', 'math');
      expect(first).toMatchObject({
        dueAt: firstReview.card.due,
        lastReviewAt: date,
        reps: firstReview.card.reps,
      });

      const now = firstReview.card.due;
      const secondReview = scheduleReview(firstReview.card, now, Rating.Again, 'UTC', false);
      await store.recordReview(learnerId, 'vectors', 'math', (current) => {
        expect(current).toEqual(first);
        return {
          card: {
            fsrs: { ...secondReview.card, due: now },
            dueAt: now,
            lastReviewAt: now,
            reps: secondReview.card.reps,
            lapses: secondReview.card.lapses,
          },
          log: { rating: Rating.Again, fsrsLog: secondReview.log, createdAt: now },
        };
      });
      const cards = await store.listReviewCards(learnerId);
      expect(cards).toHaveLength(1);
      expect(cards[0]).toMatchObject({
        id: first?.id,
        dueAt: now,
        lastReviewAt: now,
        reps: secondReview.card.reps,
        lapses: secondReview.card.lapses,
      });
      expect(new Date(cards[0].fsrs.due)).toEqual(now);
    });

    it('updates only FSRS and dueAt on a match and leaves a stale card unchanged', async () => {
      const { store, learnerId } = await makeStore();
      const inserted = await store.insertReviewCard(learnerId, cardFor('vectors'));
      const dueAt = new Date('2026-01-18T12:00:00.000Z');
      const fsrs = { ...inserted.fsrs, reps: 2, due: dueAt };
      expect(await store.updateReviewCardIfDue(learnerId, inserted.id, date, { fsrs, dueAt })).toBe(
        true,
      );
      const updated = await store.getReviewCard(learnerId, 'vectors', 'math');
      expect(updated).toEqual({ ...inserted, dueAt, fsrs: { ...fsrs, due: updated?.fsrs.due } });
      expect(new Date(updated?.fsrs.due ?? 0)).toEqual(dueAt);
      expect(await store.updateReviewCardIfDue(learnerId, inserted.id, date, inserted)).toBe(false);
      expect(await store.getReviewCard(learnerId, 'vectors', 'math')).toEqual(updated);
    });

    it('lists open flags but omits the resolved flag', async () => {
      const { store, learnerId, addOpenFlag, resolveOpenFlag } = await makeStore();
      await addOpenFlag('vectors', 'algebra');
      const [flag] = await store.listOpenRemediationFlags(learnerId);
      expect(flag).toEqual({
        id: expect.any(String),
        conceptId: 'vectors',
        targetPrereqId: 'algebra',
      });
      await addOpenFlag('matrices', null);
      await resolveOpenFlag(flag.id);
      expect(await store.listOpenRemediationFlags(learnerId)).toEqual([
        { id: expect.any(String), conceptId: 'matrices', targetPrereqId: null },
      ]);
    });

    it('isolates learners for both reads and compare-and-set', async () => {
      const { store, learnerId, addOpenFlag } = await makeStore();
      const other = '00000000-0000-4000-8000-000000000002';
      await store.saveMastery(learnerId, initialMastery('vectors', 'math'));
      await store.addTopicSpeedAnswer(learnerId, 'vectors', true, date);
      const card = await store.insertReviewCard(learnerId, cardFor('vectors'));
      await addOpenFlag('vectors', null);

      expect(await store.listMastery(other)).toEqual([]);
      expect(await store.listTopicSpeedEvidence(other)).toEqual([]);
      expect(await store.getMastery(other, 'vectors', 'math')).toBeUndefined();
      expect(await store.listReviewCards(other)).toEqual([]);
      expect(await store.getReviewCard(other, 'vectors', 'math')).toBeUndefined();
      expect(await store.listOpenRemediationFlags(other)).toEqual([]);
      expect(await store.updateReviewCardIfDue(other, card.id, card.dueAt, card)).toBe(false);
    });
  });
}
