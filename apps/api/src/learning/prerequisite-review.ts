import type { Card } from 'ts-fsrs';
import { retrievability } from './fsrs.js';

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
