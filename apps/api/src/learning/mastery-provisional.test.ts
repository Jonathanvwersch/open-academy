import { DefaultMasteryModel } from '@open-academy/engine/memory/mastery';
import { initialMastery } from '@open-academy/engine/memory/types';
import { expect, test } from 'vitest';

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

test('a successful independent review clears provisional placement mastery', () => {
  const model = new DefaultMasteryModel();
  const placed = model.applyAttempt(
    undefined,
    {
      conceptId: 'topic',
      dimension: 'math',
      attemptId: 'placement-1',
      exerciseId: 'placement-item',
      correct: 1,
      hintsUsed: 0,
      attemptNo: 1,
      mode: 'diagnostic',
      itemRole: 'diagnostic',
      gradedBy: 'deterministic',
    },
    now,
  );
  const reviewed = model.applyAttempt(
    placed.mastery,
    {
      conceptId: 'topic',
      dimension: 'math',
      attemptId: 'review-1',
      exerciseId: 'review-item',
      correct: 1,
      hintsUsed: 0,
      attemptNo: 1,
      mode: 'review',
      itemRole: 'review',
      gradedBy: 'deterministic',
    },
    now,
  );

  expect(reviewed.mastery).toMatchObject({ state: 'independent', provisional: false });
  expect(reviewed.event?.rule).toBe('two_distinct_independent_items');
});

test('a failed independent check preserves non-provisional demotion behavior', () => {
  expect(failure(false).mastery.state).toBe('assisted');
});
