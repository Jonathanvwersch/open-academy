import type { Card } from 'ts-fsrs';
import { createEmptyCard, fsrs, generatorParameters, Rating } from 'ts-fsrs';

export type ReviewRating = 'again' | 'hard' | 'good';

export function fsrsScheduler(enableFuzz = true) {
  return fsrs(
    generatorParameters({
      request_retention: 0.9,
      maximum_interval: 60,
      enable_fuzz: enableFuzz,
    }),
  );
}

export function newReviewCard(now: Date): Card {
  return createEmptyCard(now);
}

export function mapReviewRating(input: {
  correct: number;
  hintsUsed: number;
  attemptNo: number;
}): Rating {
  if (input.correct <= 0) {
    return Rating.Again;
  }
  if (input.hintsUsed > 0 || input.attemptNo > 1 || input.correct < 1) {
    return Rating.Hard;
  }
  return Rating.Good;
}

export function scheduleReview(
  card: Card,
  now: Date,
  rating: ReviewRating | Rating,
  enableFuzz = true,
) {
  const mappedRating =
    rating === 'again'
      ? Rating.Again
      : rating === 'hard'
        ? Rating.Hard
        : rating === 'good'
          ? Rating.Good
          : rating;
  const safeRating =
    mappedRating === Rating.Again || mappedRating === Rating.Hard || mappedRating === Rating.Good
      ? mappedRating
      : mappedRating === Rating.Easy
        ? Rating.Good
        : Rating.Again;
  return fsrsScheduler(enableFuzz).next(card, now, safeRating);
}

export function retrievability(card: Card, now: Date, enableFuzz = true): number {
  return fsrsScheduler(enableFuzz).retrievability(card, now);
}
