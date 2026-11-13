import { expect, test } from 'vitest';
import { isWeekOpen } from './week-open-state.js';

test('opens the current week and collapses other weeks by default', () => {
  expect(isWeekOpen(2, 2, {})).toBe(true);
  expect(isWeekOpen(1, 2, {})).toBe(false);
});

test('stored week state overrides the default', () => {
  expect(isWeekOpen(1, 2, { 1: true })).toBe(true);
  expect(isWeekOpen(2, 2, { 2: false })).toBe(false);
});
