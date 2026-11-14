import { expect, test } from 'vitest';
import { DefaultMasteryModel } from './mastery.js';
import { initialMastery } from './types.js';

const now = new Date('2025-01-01T12:00:00.000Z');

function failure(previousProvisional: boolean) {
  const previous = initialMastery('topic', 'math');
  previous.state = 'independent';
  previous.provisional = previousProvisional;
  return new DefaultMasteryModel().applyAttempt(
    previous,
    {
      conceptId: 'topic',
      dimension: 'math',
      attemptId: 'attempt-1',
      exerciseId: 'check-1',
      correct: 0,
      hintsUsed: 0,
      attemptNo: 1,
      mode: 'diagnostic',
      itemRole: 'check',
      gradedBy: 'deterministic',
    },
    now,
    { remediationOpen: false },
  );
}

test('a failed independent check demotes provisional placement mastery to introduced', () => {
  const result = failure(true);
  expect(result.mastery.state).toBe('introduced');
  expect(result.mastery.provisional).toBe(false);
  expect(result.event?.rule).toBe('independent_failure_demotion');
});

test('a failed independent check preserves non-provisional demotion behavior', () => {
  expect(failure(false).mastery.state).toBe('assisted');
});
