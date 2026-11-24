import type { Card } from 'ts-fsrs';
import { retrievability } from './fsrs.js';
import { localDateKey } from './xp.js';

export interface PrerequisiteReviewCard {
  id: string;
  dueAt: Date;
  fsrs: Card;
}

export function bringWeakestPrerequisiteCardDueNow<T extends PrerequisiteReviewCard>(
  cards: readonly T[],
  now: Date,
  enableFuzz = true,
): T | undefined {
  let weakest: T | undefined;
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
