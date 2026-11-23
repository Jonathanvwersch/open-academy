import type { Card } from 'ts-fsrs';
import { Rating, State } from 'ts-fsrs';
import { scheduleReview } from './fsrs.js';

export function implicitRepetition(
  card: { fsrs: Card; dueAt: Date },
  input: {
    weight: number;
    rating: Rating;
    now: Date;
    timeZone: string;
    enableFuzz: boolean;
  },
): { fsrs: Card; dueAt: Date } | undefined {
  if (input.weight <= 0 || card.fsrs.state === State.New) return undefined;

  const full = scheduleReview(
    card.fsrs,
    input.now,
    input.rating,
    input.timeZone,
    input.enableFuzz,
  ).card;
  const isPassed = input.rating === Rating.Good || input.rating === Rating.Hard;
  if (isPassed ? full.due <= card.dueAt : full.due >= card.dueAt) return undefined;
  const dueAt = new Date(
    card.dueAt.getTime() + input.weight * (full.due.getTime() - card.dueAt.getTime()),
  );
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
