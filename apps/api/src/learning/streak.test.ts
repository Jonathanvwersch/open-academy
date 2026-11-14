import { describe, expect, it } from 'vitest';
import { buildStreak } from './streak.js';
import { localDateKey } from './xp.js';

const events = (...dates: string[]) => dates.map((localDate) => ({ localDate, amount: 10 }));

describe('daily XP streaks', () => {
  it('starts empty and does not award credit for zero, negative or future XP', () => {
    const result = buildStreak(
      [
        { amount: 0, localDate: '2026-01-02' },
        { amount: -10, localDate: '2026-01-02' },
        { amount: 10, localDate: '2026-01-03' },
      ],
      '2026-01-02',
    );
    expect(result.current).toBe(0);
    expect(result.longest).toBe(0);
    expect(result.todayComplete).toBe(false);
    expect(result.days).toHaveLength(7);
    expect(result.days.every((day) => !day.complete)).toBe(true);
  });

  it('keeps yesterday’s streak alive until the end of today, then breaks it', () => {
    const earned = events('2025-12-30', '2025-12-31');
    expect(buildStreak(earned, '2026-01-01')).toMatchObject({
      current: 2,
      longest: 2,
      todayComplete: false,
    });
    expect(buildStreak(earned, '2026-01-02')).toMatchObject({ current: 0, longest: 2 });
  });

  it('deduplicates days, ignores event order, and preserves the best after restarting', () => {
    const earned = events('2026-01-04', '2026-01-01', '2025-12-31', '2026-01-01', '2026-01-02');
    const result = buildStreak(earned, '2026-01-04');
    expect(result).toMatchObject({ current: 1, longest: 3, todayComplete: true });
    expect(result.days.at(-1)).toEqual({ date: '2026-01-04', complete: true });
    expect(result.days.at(-2)).toEqual({ date: '2026-01-03', complete: false });
  });

  it('uses learner dates through DST and UTC midnight', () => {
    const earned = events('2026-03-07', '2026-03-08');
    const today = localDateKey(new Date('2026-03-09T06:30:00Z'), 'America/Los_Angeles');
    expect(today).toBe('2026-03-08');
    expect(buildStreak(earned, today)).toMatchObject({ current: 2, todayComplete: true });
    expect(buildStreak(earned, '2026-03-09').current).toBe(2);
  });

  it('counts leap days consecutively', () => {
    expect(
      buildStreak(events('2028-02-28', '2028-02-29', '2028-03-01'), '2028-03-01').current,
    ).toBe(3);
  });
});
