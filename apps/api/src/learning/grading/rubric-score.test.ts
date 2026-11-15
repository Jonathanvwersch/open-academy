import { describe, expect, it } from 'vitest';
import { rubricFeedbackWithScoredFlags, scoreRubricCriteria } from './rubric-score.js';

it('treats an omitted required judgement as missing even when another required criterion is met', () => {
  expect(
    scoreRubricCriteria(
      [
        { id: 'first', weight: 1, required: true },
        { id: 'second', weight: 1, required: true },
      ],
      new Map([['first', 'met']]),
    ),
  ).toBe(0);
});

describe('rubricFeedbackWithScoredFlags', () => {
  it('marks every criterion as scored when the rubric has no required criteria', () => {
    const result = rubricFeedbackWithScoredFlags(
      [
        { id: 'a', required: false },
        { id: 'b', required: false },
      ],
      [
        { id: 'a', required: false, judgement: 'missing' },
        { id: 'b', required: false, judgement: 'met' },
      ],
    );

    expect(result.map(({ required }) => required)).toEqual([true, true]);
  });
});
