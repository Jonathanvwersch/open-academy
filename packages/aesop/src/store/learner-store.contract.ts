import { Rating } from 'ts-fsrs';
import { describe, expect, it } from 'vitest';
import type { Dimension } from '../course/schemas.js';
import { newReviewCard, scheduleReview } from '../memory/fsrs.js';
import { countHintsSincePreviousAttempt } from '../memory/hints.js';
import { initialMastery, type MasteryRecord } from '../memory/types.js';
import type { Attempt, CoreStore, Enrollment, NewRow, XpEvent } from './core-store.js';
import type { NewReviewCard } from './learner-store.js';

type StoreFixture = {
  store: CoreStore;
  learnerId: string;
  otherLearnerId: string;
  activityId: string;
  addOpenFlag(conceptId: string, targetPrereqId: string | null): Promise<void>;
  resolveOpenFlag(id: string): Promise<void>;
};

const date = new Date('2026-01-17T12:00:00.000Z');
const later = new Date('2026-01-18T12:00:00.000Z');
const exerciseId = 'vectors-q1';

function attempt(n: number, overrides: Partial<Attempt> = {}): Attempt {
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    sessionId: null,
    activityId: null,
    exerciseId,
    exerciseVersion: '1',
    conceptId: 'vectors',
    dimension: 'math',
    mode: 'practice',
    answer: { seed: 42, answer: [1] },
    correct: 1,
    credit: 1,
    hintsUsed: 0,
    attemptNo: n,
    gradedBy: 'deterministic',
    feedback: { message: 'Correct.' },
    mistakeCategory: null,
    durationMs: null,
    createdAt: new Date(date),
    ...overrides,
  };
}

function xpEvent(sourceKey: string, earnedAt = new Date(date)): NewRow<XpEvent> {
  return { kind: 'quiz', sourceKey, conceptId: null, amount: 5, earnedAt, localDate: '2026-01-17' };
}

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
    it('round-trips attempts and applies all scoped filters and limits', async () => {
      const { store, learnerId, otherLearnerId, activityId } = await makeStore();
      const original = attempt(1, { activityId });
      const inserted = await store.insertAttempt(learnerId, original);
      expect(inserted).toEqual(original);
      await store.insertAttempt(otherLearnerId, attempt(2, { activityId }));
      await store.insertAttempt(learnerId, attempt(3, { exerciseId: 'vectors-q2' }));
      await expect(store.insertAttempt(otherLearnerId, original)).rejects.toThrow();
      (original.answer as { answer: number[] }).answer[0] = 0;
      (inserted.feedback as { message: string }).message = '';
      original.createdAt.setTime(0);
      const query = {
        ids: [inserted.id],
        activityIds: [activityId],
        exerciseIds: [exerciseId],
        conceptId: 'vectors',
        since: date,
        through: date,
        limit: 1,
      };
      const [row] = await store.listAttempts(learnerId, query);
      expect(row).toEqual(attempt(1, { activityId }));
      row.createdAt.setTime(0);
      expect(await store.listAttempts(learnerId, query)).toEqual([attempt(1, { activityId })]);
      expect(await store.listAttempts(learnerId, { ...query, limit: 0 })).toEqual([]);
      expect(await store.listAttempts(learnerId, { ...query, ids: [] })).toEqual([]);
      expect(
        await store.listAttempts(learnerId, { ...query, since: later, through: undefined }),
      ).toEqual([]);
      expect(await store.listAttempts(learnerId, { ...query, exerciseIds: ['other'] })).toEqual([]);
    });

    it('uses each historical attempt order', async () => {
      const { store, learnerId } = await makeStore();
      const rows = [attempt(1, { createdAt: later }), attempt(2), attempt(3, { createdAt: later })];
      for (const row of rows) await store.insertAttempt(learnerId, row);
      const numbers = async (
        order: Parameters<CoreStore['listAttempts']>[1]['order'],
        limit?: number,
      ) => (await store.listAttempts(learnerId, { order, limit })).map((row) => row.attemptNo);
      expect(await numbers('recent', 2)).toEqual(expect.arrayContaining([1, 3]));
      expect(await numbers('activity_attempt_no')).toEqual([1, 2, 3]);
      expect(await numbers('review_chronological')).toEqual([2, 1, 3]);
      expect(await numbers('final_evidence')).toEqual([3, 1, 2]);
    });

    it('preserves the scheduler exercise, number, correctness, mode and ID tie breaks', async () => {
      const { store, learnerId } = await makeStore();
      const rows = [
        attempt(1, { attemptNo: 2, mode: 'assessment' }),
        attempt(2, { attemptNo: 2, mode: 'practice' }),
        attempt(3, { attemptNo: 2, mode: 'practice' }),
        attempt(4, { attemptNo: 2, correct: 0 }),
        attempt(5, { attemptNo: 1 }),
        attempt(6, { exerciseId: 'vectors-q2' }),
        attempt(7, { createdAt: later }),
      ];
      for (const row of rows.reverse()) await store.insertAttempt(learnerId, row);
      const result = await store.listAttempts(learnerId, { order: 'scheduler' });
      expect(result.map(({ id }) => id)).toEqual([7, 2, 3, 1, 4, 5, 6].map((n) => attempt(n).id));
    });

    it('loads historical hint evidence across activities or within one activity', async () => {
      const { store, learnerId, otherLearnerId, activityId } = await makeStore();
      const sameTime = new Date('2026-01-17T12:00:00.000Z');
      await store.insertAttempt(learnerId, attempt(3, { createdAt: later }));
      await store.insertAttempt(learnerId, attempt(2, { activityId }));
      await store.insertAttempt(otherLearnerId, attempt(1, { activityId, createdAt: later }));
      const scoped = await store.readHintEvidence(learnerId, exerciseId, activityId);
      expect(scoped.attempts).toEqual([{ activityId, createdAt: sameTime }]);
      expect(scoped.hints).toEqual(
        expect.arrayContaining([
          { activityId, level: 1, createdAt: sameTime },
          { activityId, level: 5, createdAt: new Date('2026-01-17T12:00:01Z') },
        ]),
      );
      expect(scoped.hints).toHaveLength(2);
      const scope = { userId: learnerId, exerciseId };
      const count = (result: typeof scoped, activityId?: string) =>
        countHintsSincePreviousAttempt({
          ...scope,
          activityId,
          attempts: result.attempts.map((row) => ({ ...row, ...scope })),
          hints: result.hints.map((row) => ({ ...row, ...scope })),
        });
      expect(count(scoped, activityId)).toBe(5);
      expect(count(await store.readHintEvidence(learnerId, exerciseId))).toBe(0);
      expect(await store.readHintEvidence(learnerId, 'missing')).toEqual({
        attempts: [],
        hints: [],
      });
      scoped.hints[0].createdAt.setTime(0);
      expect(
        count(await store.readHintEvidence(learnerId, exerciseId, activityId), activityId),
      ).toBe(5);
    });

    it('inserts XP only once per learner and source key and matches literal prefixes', async () => {
      const { store, learnerId, otherLearnerId } = await makeStore();
      const event = xpEvent('kp:x_%\\:first');
      expect(await store.insertXpEventOnce(learnerId, event)).toBe(true);
      expect(await store.insertXpEventOnce(learnerId, { ...event, amount: 999 })).toBe(false);
      expect(await store.insertXpEventOnce(otherLearnerId, { ...event, amount: 999 })).toBe(true);
      await store.insertXpEventOnce(learnerId, xpEvent('kp:xxZZ:first'));
      await store.insertXpEventOnce(learnerId, xpEvent('kp:x_%\\:second', later));
      await store.insertXpEventOnce(learnerId, {
        ...xpEvent('kp:x_%\\:third'),
        localDate: '2026-01-16',
      });
      const query = { sourcePrefix: 'kp:x_%\\:', localDate: event.localDate, through: date };
      const [row] = await store.listXpEvents(learnerId, query);
      expect(row).toEqual({ ...event, id: expect.any(String) });
      event.earnedAt.setTime(0);
      row.earnedAt.setTime(0);
      expect(await store.listXpEvents(learnerId, { sourceKey: event.sourceKey })).toEqual([
        { ...xpEvent(event.sourceKey), id: row.id },
      ]);
      expect(await store.listXpEvents(otherLearnerId, query)).toEqual([
        expect.objectContaining({ amount: 999 }),
      ]);
    });

    it('patches settings by learner and replaces prefs without sharing JSON or dates', async () => {
      const { store, learnerId, otherLearnerId } = await makeStore();
      const prefs = { schedule: { monday: 45 } };
      const studySetInitializedAt = new Date(date);
      await store.patchSettings(learnerId, {
        activeCourseId: 'ml',
        studySetInitializedAt,
        prefs,
        startDate: '2026-01-17',
        timeZone: 'Europe/Paris',
      });
      studySetInitializedAt.setTime(0);
      prefs.schedule.monday = 5;
      const settings = await store.getSettings(learnerId);
      expect(settings).toEqual({
        activeCourseId: 'ml',
        studySetInitializedAt: date,
        prefs: { schedule: { monday: 45 } },
        startDate: '2026-01-17',
        timeZone: 'Europe/Paris',
      });
      (settings?.prefs.schedule as typeof prefs.schedule).monday = 60;
      settings?.studySetInitializedAt?.setTime(0);
      expect(await store.getSettings(learnerId)).toMatchObject({
        studySetInitializedAt: date,
        prefs: { schedule: { monday: 45 } },
      });
      await store.patchSettings(learnerId, {
        activeCourseId: null,
        prefs: {},
        studySetInitializedAt: null,
      });
      expect(await store.getSettings(learnerId)).toEqual({
        activeCourseId: null,
        studySetInitializedAt: null,
        prefs: {},
        startDate: '2026-01-17',
        timeZone: 'Europe/Paris',
      });
      expect(await store.getSettings(otherLearnerId)).toMatchObject({ prefs: {} });
    });

    it('uses the enrollment conflict policies and guarded status updates', async () => {
      const { store, learnerId, otherLearnerId } = await makeStore();
      const row: Enrollment = {
        courseId: 'ml',
        status: 'paused',
        startMethod: 'placement',
        startedAt: new Date(date),
        completedAt: null,
      };
      await store.writeEnrollments(learnerId, { kind: 'insert_missing', rows: [row] });
      await store.writeEnrollments(learnerId, {
        kind: 'insert_missing',
        rows: [{ ...row, status: 'active' }],
      });
      expect(await store.listEnrollments(learnerId)).toEqual([row]);
      await store.writeEnrollments(learnerId, {
        kind: 'start',
        row: {
          ...row,
          status: 'active',
          startMethod: 'beginning',
          startedAt: later,
        },
      });
      const [started] = await store.listEnrollments(learnerId);
      expect(started).toEqual({ ...row, status: 'active' });
      started.startedAt.setTime(0);
      await store.writeEnrollments(learnerId, {
        kind: 'complete',
        courseIds: ['ml', 'math'],
        now: later,
      });
      expect(await store.listEnrollments(learnerId)).toEqual(
        expect.arrayContaining([
          { ...row, startedAt: date, status: 'completed', completedAt: later },
          {
            courseId: 'math',
            startedAt: later,
            startMethod: 'beginning',
            status: 'completed',
            completedAt: later,
          },
        ]),
      );
      const reopen = {
        kind: 'set_status',
        courseIds: ['ml', 'absent'],
        status: 'active',
        completedAt: null,
      } as const;
      await store.writeEnrollments(learnerId, { ...reopen, ifStatus: 'paused' });
      expect(
        (await store.listEnrollments(learnerId)).find(({ courseId }) => courseId === 'ml')?.status,
      ).toBe('completed');
      await store.writeEnrollments(learnerId, { ...reopen, ifStatus: 'completed' });
      expect(await store.listEnrollments(learnerId)).toEqual(
        expect.arrayContaining([
          { ...row, status: 'active' },
          expect.objectContaining({ courseId: 'math', status: 'completed' }),
        ]),
      );
      expect(await store.listEnrollments(learnerId)).toHaveLength(2);
      expect(await store.listEnrollments(otherLearnerId)).toEqual([]);
    });

    it('uses one scoped handle for legacy and core writes and rolls back nested and outer work', async () => {
      const { store, learnerId } = await makeStore();
      const error = new Error('rollback');
      await expect(
        store.transaction(async (tx) => {
          await tx.lockLearner(learnerId, 'no_key_update');
          await tx.saveMastery(learnerId, initialMastery('vectors', 'math'));
          await tx.insertXpEventOnce(learnerId, xpEvent('parent'));
          await expect(
            tx.transaction(async (nested) => {
              expect(await nested.insertXpEventOnce(learnerId, xpEvent('parent'))).toBe(false);
              await nested.insertAttempt(learnerId, attempt(1));
              await nested.addTopicSpeedAnswer(learnerId, 'vectors', true, date);
              throw error;
            }),
          ).rejects.toBe(error);
          expect(await tx.listAttempts(learnerId, {})).toEqual([]);
          expect(await tx.listTopicSpeedEvidence(learnerId)).toEqual([]);
          await tx.transaction(async (nested) => {
            await nested.lockLearner(learnerId, 'update');
            await nested.insertXpEventOnce(learnerId, xpEvent('child'));
          });
          expect(await tx.listXpEvents(learnerId, {})).toHaveLength(2);
          throw error;
        }),
      ).rejects.toBe(error);
      expect(await store.listMastery(learnerId)).toEqual([]);
      expect(await store.listXpEvents(learnerId, {})).toEqual([]);
      expect(
        await store.transaction(async (tx) => tx.insertAttempt(learnerId, attempt(1))),
      ).toEqual(attempt(1));
      expect(await store.listAttempts(learnerId, {})).toEqual([attempt(1)]);
    });
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
