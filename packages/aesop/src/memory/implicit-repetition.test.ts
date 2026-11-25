import { Rating, State } from 'ts-fsrs';
import { describe, expect, it } from 'vitest';
import { newReviewCard, scheduleReview } from './fsrs.js';
import { implicitRepetition } from './implicit-repetition.js';

const timeZone = 'UTC';
const now = new Date('2026-01-15T12:00:00.000Z');

function reviewCard(lastReview: Date, dueAt: Date, stability = 12, difficulty = 5) {
  return {
    fsrs: {
      ...newReviewCard(lastReview),
      state: State.Review,
      stability,
      difficulty,
      reps: 8,
      lapses: 2,
      last_review: lastReview,
      elapsed_days: 4,
      due: dueAt,
    },
    dueAt,
  };
}

describe('implicitRepetition', () => {
  it('gates Good and Hard below one, and uses the scaled full interval once at higher speeds', () => {
    const card = reviewCard(new Date('2026-01-01T12:00:00.000Z'), now);
    for (const rating of [Rating.Good, Rating.Hard]) {
      const input = { weight: 0.4, rating, now, timeZone, enableFuzz: false };
      expect(implicitRepetition(card, { ...input, speed: 0.99 })).toBeUndefined();
      expect(implicitRepetition(card, { ...input, speed: 1 })).toBeDefined();
      const full = scheduleReview(card.fsrs, now, rating, timeZone, false, 1.5).card;
      const scaled = implicitRepetition(card, { ...input, speed: 1.5 });
      expect(scaled?.dueAt).toEqual(new Date(+now + 0.4 * (+full.due - +now)));
    }
  });

  it('keeps Again penalties for a slow target', () => {
    const card = reviewCard(new Date('2026-01-01T12:00:00.000Z'), new Date('2026-02-10T12:00:00Z'));
    const input = { weight: 0.4, rating: Rating.Again, now, timeZone, enableFuzz: false };
    const slow = implicitRepetition(card, { ...input, speed: 0.99 });
    expect(slow).toBeDefined();
    expect(slow).toEqual(implicitRepetition(card, { ...input, speed: 1 }));
  });
  it('interpolates all weights while preserving implicit-review state at weight one', () => {
    const card = reviewCard(new Date('2026-01-01T12:00:00.000Z'), now);
    const full = scheduleReview(card.fsrs, now, Rating.Good, timeZone, false).card;
    const result = implicitRepetition(card, {
      weight: 1,
      rating: Rating.Good,
      now,
      timeZone,
      enableFuzz: false,
    });

    if (!result) throw new Error('Expected implicit repetition result');
    expect(result.dueAt).toEqual(full.due);
    expect(result.fsrs.due).toEqual(full.due);
    expect(result.fsrs.stability).toBe(full.stability);
    expect(result.fsrs.difficulty).toBe(full.difficulty);
    expect(result.fsrs).toMatchObject({
      state: card.fsrs.state,
      reps: card.fsrs.reps,
      lapses: card.fsrs.lapses,
      last_review: card.fsrs.last_review,
    });
    expect((result.fsrs as typeof card.fsrs).elapsed_days).toBe(card.fsrs.elapsed_days);
    expect(result.fsrs.scheduled_days).toBe(card.fsrs.scheduled_days);
  });

  it('interpolates stability, difficulty, and due at fractional weight', () => {
    const card = reviewCard(new Date('2026-01-01T12:00:00.000Z'), now);
    const full = scheduleReview(card.fsrs, now, Rating.Good, timeZone, false).card;
    const result = implicitRepetition(card, {
      weight: 0.5,
      rating: Rating.Good,
      now,
      timeZone,
      enableFuzz: false,
    });

    expect(result).toBeDefined();
    expect(result?.fsrs.stability).toBeCloseTo(
      card.fsrs.stability + 0.5 * (full.stability - card.fsrs.stability),
    );
    expect(result?.fsrs.difficulty).toBeCloseTo(
      card.fsrs.difficulty + 0.5 * (full.difficulty - card.fsrs.difficulty),
    );
    expect(result?.dueAt.getTime()).toBe(
      card.dueAt.getTime() + 0.5 * (full.due.getTime() - card.dueAt.getTime()),
    );
    expect(result?.fsrs).toMatchObject({
      state: card.fsrs.state,
      last_review: card.fsrs.last_review,
      reps: card.fsrs.reps,
      lapses: card.fsrs.lapses,
    });
  });

  it('does not move a passed repetition earlier', () => {
    const card = reviewCard(
      new Date('2026-01-01T12:00:00.000Z'),
      new Date('2026-05-01T12:00:00.000Z'),
    );

    expect(
      implicitRepetition(card, {
        weight: 0.5,
        rating: Rating.Good,
        now,
        timeZone,
        enableFuzz: false,
      }),
    ).toBeUndefined();
  });

  it('interpolates a fractional positive repetition without flooring it to tomorrow', () => {
    const card = reviewCard(new Date('2026-01-14T12:00:00.000Z'), now);
    const result = implicitRepetition(card, {
      weight: 0.01,
      rating: Rating.Good,
      now,
      timeZone,
      enableFuzz: false,
    });

    expect(result).toBeDefined();
    expect(result?.dueAt.getTime()).toBeGreaterThan(now.getTime());
    expect(result?.dueAt.getTime()).toBeLessThan(new Date('2026-01-16T00:00:00.000Z').getTime());
  });

  it('does not move a failed repetition later or before the Again due date', () => {
    const localNow = new Date('2026-01-15T20:00:00.000Z');
    const localTimeZone = 'America/Los_Angeles';
    const card = reviewCard(
      new Date('2026-01-01T12:00:00.000Z'),
      new Date('2026-01-25T12:00:00.000Z'),
    );
    const result = implicitRepetition(card, {
      weight: 0.5,
      rating: Rating.Again,
      now: localNow,
      timeZone: localTimeZone,
      enableFuzz: false,
    });

    expect(result).toBeDefined();
    expect(result?.dueAt.getTime()).toBeLessThan(card.dueAt.getTime());
    const full = scheduleReview(card.fsrs, localNow, Rating.Again, localTimeZone, false).card;
    expect(result?.dueAt.getTime()).toBeGreaterThanOrEqual(full.due.getTime());
  });

  it('skips repetitions whose due date change is smaller than timestamp precision', () => {
    const card = reviewCard(new Date('2026-01-01T12:00:00.000Z'), now);
    expect(
      implicitRepetition(card, {
        weight: Number.EPSILON,
        rating: Rating.Good,
        now,
        timeZone,
        enableFuzz: false,
      }),
    ).toBeUndefined();
  });

  it('skips new cards', () => {
    const fsrs = newReviewCard(now);
    expect(
      implicitRepetition(
        { fsrs, dueAt: fsrs.due },
        { weight: 1, rating: Rating.Good, now, timeZone, enableFuzz: false },
      ),
    ).toBeUndefined();
  });

  it('skips cards last reviewed after the requested time', () => {
    const lastReview = new Date(now.getTime() + 2 * 86_400_000);
    const card = reviewCard(lastReview, new Date(now.getTime() + 3 * 86_400_000));
    Reflect.set(card.fsrs, 'last_review', lastReview.toISOString());

    expect(
      implicitRepetition(card, {
        weight: 0.5,
        rating: Rating.Good,
        now,
        timeZone,
        enableFuzz: false,
      }),
    ).toBeUndefined();
  });

  it('discounts repetitions completed early through FSRS scheduling', () => {
    const early = reviewCard(
      new Date('2026-01-14T12:00:00.000Z'),
      new Date('2026-01-25T12:00:00.000Z'),
    );
    const nearDue = reviewCard(
      new Date('2026-01-05T12:00:00.000Z'),
      new Date('2026-01-16T12:00:00.000Z'),
    );
    const earlyResult = implicitRepetition(early, {
      weight: 0.5,
      rating: Rating.Good,
      now,
      timeZone,
      enableFuzz: false,
    });
    const nearDueResult = implicitRepetition(nearDue, {
      weight: 0.5,
      rating: Rating.Good,
      now,
      timeZone,
      enableFuzz: false,
    });

    expect(earlyResult).toBeDefined();
    expect(nearDueResult).toBeDefined();
    expect(earlyResult?.fsrs.stability).toBeLessThan(nearDueResult?.fsrs.stability ?? 0);
  });
});
