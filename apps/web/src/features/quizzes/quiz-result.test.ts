import { expect, test } from 'vitest';
import { completedReviewMessage } from './quiz-result.js';

test('explains why a slow-only original quiz has no retake', () => {
  expect(completedReviewMessage(false, 1)).toBe(
    'You reviewed the topic you answered slowly. You got every question right, so there is no retake. That topic stays in your normal reviews.',
  );
  expect(completedReviewMessage(false, 3)).toBe(
    'You reviewed all 3 topics you answered slowly. You got every question right, so there is no retake. These topics stay in your normal reviews.',
  );
});
