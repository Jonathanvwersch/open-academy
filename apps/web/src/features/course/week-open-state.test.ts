import { expect, test } from 'vitest';
import { isUnitOpen } from './week-open-state.js';

test('opens the current unit and collapses other units by default', () => {
  expect(isUnitOpen('course', 2, 2, {})).toBe(true);
  expect(isUnitOpen('course', 1, 2, {})).toBe(false);
});

test('unit state is keyed by course and overrides the default', () => {
  expect(isUnitOpen('course', 1, 2, { 'course:1': true })).toBe(true);
  expect(isUnitOpen('other-course', 1, 1, { 'course:1': false })).toBe(true);
  expect(isUnitOpen('course', 2, 2, { 'course:2': false })).toBe(false);
});
