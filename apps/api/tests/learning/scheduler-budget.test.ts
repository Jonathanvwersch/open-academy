import { describe, expect, it } from 'vitest';
import { sessionBudget } from '../../src/learning/scheduler.js';

describe('sessionBudget', () => {
  it('uses configurable weekday and weekend defaults', () => {
    expect(sessionBudget('weekday')).toBe(60);
    expect(sessionBudget('saturday')).toBe(300);
    expect(sessionBudget('sunday')).toBe(60);
    expect(sessionBudget('weekday', { scheduleMinutes: 45 })).toBe(45);
    expect(sessionBudget('saturday', { saturdayMinutes: 240 })).toBe(240);
    expect(sessionBudget('sunday', { sundayMinutes: 75 })).toBe(75);
  });
});
