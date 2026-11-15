import { describe, expect, it } from 'vitest';
import { rubricFeedbackWithScoredFlags } from './rubric-score.js';

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
