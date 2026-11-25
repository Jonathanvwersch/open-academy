import { Rating, State } from 'ts-fsrs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ContentIndex, IndexedConcept, IndexedExercise } from '../course/types.js';
import type { LearnerStore } from '../store/learner-store.js';
import { memoryStore } from '../store/memory-store.js';
import { newReviewCard, scheduleReview } from './fsrs.js';
import {
  applyImplicitRepetitions,
  applyMastery,
  setImplicitRepetitionTrace,
} from './mastery-service.js';

const learnerId = 'learner';
const now = new Date('2026-01-15T12:00:00.000Z');
const lastReviewAt = new Date('2026-01-01T12:00:00.000Z');
const timeZone = 'UTC';
const enableFuzz = false;
const weight = 0.5;
const concepts = [
  { id: 'base', prereqs: [] },
  {
    id: 'advanced',
    prereqs: [{ id: 'base', strength: 'hard' }],
    encompassings: [{ id: 'base', weight }],
  },
] as IndexedConcept[];
const index = {
  concepts,
  conceptsById: new Map(concepts.map((concept) => [concept.id, concept])),
} as ContentIndex;

function insertCard(
  store: LearnerStore,
  conceptId: string,
  dueAt: Date,
  state: State = State.Review,
) {
  const fsrs = {
    ...newReviewCard(lastReviewAt),
    due: dueAt,
    state,
    stability: 12,
    difficulty: 5,
    last_review: lastReviewAt,
    reps: 8,
    lapses: 2,
  };
  return store.insertReviewCard(learnerId, {
    conceptId,
    dimension: 'math',
    fsrs,
    dueAt,
    lastReviewAt,
    reps: fsrs.reps,
    lapses: fsrs.lapses,
  });
}

describe('applyImplicitRepetitions', () => {
  afterEach(() => setImplicitRepetitionTrace(undefined));

  it('moves an ancestor card later by the FIRe success weight', async () => {
    const store = memoryStore();
    const card = await insertCard(store, 'base', now);
    const trace = vi.fn();
    setImplicitRepetitionTrace(trace);
    const rating = Rating.Good;
    const fullDue = scheduleReview(card.fsrs, now, rating, timeZone, enableFuzz).card.due;
    const expectedDueAt = new Date(now.getTime() + weight * (fullDue.getTime() - now.getTime()));

    await applyImplicitRepetitions(store, {
      learnerId,
      conceptId: 'advanced',
      index,
      now,
      rating,
      timeZone,
      enableFuzz,
    });

    expect(expectedDueAt.getTime()).toBeGreaterThan(now.getTime());
    expect(await store.getReviewCard(learnerId, 'base', 'math')).toMatchObject({
      dueAt: expectedDueAt,
      fsrs: { due: expectedDueAt },
    });
    expect(trace).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        sourceConceptId: 'advanced',
        targetCardId: card.id,
        rating,
        weight,
        applied: true,
        before: expect.objectContaining({ dueAt: now }),
        after: expect.objectContaining({ dueAt: expectedDueAt }),
      }),
    );
  });

  it('moves a descendant card earlier on Again', async () => {
    const store = memoryStore();
    const originalDueAt = new Date('2026-01-25T12:00:00.000Z');
    const card = await insertCard(store, 'advanced', originalDueAt);
    const rating = Rating.Again;
    const fullDue = scheduleReview(card.fsrs, now, rating, timeZone, enableFuzz).card.due;
    const expectedDueAt = new Date(
      originalDueAt.getTime() + weight * (fullDue.getTime() - originalDueAt.getTime()),
    );
    await applyImplicitRepetitions(store, {
      learnerId,
      conceptId: 'base',
      index,
      now,
      rating,
      timeZone,
      enableFuzz,
    });
    expect(expectedDueAt.getTime()).toBeLessThan(originalDueAt.getTime());
    expect(await store.getReviewCard(learnerId, 'advanced', 'math')).toMatchObject({
      dueAt: expectedDueAt,
      fsrs: { due: expectedDueAt },
    });
  });

  it('leaves New-state cards untouched', async () => {
    const store = memoryStore();
    const card = await insertCard(store, 'base', now, State.New);
    const update = vi.spyOn(store, 'updateReviewCardIfDue');
    await applyImplicitRepetitions(store, {
      learnerId,
      conceptId: 'advanced',
      index,
      now,
      rating: Rating.Good,
      timeZone,
      enableFuzz,
    });
    expect(update).not.toHaveBeenCalled();
    expect(await store.getReviewCard(learnerId, 'base', 'math')).toEqual(card);
  });

  it('does not overwrite a card changed between the read and write', async () => {
    const store = memoryStore();
    const card = await insertCard(store, 'base', now);
    const dueAt = new Date('2026-01-16T12:00:00.000Z');
    const fsrs = { ...card.fsrs, due: dueAt };
    const wrapped: LearnerStore = {
      ...store,
      async updateReviewCardIfDue(id, cardId, expectedDueAt, next) {
        expect(await store.updateReviewCardIfDue(id, cardId, expectedDueAt, { fsrs, dueAt })).toBe(
          true,
        );
        return store.updateReviewCardIfDue(id, cardId, expectedDueAt, next);
      },
    };
    await applyImplicitRepetitions(wrapped, {
      learnerId,
      conceptId: 'advanced',
      index,
      now,
      rating: Rating.Good,
      timeZone,
      enableFuzz,
    });
    expect(await store.getReviewCard(learnerId, 'base', 'math')).toEqual({ ...card, fsrs, dueAt });
  });
});

it('writes the mastery event and creates the review card only once', async () => {
  const store = memoryStore();
  const addMasteryEvent = vi.spyOn(store, 'addMasteryEvent');
  const insertReviewCard = vi.spyOn(store, 'insertReviewCard');
  const exercise: IndexedExercise = {
    id: 'base-1',
    concept: 'base',
    contentVersion: 'test',
    dimension: 'math',
    type: 'numeric',
    role: 'core',
    lesson_only: false,
    difficulty: 1,
    est_minutes: 1,
    prompt: 'What is 1+1?',
    hints: [],
    solution: 'Add the two numbers.',
    answer: 2,
    tolerance: { abs: 0 },
  };
  const input = {
    learnerId,
    exercise,
    attemptId: 'attempt-1',
    correct: 1,
    credit: 1,
    hintsUsed: 0,
    attemptNo: 1,
    mode: 'practice',
    gradedBy: 'deterministic',
    now,
    timeZone,
    enableFuzz,
  } as const;

  const result = await applyMastery(store, input);
  expect(await store.getMastery(learnerId, 'base', 'math')).toEqual(result.mastery);
  expect(addMasteryEvent).toHaveBeenCalledExactlyOnceWith(learnerId, {
    conceptId: 'base',
    dimension: 'math',
    fromState: 'not_assessed',
    toState: 'assisted',
    rule: 'independent_correct_assisted',
    attemptId: 'attempt-1',
    createdAt: now,
  });
  const cards = await store.listReviewCards(learnerId);
  expect(cards).toHaveLength(1);
  await applyMastery(store, { ...input, attemptId: 'attempt-2' });
  expect(await store.listReviewCards(learnerId)).toEqual(cards);
  expect(insertReviewCard).toHaveBeenCalledTimes(1);
  expect(addMasteryEvent).toHaveBeenCalledTimes(1);
});
