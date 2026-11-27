import { expect, test } from 'vitest';
import { DefaultMasteryModel } from './mastery.js';
import { rebuildMasteryFromEvidence } from './mastery-rebuild.js';
import { initialMastery } from './types.js';

test('replaying the same evidence reproduces the mastery state', () => {
  const model = new DefaultMasteryModel();
  let record = initialMastery('a', 'math');
  const attempts = [
    { id: 'l1', exerciseId: 'e1', mode: 'practice' as const, minute: 1 },
    { id: 'r1', exerciseId: 'e2', mode: 'review' as const, minute: 2 },
    { id: 'r2', exerciseId: 'e3', mode: 'review' as const, minute: 3 },
  ];
  for (const attempt of attempts) {
    record = model.applyAttempt(
      record,
      {
        conceptId: 'a',
        dimension: 'math',
        attemptId: attempt.id,
        exerciseId: attempt.exerciseId,
        correct: 1,
        hintsUsed: 0,
        attemptNo: 1,
        mode: attempt.mode,
        itemRole: 'core',
        gradedBy: 'deterministic',
      },
      new Date(Date.UTC(2026, 0, 1, 0, attempt.minute)),
    ).mastery;
  }
  const rebuilt = rebuildMasteryFromEvidence('a', 'math', [...record.attempts].reverse());
  expect(rebuilt.state).toBe(record.state);
  expect(rebuilt.independentItemIds).toEqual(record.independentItemIds);
  expect(rebuilt.attempts).toEqual(record.attempts);
});

test('an empty history rebuilds to the initial record', () => {
  expect(rebuildMasteryFromEvidence('a', 'math', [])).toEqual(initialMastery('a', 'math'));
});
