import type { Card } from 'ts-fsrs';
import { createEmptyCard, fsrs, generatorParameters, Rating } from 'ts-fsrs';

export type ReviewRating = 'again' | 'hard' | 'good';

export function fsrsScheduler(enableFuzz = true) {
  return fsrs(
    generatorParameters({
      request_retention: 0.9,
      maximum_interval: 60,
      enable_short_term: false,
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

export function reviewActivityRating(items: Array<{ correct: number; hintsUsed: number }>): Rating {
  if (items.length === 0) return Rating.Again;
  const correctCount = items.filter((item) => item.correct >= 1).length;
  if (correctCount === items.length && items.every((item) => item.hintsUsed === 0)) {
    return Rating.Good;
  }
  return correctCount / items.length >= 2 / 3 ? Rating.Hard : Rating.Again;
}

export function scheduleReview(
  card: Card,
  now: Date,
  rating: ReviewRating | Rating,
  timezone = 'UTC',
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
  const scheduled = fsrsScheduler(enableFuzz).next(card, now, safeRating);
  const earliestDue = startOfNextCalendarDay(now, timezone);
  return scheduled.card.due >= earliestDue
    ? scheduled
    : { ...scheduled, card: { ...scheduled.card, due: earliestDue } };
}

export function scheduleInitialReview(
  card: Card,
  now: Date,
  rating: ReviewRating | Rating,
  timezone = 'UTC',
  enableFuzz = true,
) {
  return scheduleReview(card, now, rating, timezone, enableFuzz);
}

export function retrievability(card: Card, now: Date, enableFuzz = true): number {
  return fsrsScheduler(enableFuzz).retrievability(card, now);
}

function startOfNextCalendarDay(now: Date, timezone: string): Date {
  const fields = (date: Date) => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      hourCycle: 'h23',
    }).formatToParts(date);
    return Object.fromEntries(parts.map((part) => [part.type, Number(part.value)]));
  };
  const current = fields(now);
  const nextDate = new Date(Date.UTC(current.year, current.month - 1, current.day + 1));
  const target = Date.UTC(nextDate.getUTCFullYear(), nextDate.getUTCMonth(), nextDate.getUTCDate());
  let candidate = target;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const local = fields(new Date(candidate));
    const represented = Date.UTC(
      local.year,
      local.month - 1,
      local.day,
      local.hour,
      local.minute,
      local.second,
    );
    const adjustment = target - represented;
    candidate += adjustment;
    if (adjustment === 0) break;
  }
  return new Date(candidate);
}
