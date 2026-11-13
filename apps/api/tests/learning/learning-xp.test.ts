import { describe, expect, test } from 'vitest';
import {
  averageDailyXp,
  coursePercent,
  estimatedFinishDate,
  estimateTaskXp,
  localDateKey,
  weekXp,
  xpGoalFor,
} from '../../src/learning/xp.js';

describe('XP calculations', () => {
  test('uses the weekday, Saturday, and Sunday goals', () => {
    expect(xpGoalFor('2026-01-09')).toBe(60);
    expect(xpGoalFor('2026-01-10')).toBe(300);
    expect(xpGoalFor('2026-01-11')).toBe(60);
  });

  test('uses study preferences for weekday, Saturday, and Sunday goals', () => {
    const prefs = { scheduleMinutes: 30, saturdayMinutes: 45, sundayMinutes: 75 };
    expect(xpGoalFor('2026-01-09', prefs)).toBe(30);
    expect(xpGoalFor('2026-01-10', prefs)).toBe(45);
    expect(xpGoalFor('2026-01-11', prefs)).toBe(75);
  });

  test('buckets weekly XP by user-local dates from Monday through Sunday', () => {
    const buckets = weekXp(
      [
        { localDate: '2026-01-04', amount: 20 },
        { localDate: '2026-01-05', amount: 35 },
        { localDate: '2026-01-11', amount: 80 },
        { localDate: '2026-01-12', amount: 100 },
      ],
      '2026-01-07',
    );
    expect(buckets).toEqual([
      { date: '2026-01-05', xp: 35, goal: 60 },
      { date: '2026-01-06', xp: 0, goal: 60 },
      { date: '2026-01-07', xp: 0, goal: 60 },
      { date: '2026-01-08', xp: 0, goal: 60 },
      { date: '2026-01-09', xp: 0, goal: 60 },
      { date: '2026-01-10', xp: 0, goal: 300 },
      { date: '2026-01-11', xp: 80, goal: 60 },
    ]);
  });

  test('uses study preferences for each weekly goal', () => {
    const prefs = { scheduleMinutes: 30, saturdayMinutes: 45, sundayMinutes: 75 };
    expect(weekXp([], '2026-01-07', prefs).map((day) => day.goal)).toEqual([
      30, 30, 30, 30, 30, 45, 75,
    ]);
  });

  test('uses timezone-local dates at a UTC day boundary', () => {
    expect(localDateKey(new Date('2026-01-02T01:00:00.000Z'), 'America/Los_Angeles')).toBe(
      '2026-01-01',
    );
    expect(
      weekXp(
        [
          { localDate: '2026-01-01', amount: 10 },
          { localDate: '2026-01-02', amount: 20 },
        ],
        '2026-01-02',
      ).map((day) => day.xp),
    ).toEqual([0, 0, 0, 10, 20, 0, 0]);
  });

  test('estimates lesson XP from unpassed knowledge points and other XP from minutes', () => {
    expect(
      estimateTaskXp(
        { kind: 'learn', plannedMinutes: 30 },
        { points: [{ status: 'passed' }, { status: 'active' }, { status: 'locked' }] },
      ),
    ).toBe(20);
    expect(estimateTaskXp({ kind: 'practice', plannedMinutes: 12 })).toBe(12);
  });

  test('does not advertise XP for lab activities', () => {
    expect(estimateTaskXp({ kind: 'lab', plannedMinutes: 190 })).toBe(0);
  });

  test('does not advertise XP for optional paper suggestions', () => {
    expect(estimateTaskXp({ kind: 'paper', plannedMinutes: 90 })).toBe(0);
  });

  test('calculates course percentage and handles an empty course', () => {
    expect(coursePercent(1, 3)).toBe(33);
    expect(coursePercent(3, 3)).toBe(100);
    expect(coursePercent(0, 0)).toBe(0);
  });

  test('estimates finish using recent XP or the daily-goal average', () => {
    expect(estimatedFinishDate(2, 20, '2026-01-01')).toBe('2026-01-05');
    expect(estimatedFinishDate(1, 0, '2026-01-01')).toBe('2026-01-02');
    expect(
      estimatedFinishDate(1, 0, '2026-01-01', {
        scheduleMinutes: 30,
        saturdayMinutes: 45,
        sundayMinutes: 75,
      }),
    ).toBe('2026-01-03');
    expect(estimatedFinishDate(0, 0, '2026-01-01')).toBe('2026-01-01');
    expect(
      averageDailyXp(
        [
          { localDate: '2025-12-18', amount: 500 },
          { localDate: '2025-12-19', amount: 140 },
          { localDate: '2026-01-01', amount: 0 },
        ],
        '2026-01-01',
      ),
    ).toBe(10);
  });
});
