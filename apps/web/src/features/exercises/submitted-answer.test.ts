import { expect, test } from 'vitest';
import { prefillExerciseAnswer } from './submitted-answer.js';

test('prefills single- and multi-select quiz answers', () => {
  expect(prefillExerciseAnswer('mc', 'option-b')).toEqual({ selected: ['option-b'] });
  expect(prefillExerciseAnswer('mc', ['option-a', 'option-c'])).toEqual({
    selected: ['option-a', 'option-c'],
  });
});

test('prefills text-like quiz answers', () => {
  for (const exerciseType of ['numeric', 'expression', 'text', 'code_read', 'code_complete']) {
    expect(prefillExerciseAnswer(exerciseType, 'saved response')).toEqual({
      value: 'saved response',
    });
  }
  expect(prefillExerciseAnswer('numeric', 3.5)).toEqual({ value: '3.5' });
  expect(prefillExerciseAnswer('code_read', 7)).toEqual({ value: '7' });
});

test('prefills structured exercise answers', () => {
  expect(prefillExerciseAnswer('debug', { line: 4, fixId: 'fix-b' })).toEqual({
    line: '4',
    value: 'fix-b',
  });
  expect(
    prefillExerciseAnswer('explain', { text: 'saved explanation', metCriteria: ['a'] }),
  ).toEqual({ value: 'saved explanation' });
});
