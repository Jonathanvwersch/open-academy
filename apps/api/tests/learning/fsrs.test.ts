import { Rating, State } from 'ts-fsrs';
import { describe, expect, it } from 'vitest';
import { mapReviewRating, newReviewCard, reviewActivityRating } from '../../src/learning/fsrs.js';
import { bringWeakestPrerequisiteCardDueNow } from '../../src/learning/prerequisite-review.js';

describe('reviewActivityRating', () => {
  it.each([
    { items: [], rating: Rating.Again },
    {
      items: [
        { correct: 1, hintsUsed: 0 },
        { correct: 1, hintsUsed: 0 },
        { correct: 1, hintsUsed: 0 },
      ],
      rating: Rating.Good,
    },
    {
      items: [
        { correct: 1, hintsUsed: 0 },
        { correct: 1, hintsUsed: 0 },
        { correct: 0, hintsUsed: 0 },
      ],
      rating: Rating.Hard,
    },
    {
      items: [
        { correct: 1, hintsUsed: 1 },
        { correct: 1, hintsUsed: 0 },
        { correct: 1, hintsUsed: 0 },
      ],
      rating: Rating.Hard,
    },
    {
      items: [
        { correct: 1, hintsUsed: 0 },
        { correct: 0, hintsUsed: 0 },
        { correct: 0, hintsUsed: 0 },
      ],
      rating: Rating.Again,
    },
  ])('rates $items as $rating', ({ items, rating }) => {
    expect(reviewActivityRating(items)).toBe(rating);
  });

  it('rates slow correct answers as Hard without changing the correct-answer threshold', () => {
    const slow = {
      correct: 1,
      hintsUsed: 0,
      durationMs: 30_001,
      targetSeconds: 30,
    };

    expect(
      reviewActivityRating([slow, { correct: 1, hintsUsed: 0 }, { correct: 1, hintsUsed: 0 }]),
    ).toBe(Rating.Hard);
    expect(
      reviewActivityRating([
        { ...slow, durationMs: undefined },
        { correct: 1, hintsUsed: 0 },
        { correct: 1, hintsUsed: 0 },
      ]),
    ).toBe(Rating.Good);
    expect(
      reviewActivityRating([slow, { correct: 1, hintsUsed: 0 }, { correct: 0, hintsUsed: 0 }]),
    ).toBe(Rating.Hard);
  });

  it('rates a slow correct first review as Hard', () => {
    expect(
      mapReviewRating({
        correct: 1,
        hintsUsed: 0,
        attemptNo: 1,
        durationMs: 30_001,
        targetSeconds: 30,
      }),
    ).toBe(Rating.Hard);
    expect(mapReviewRating({ correct: 1, hintsUsed: 0, attemptNo: 1, targetSeconds: 30 })).toBe(
      Rating.Good,
    );
  });
});

describe('bringWeakestPrerequisiteCardDueNow', () => {
  const now = new Date('2026-01-15T12:00:00.000Z');
  const future = new Date('2026-01-22T12:00:00.000Z');
  const card = (id: string, daysAgo: number, stability: number, dueAt = future) => {
    const lastReview = new Date(now.getTime() - daysAgo * 86_400_000);
    return {
      id,
      dueAt,
      fsrs: {
        ...newReviewCard(lastReview),
        state: State.Review,
        stability,
        last_review: lastReview,
        due: dueAt,
      },
    };
  };

  it('pulls the least retrievable future card due and updates both due fields', () => {
    const weakest = card('weakest', 10, 1);
    const stronger = card('stronger', 1, 10);
    const result = bringWeakestPrerequisiteCardDueNow([stronger, weakest], now, false);

    expect(result).toMatchObject({ id: 'weakest', dueAt: now, fsrs: { due: now } });
    expect(weakest.dueAt).toEqual(future);
    expect(weakest.fsrs.due).toEqual(future);
  });

  it('leaves an already-due weakest card unchanged', () => {
    const dueAt = new Date('2026-01-14T12:00:00.000Z');
    const weakest = card('weakest', 10, 1, dueAt);
    const stronger = card('stronger', 1, 10);

    expect(bringWeakestPrerequisiteCardDueNow([stronger, weakest], now, false)).toBeUndefined();
    expect(weakest.dueAt).toEqual(dueAt);
    expect(weakest.fsrs.due).toEqual(dueAt);
  });
});
