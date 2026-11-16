import { Rating, State } from 'ts-fsrs';
import { describe, expect, it, vi } from 'vitest';
import { newReviewCard, scheduleReview, startOfNextCalendarDay } from './fsrs.js';
import { type LayeringCreditCard, layeringCredit } from './prerequisite-review.js';

vi.mock('./fsrs.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./fsrs.js')>();
  return { ...actual, scheduleReview: vi.fn(actual.scheduleReview) };
});

const timeZone = 'UTC';
const now = new Date('2026-01-15T12:00:00.000Z');
const dueYesterday = new Date('2026-01-14T12:00:00.000Z');

function card(dueAt: Date, lastReviewAt: Date | null = null, stability = 12): LayeringCreditCard {
  const lastReview = new Date('2025-12-01T12:00:00.000Z');
  return {
    id: 'card-id',
    dueAt,
    lastReviewAt,
    fsrs: {
      ...newReviewCard(lastReview),
      state: State.Review,
      stability,
      difficulty: 4,
      reps: 8,
      lapses: 2,
      last_review: lastReview,
      due: dueAt,
    },
  };
}

describe('layeringCredit', () => {
  it('moves an overdue card halfway to its Good interval and preserves its review state', () => {
    const input = card(dueYesterday);
    const goodDue = scheduleReview(input.fsrs, now, Rating.Good, timeZone, false).card.due;
    const expectedDue = new Date(now.getTime() + 0.5 * (goodDue.getTime() - now.getTime()));

    const result = layeringCredit(input, now, timeZone, false);

    expect(result?.dueAt).toEqual(expectedDue);
    expect(result?.dueAt.getTime()).toBeGreaterThan(input.dueAt.getTime());
    expect(result?.fsrs).toEqual({ ...input.fsrs, due: expectedDue });
    expect(input.fsrs.due).toEqual(dueYesterday);
  });

  it('ignores cards more than three days from due', () => {
    const dueInTenDays = new Date('2026-01-25T12:00:00.000Z');
    expect(layeringCredit(card(dueInTenDays), now, timeZone, false)).toBeUndefined();
  });

  it('ignores cards reviewed less than a day ago', () => {
    const reviewedTwoHoursAgo = new Date('2026-01-15T10:00:00.000Z');
    expect(
      layeringCredit(card(dueYesterday, reviewedTwoHoursAgo), now, timeZone, false),
    ).toBeUndefined();
  });

  it('clamps a half interval before the next local day', () => {
    const localTimeZone = 'America/Los_Angeles';
    const localNow = new Date('2026-01-15T12:00:00.000Z');
    const fsrs = newReviewCard(localNow);
    const nextLocalDay = startOfNextCalendarDay(localNow, localTimeZone);
    const goodDue = new Date(localNow.getTime() + 12 * 60 * 60 * 1000);
    const dueAt = new Date('2026-01-14T12:00:00.000Z');
    const halfInterval = new Date(
      localNow.getTime() + 0.5 * (goodDue.getTime() - localNow.getTime()),
    );
    vi.mocked(scheduleReview).mockReturnValueOnce({
      card: { ...fsrs, due: goodDue },
      log: {} as never,
    } as ReturnType<typeof scheduleReview>);

    expect(halfInterval.getTime()).toBeLessThan(nextLocalDay.getTime());
    expect(
      layeringCredit(
        { id: 'card-id', dueAt, lastReviewAt: null, fsrs: { ...fsrs, due: dueAt } },
        localNow,
        localTimeZone,
        false,
      )?.dueAt,
    ).toEqual(nextLocalDay);
  });

  it('does not return a new due date that is earlier than or equal to the current one', () => {
    const fsrs = newReviewCard(now);
    const goodDue = scheduleReview(fsrs, now, Rating.Good, timeZone, false).card.due;
    const halfInterval = new Date(now.getTime() + 0.5 * (goodDue.getTime() - now.getTime()));
    const nextLocalDay = startOfNextCalendarDay(now, timeZone);
    const dueAt = halfInterval < nextLocalDay ? nextLocalDay : halfInterval;
    expect(
      layeringCredit(
        { id: 'card-id', dueAt, lastReviewAt: null, fsrs: { ...fsrs, due: dueAt } },
        now,
        timeZone,
        false,
      ),
    ).toBeUndefined();
  });
});
