import { describe, expect, it } from 'vitest';
import { dailyStudyMinutes, sessionBudget } from './session-budget.js';
import { estimatedFinishDate, weekXp } from './xp.js';

describe('daily study goals', () => {
  it('preserves existing weekday and weekend preferences', () => {
    expect(
      dailyStudyMinutes({ scheduleMinutes: 30, saturdayMinutes: 45, sundayMinutes: 75 }),
    ).toEqual({
      monday: 30,
      tuesday: 30,
      wednesday: 30,
      thursday: 30,
      friday: 30,
      saturday: 45,
      sunday: 75,
    });
  });

  it('uses each day for session planning, progress goals and finish estimates', () => {
    const dailyMinutes = {
      monday: 10,
      tuesday: 20,
      wednesday: 30,
      thursday: 40,
      friday: 50,
      saturday: 60,
      sunday: 70,
    };
    const prefs = { dailyMinutes, scheduleMinutes: 600 };
    const week = weekXp([], '2026-01-05', prefs);
    expect(week.map((day) => day.goal)).toEqual([10, 20, 30, 40, 50, 60, 70]);
    for (const day of week) {
      const kind =
        day.date === '2026-01-10' ? 'saturday' : day.date === '2026-01-11' ? 'sunday' : 'weekday';
      expect(sessionBudget(kind, prefs, day.date)).toBe(day.goal);
    }
    expect(estimatedFinishDate(7, 0, '2026-01-05', prefs)).toBe('2026-01-12');
  });
});
