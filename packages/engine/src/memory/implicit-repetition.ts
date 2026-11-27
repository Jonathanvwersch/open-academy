import type { Card } from 'ts-fsrs';
import { Rating, State } from 'ts-fsrs';
import { scheduleReview } from './fsrs.js';

export function positiveCreditBlocked(rating: Rating, speed: number): boolean {
  return (rating === Rating.Good || rating === Rating.Hard) && speed < 1;
}

export function implicitRepetition(
  card: { fsrs: Card; dueAt: Date },
  input: {
    weight: number;
    rating: Rating;
    now: Date;
    timeZone: string;
    enableFuzz: boolean;
    speed?: number;
  },
): { fsrs: Card; dueAt: Date } | undefined {
  if (positiveCreditBlocked(input.rating, input.speed ?? 1)) return undefined;
  const rawLastReviewAt: unknown = card.fsrs.last_review;
  const lastReviewAt =
    rawLastReviewAt instanceof Date
      ? rawLastReviewAt.getTime()
      : typeof rawLastReviewAt === 'string'
        ? Date.parse(rawLastReviewAt)
        : typeof rawLastReviewAt === 'number'
          ? rawLastReviewAt
          : undefined;
  if (
    input.weight <= 0 ||
    card.fsrs.state === State.New ||
    (lastReviewAt !== undefined && lastReviewAt > input.now.getTime())
  ) {
    return undefined;
  }

  const full = scheduleReview(
    card.fsrs,
    input.now,
    input.rating,
    input.timeZone,
    input.enableFuzz,
    input.speed,
  ).card;
  const isPassed = input.rating === Rating.Good || input.rating === Rating.Hard;
  if (isPassed ? full.due <= card.dueAt : full.due >= card.dueAt) return undefined;
  const dueAt = new Date(
    card.dueAt.getTime() + input.weight * (full.due.getTime() - card.dueAt.getTime()),
  );
  if (dueAt.getTime() === card.dueAt.getTime()) return undefined;
  return {
    fsrs: {
      ...card.fsrs,
      stability: card.fsrs.stability + input.weight * (full.stability - card.fsrs.stability),
      difficulty: card.fsrs.difficulty + input.weight * (full.difficulty - card.fsrs.difficulty),
      due: dueAt,
    },
    dueAt,
  };
}
