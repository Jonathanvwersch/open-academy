import { Rating, State } from 'ts-fsrs';
import { expect, test } from 'vitest';
import { fsrsScheduler, newReviewCard, scheduleReview, scheduleReviewWithDetails } from './fsrs.js';
import { topicSpeed } from './speed.js';

test('learning speed uses a prior, neutral start, asymmetric slopes, rounding and bounds', () => {
  expect(topicSpeed()).toBe(1);
  expect(topicSpeed({ answers: 2, successes: 0, trials: 1.8 })).toBe(1);
  expect(topicSpeed({ answers: 3, successes: 1.4, trials: 4 })).toBe(0.5);
  expect(topicSpeed({ answers: 3, successes: 0, trials: 2.44 })).toBe(0.5);
  expect(topicSpeed({ answers: 3, successes: 2.44, trials: 2.44 })).toBe(1.55);
  expect(topicSpeed({ answers: 1000, successes: 1000, trials: 1000 })).toBe(2);
  expect(topicSpeed({ answers: 3, successes: 9, trials: 2 })).toBe(2);
  const trials = (1 - 0.8 ** 100) / (1 - 0.8);
  expect(topicSpeed({ answers: 100, successes: trials, trials })).toBe(1.71);
});

test('scales only the raw successful interval and applies the floor and cap afterwards', () => {
  const fallBack = new Date('2026-11-01T04:00:00.000Z');
  const floored = scheduleReviewWithDetails(
    newReviewCard(fallBack),
    fallBack,
    Rating.Hard,
    'America/New_York',
    false,
    0.5,
  );
  expect(floored.rawDueAt).toEqual(new Date('2026-11-03T04:00:00.000Z'));
  expect(floored.card.due).toEqual(new Date('2026-11-02T05:00:00.000Z'));
  expect(floored.card.scheduled_days).toBe(25 / 24);

  const now = new Date('2026-01-15T00:30:00.000Z');
  const stable = {
    ...newReviewCard(now),
    state: State.Review,
    last_review: new Date('2025-12-01T00:30:00.000Z'),
    reps: 10,
    stability: 120,
    difficulty: 5,
  };
  const raw = fsrsScheduler(false).next(stable, now, Rating.Good);
  const capped = scheduleReviewWithDetails(stable, now, Rating.Good, 'UTC', false, 2);
  expect(capped.rawDueAt).toEqual(raw.card.due);
  expect(capped.card).toMatchObject({
    due: new Date(+now + 60 * 86_400_000),
    scheduled_days: 60,
    stability: raw.card.stability,
    difficulty: raw.card.difficulty,
  });
});

test('neutral speed preserves the previous FSRS result and Again ignores speed', () => {
  const now = new Date('2026-03-08T05:30:00.000Z');
  const card = newReviewCard(now);
  for (const rating of [Rating.Good, Rating.Hard, Rating.Again] as const) {
    const raw = fsrsScheduler(false).next(card, now, rating);
    const floor = new Date('2026-03-09T04:00:00.000Z');
    const expected = {
      ...raw,
      card: { ...raw.card, due: raw.card.due < floor ? floor : raw.card.due },
    };
    expect(JSON.stringify(scheduleReview(card, now, rating, 'America/New_York', false, 1))).toBe(
      JSON.stringify(expected),
    );
  }
  expect(scheduleReview(card, now, Rating.Again, 'UTC', false, 0.5)).toEqual(
    scheduleReview(card, now, Rating.Again, 'UTC', false, 1),
  );
});
