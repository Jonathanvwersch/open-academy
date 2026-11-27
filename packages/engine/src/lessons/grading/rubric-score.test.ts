import { describe, expect, it } from 'vitest';
import { rubricFeedbackWithScoredFlags, scoreRubricCriteria } from './rubric-score.js';

it('scores required criteria without optional points affecting the result', () => {
  const rubric = [
    { id: 'required', weight: 2, required: true },
    { id: 'second', weight: 2, required: true },
    { id: 'optional', weight: 6, required: false },
  ];
  expect(
    scoreRubricCriteria(
      rubric,
      new Map([
        ['required', 'met'],
        ['second', 'met'],
        ['optional', 'missing'],
      ]),
    ),
  ).toBe(1);
  expect(
    scoreRubricCriteria(
      rubric,
      new Map([
        ['required', 'partial'],
        ['second', 'met'],
        ['optional', 'met'],
      ]),
    ),
  ).toBe(0.75);
  expect(
    scoreRubricCriteria(
      [
        { id: 'a', weight: 1, required: false },
        { id: 'b', weight: 3, required: false },
      ],
      new Map([
        ['a', 'met'],
        ['b', 'partial'],
      ]),
    ),
  ).toBe(0.625);
  expect(
    scoreRubricCriteria(
      rubric,
      new Map([
        ['required', 'missing'],
        ['second', 'met'],
        ['optional', 'met'],
      ]),
    ),
  ).toBe(0);
});

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
