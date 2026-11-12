import { Rating } from 'ts-fsrs';
import { describe, expect, it } from 'vitest';
import { reviewActivityRating } from '../src/server/learning/fsrs.js';

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
});
