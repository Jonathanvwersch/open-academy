import { State } from 'ts-fsrs';
import { expect, it } from 'vitest';
import { newReviewCard, retrievability } from '../memory/fsrs.js';
import { bringWeakestPrerequisiteCardDueNow } from './prerequisite-review.js';

const now = new Date('2026-02-24T20:00:00.000Z');
const lastReview = new Date('2026-02-23T20:00:00.009Z');

const cardStates = [
  ['math', '2026-02-24T20:00:00.009Z', 0.22627268, 9.81664001, 6, 3, 1],
  ['conceptual', '2026-02-25T07:16:48.009Z', 0.28794379680000004, 9.8391776442, 7, 2, 1.5],
  ['implementation', '2026-02-26T06:50:34.682Z', 1.8517772059274, 9.255883389562, 6, 2, 2.55],
] as const;

const cards = cardStates.map(
  ([dimension, due, stability, difficulty, reps, lapses, scheduled_days]) => {
    const dueAt = new Date(due);
    return {
      conceptId: 'inverses-linear-systems',
      dimension,
      dueAt,
      fsrs: {
        ...newReviewCard(lastReview),
        due: dueAt,
        last_review: lastReview,
        state: State.Review,
        stability,
        difficulty,
        reps,
        lapses,
        scheduled_days,
      },
    };
  },
);

it('resets the same captured prerequisite card in all six permutations', () => {
  expect(cards.map((card) => retrievability(card.fsrs, now, false))).toEqual([1, 1, 1]);
  const [math, conceptual, implementation] = cards;
  const permutations = [
    [math, conceptual, implementation],
    [math, implementation, conceptual],
    [conceptual, math, implementation],
    [conceptual, implementation, math],
    [implementation, math, conceptual],
    [implementation, conceptual, math],
  ];
  for (const permutation of permutations) {
    expect(bringWeakestPrerequisiteCardDueNow(permutation, now, false)).toEqual({
      ...conceptual,
      dueAt: now,
      fsrs: { ...conceptual.fsrs, due: now },
    });
  }
});

it('compares topics before dimensions when retrievability ties', () => {
  const [math, conceptual] = cards;
  const earlier = { ...math, conceptId: 'dot-product' };
  expect(bringWeakestPrerequisiteCardDueNow([conceptual, earlier], now, false)).toMatchObject({
    conceptId: 'dot-product',
    dimension: 'math',
  });
});
