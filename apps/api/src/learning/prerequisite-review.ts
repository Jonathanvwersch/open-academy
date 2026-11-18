import type { Card } from 'ts-fsrs';
import { Rating } from 'ts-fsrs';
import { retrievability, scheduleReview, startOfNextCalendarDay } from './fsrs.js';
import { localDateKey } from './xp.js';

const millisecondsPerDay = 86_400_000;

export const LAYERING_CREDIT = {
  fraction: 0.5,
  dueWithinDays: 3,
  minDaysSinceReview: 1,
} as const;

export interface LayeringCreditCard {
  id: string;
  dueAt: Date;
  lastReviewAt: Date | null;
  fsrs: Card;
}

export function layeringCredit(
  card: LayeringCreditCard,
  now: Date,
  timeZone: string,
  enableFuzz = true,
): { id: string; dueAt: Date; fsrs: Card } | undefined {
  if (card.dueAt.getTime() > now.getTime() + LAYERING_CREDIT.dueWithinDays * millisecondsPerDay) {
    return undefined;
  }
  if (
    card.lastReviewAt &&
    now.getTime() - card.lastReviewAt.getTime() <
      LAYERING_CREDIT.minDaysSinceReview * millisecondsPerDay
  ) {
    return undefined;
  }

  const goodDue = scheduleReview(card.fsrs, now, Rating.Good, timeZone, enableFuzz).card.due;
  const halfInterval = new Date(
    now.getTime() + LAYERING_CREDIT.fraction * (goodDue.getTime() - now.getTime()),
  );
  const nextLocalDay = startOfNextCalendarDay(now, timeZone);
  const dueAt = halfInterval < nextLocalDay ? nextLocalDay : halfInterval;
  if (dueAt <= card.dueAt) return undefined;

  return {
    id: card.id,
    dueAt,
    fsrs: { ...card.fsrs, due: dueAt },
  };
}

export interface PrerequisiteReviewCard {
  id: string;
  dueAt: Date;
  fsrs: Card;
}

export function bringWeakestPrerequisiteCardDueNow(
  cards: readonly PrerequisiteReviewCard[],
  now: Date,
  enableFuzz = true,
): PrerequisiteReviewCard | undefined {
  let weakest: PrerequisiteReviewCard | undefined;
  let weakestRetrievability = Number.POSITIVE_INFINITY;
  for (const card of cards) {
    const cardRetrievability = retrievability(card.fsrs, now, enableFuzz);
    if (cardRetrievability < weakestRetrievability) {
      weakest = card;
      weakestRetrievability = cardRetrievability;
    }
  }
  if (!weakest || weakest.dueAt <= now) return undefined;
  return {
    ...weakest,
    dueAt: now,
    fsrs: { ...weakest.fsrs, due: now },
  };
}

export function canBringPrerequisiteDueNow(input: {
  lastReviewAt: Date | null;
  now: Date;
  timeZone: string;
  coveredByActivity: boolean;
}): boolean {
  return (
    !input.coveredByActivity &&
    (!input.lastReviewAt ||
      localDateKey(input.lastReviewAt, input.timeZone) !== localDateKey(input.now, input.timeZone))
  );
}
