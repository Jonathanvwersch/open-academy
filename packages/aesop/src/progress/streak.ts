import type { StreakPayload } from '@academy/aesop/api/progress';
import type { XpEventDate } from './xp.js';

// XP dates are recorded in the learner's timezone when the activity is completed.
export function buildStreak(events: readonly XpEventDate[], today: string): StreakPayload {
  const dates = [
    ...new Set(
      events
        .filter((event) => event.amount > 0 && event.localDate <= today)
        .map((event) => event.localDate),
    ),
  ].sort();
  const active = new Set(dates);
  const todayComplete = active.has(today);
  let cursor = todayComplete ? today : offsetDate(today, -1);
  let current = 0;
  while (active.has(cursor)) {
    current += 1;
    cursor = offsetDate(cursor, -1);
  }
  let longest = 0;
  let run = 0;
  let previous = '';
  for (const date of dates) {
    run = previous === offsetDate(date, -1) ? run + 1 : 1;
    longest = Math.max(longest, run);
    previous = date;
  }
  return {
    current,
    longest,
    todayComplete,
    days: Array.from({ length: 7 }, (_, index) => {
      const date = offsetDate(today, index - 6);
      return { date, complete: active.has(date) };
    }),
  };
}

function offsetDate(date: string, days: number): string {
  const result = new Date(`${date}T00:00:00.000Z`);
  result.setUTCDate(result.getUTCDate() + days);
  return result.toISOString().slice(0, 10);
}
