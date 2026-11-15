import { expect, test } from 'vitest';
import { startOfLocalDay } from './service.js';

test.each([
  ['2026-01-02T02:00:00Z', 'America/Los_Angeles', '2026-01-01T08:00:00.000Z'],
  ['2026-09-06T12:00:00Z', 'America/Santiago', '2026-09-06T04:00:00.000Z'],
  ['2026-03-08T12:00:00Z', 'America/Havana', '2026-03-08T05:00:00.000Z'],
  ['2026-11-01T12:00:00Z', 'America/Havana', '2026-11-01T04:00:00.000Z'],
  ['2026-03-08T12:00:00Z', 'America/New_York', '2026-03-08T05:00:00.000Z'],
  ['2026-11-01T12:00:00Z', 'America/New_York', '2026-11-01T04:00:00.000Z'],
  ['2026-01-02T02:00:00Z', 'Asia/Kathmandu', '2026-01-01T18:15:00.000Z'],
  ['2026-01-02T00:00:00Z', 'UTC', '2026-01-02T00:00:00.000Z'],
])('finds the first real instant of the local day for %s in %s', (now, timeZone, expected) => {
  const start = startOfLocalDay(new Date(now), timeZone);
  expect(start.toISOString()).toBe(expected);
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone, dateStyle: 'short' });
  expect(formatter.format(start)).toBe(formatter.format(new Date(now)));
  expect(formatter.format(new Date(start.getTime() - 1))).not.toBe(formatter.format(start));
});
