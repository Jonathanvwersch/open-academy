import { describe, expect, test } from 'vitest';
import type { ContentIndex } from '../course/types.js';
import { DefaultMasteryModel } from '../memory/mastery.js';
import { initialMastery, type MasteryRecord } from '../memory/types.js';
import {
  capWithdrawnMastery,
  classifyPlacementGrants,
  conditionalPrerequisites,
  currentPlacementCredit,
  effectiveGrantStates,
  grantAnswerDecision,
  masteryAfterWithdrawal,
  planWithdrawal,
  withdrawnPlacementCredit,
} from './grants.js';

// a <- b <- c <- d, and a <- e (hard), b <- f (soft)
function graph(): ContentIndex {
  const prereqs: Record<string, Array<{ id: string; strength: 'hard' | 'soft' }>> = {
    a: [],
    b: [{ id: 'a', strength: 'hard' }],
    c: [{ id: 'b', strength: 'hard' }],
    d: [{ id: 'c', strength: 'hard' }],
    e: [{ id: 'a', strength: 'hard' }],
    f: [{ id: 'b', strength: 'soft' }],
  };
  const concepts = Object.entries(prereqs).map(([id, list]) => ({ id, prereqs: list }));
  return {
    conceptsById: new Map(concepts.map((concept) => [concept.id, concept])),
  } as unknown as ContentIndex;
}

describe('classifyPlacementGrants', () => {
  test('confirms a direct, on-time, conflict-free correct answer', () => {
    const [grant] = classifyPlacementGrants({
      known: ['b'],
      answers: [
        { conceptId: 'b', attemptId: 'x1', correct: true, durationMs: 5000, targetSeconds: 60 },
      ],
      content: graph(),
    });
    expect(grant).toEqual({
      conceptId: 'b',
      origin: 'direct',
      state: 'confirmed',
      reason: 'on_time',
      evidenceAttemptIds: ['x1'],
    });
  });

  test('treats inferred-only credit as conditional', () => {
    const grants = classifyPlacementGrants({
      known: ['a', 'b'],
      answers: [{ conceptId: 'b', attemptId: 'x1', correct: true }],
      content: graph(),
    });
    expect(grants.find((grant) => grant.conceptId === 'a')).toMatchObject({
      origin: 'inferred',
      state: 'conditional',
      reason: 'inferred_only',
      evidenceAttemptIds: [],
    });
  });

  test('treats a correct answer slower than the target time as conditional', () => {
    const [grant] = classifyPlacementGrants({
      known: ['b'],
      answers: [
        { conceptId: 'b', attemptId: 'x1', correct: true, durationMs: 61_000, targetSeconds: 60 },
      ],
      content: graph(),
    });
    expect(grant).toMatchObject({ state: 'conditional', reason: 'slow' });
  });

  test('does not call an answer slow without a target time', () => {
    const [grant] = classifyPlacementGrants({
      known: ['b'],
      answers: [{ conceptId: 'b', attemptId: 'x1', correct: true, durationMs: 999_000 }],
      content: graph(),
    });
    expect(grant).toMatchObject({ state: 'confirmed' });
  });

  test('treats credit as conflicting when one of its own prerequisites was missed', () => {
    const [grant] = classifyPlacementGrants({
      known: ['c'],
      answers: [
        { conceptId: 'a', attemptId: 'x0', correct: false },
        { conceptId: 'c', attemptId: 'x1', correct: true },
      ],
      content: graph(),
    });
    expect(grant).toMatchObject({ origin: 'direct', state: 'conditional', reason: 'conflicting' });
  });

  test('ignores missed answers that are not prerequisites', () => {
    const [grant] = classifyPlacementGrants({
      known: ['e'],
      answers: [
        { conceptId: 'd', attemptId: 'x0', correct: false },
        { conceptId: 'e', attemptId: 'x1', correct: true },
      ],
      content: graph(),
    });
    expect(grant).toMatchObject({ state: 'confirmed' });
  });
});

describe('grantAnswerDecision', () => {
  test('confirms a conditional grant after one later independent correct answer', () => {
    expect(grantAnswerDecision('conditional', { independent: true, correct: true })).toBe(
      'confirm',
    );
  });

  test('withdraws a conditional grant after a direct independent wrong answer', () => {
    expect(grantAnswerDecision('conditional', { independent: true, correct: false })).toBe(
      'withdraw',
    );
  });

  test('ignores assisted answers and non-conditional grants', () => {
    expect(grantAnswerDecision('conditional', { independent: false, correct: false })).toBe('none');
    expect(grantAnswerDecision('confirmed', { independent: true, correct: false })).toBe('none');
    expect(grantAnswerDecision('withdrawn', { independent: true, correct: true })).toBe('none');
    expect(grantAnswerDecision(undefined, { independent: true, correct: false })).toBe('none');
  });
});

describe('planWithdrawal', () => {
  const states = new Map([
    ['a', 'conditional' as const],
    ['b', 'conditional' as const],
    ['c', 'confirmed' as const],
    ['d', 'conditional' as const],
    ['e', 'conditional' as const],
    ['f', 'conditional' as const],
  ]);

  test('cascades to conditional hard dependents and skips confirmed and studied topics', () => {
    expect(
      planWithdrawal({
        failedConceptId: 'a',
        grantStates: states,
        studiedConceptIds: new Set(['e']),
        content: graph(),
      }),
    ).toEqual([
      { conceptId: 'a', reason: 'direct_failure' },
      { conceptId: 'b', reason: 'cascade' },
      { conceptId: 'd', reason: 'cascade' },
    ]);
  });

  test('never withdraws a confirmed or studied topic', () => {
    for (const [failedConceptId, studied] of [
      ['c', new Set<string>()],
      ['b', new Set(['b'])],
    ] as const) {
      expect(
        planWithdrawal({
          failedConceptId,
          grantStates: states,
          studiedConceptIds: studied,
          content: graph(),
        }),
      ).toEqual([]);
    }
  });

  test('a repeated failure on a withdrawn topic changes nothing', () => {
    expect(
      planWithdrawal({
        failedConceptId: 'a',
        grantStates: new Map([['a', 'withdrawn' as const]]),
        studiedConceptIds: new Set(),
        content: graph(),
      }),
    ).toEqual([]);
  });
});

describe('grant state views', () => {
  const grants = [
    { conceptId: 'a', state: 'confirmed' as const, createdAt: '2026-01-01T00:00:00Z' },
    { conceptId: 'a', state: 'withdrawn' as const, createdAt: '2026-02-01T00:00:00Z' },
    { conceptId: 'b', state: 'withdrawn' as const, createdAt: '2026-01-01T00:00:00Z' },
    { conceptId: 'b', state: 'conditional' as const, createdAt: '2026-03-01T00:00:00Z' },
  ];

  test('uses the latest grant per topic as current credit', () => {
    expect(effectiveGrantStates(grants)).toEqual(
      new Map([
        ['a', 'withdrawn'],
        ['b', 'conditional'],
      ]),
    );
    expect(currentPlacementCredit(grants)).toEqual(new Set(['b']));
    expect(withdrawnPlacementCredit(grants)).toEqual(new Set(['a']));
  });

  test('picks only conditional key prerequisites for a targeted review', () => {
    expect(
      conditionalPrerequisites(
        ['a', 'b', 'c', 'a'],
        new Map([
          ['a', 'conditional'],
          ['b', 'confirmed'],
        ]),
      ),
    ).toEqual(['a']);
  });
});

describe('masteryAfterWithdrawal', () => {
  const model = new DefaultMasteryModel();
  const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute));

  function apply(
    record: MasteryRecord,
    attemptId: string,
    correct: number,
    mode: 'diagnostic' | 'review',
    minute: number,
  ) {
    return model.applyAttempt(
      record,
      {
        conceptId: 'a',
        dimension: 'math',
        attemptId,
        exerciseId: `ex-${attemptId}`,
        correct,
        hintsUsed: 0,
        attemptNo: 1,
        mode,
        itemRole: 'core',
        gradedBy: 'deterministic',
      },
      at(minute),
    ).mastery;
  }

  test('rebuilds from surviving evidence and leaves no credit behind', () => {
    let record = apply(initialMastery('a', 'math'), 'p1', 1, 'diagnostic', 1);
    expect(record).toMatchObject({ state: 'independent', provisional: true });
    record = { ...record, state: 'independent', provisional: true };
    const rebuilt = masteryAfterWithdrawal(record, new Set(['p1']), at(10));
    expect(rebuilt).toMatchObject({
      state: 'not_assessed',
      provisional: false,
      inferred: false,
      independentItemIds: [],
      attempts: [],
    });
  });

  test('keeps surviving non-placement evidence but caps it below learned', () => {
    let record = apply(initialMastery('a', 'math'), 'p1', 1, 'diagnostic', 1);
    record = apply(record, 'r1', 0, 'review', 5);
    const rebuilt = masteryAfterWithdrawal(record, new Set(['p1']), at(10));
    expect(rebuilt.attempts.map((attempt) => attempt.attemptId)).toEqual(['r1']);
    expect(rebuilt.state).toBe('introduced');
    expect(rebuilt.lastAssessedAt).toBe(at(10).toISOString());
  });
});

describe('capWithdrawnMastery', () => {
  test('caps learned or inferred credit and leaves weaker records alone', () => {
    const record = initialMastery('a', 'math');
    expect(capWithdrawnMastery(record)).toBeNull();
    expect(capWithdrawnMastery({ ...record, state: 'introduced' })).toBeNull();
    expect(capWithdrawnMastery({ ...record, state: 'assisted' })).toMatchObject({
      state: 'introduced',
      inferred: false,
    });
    expect(capWithdrawnMastery({ ...record, inferred: true })).toMatchObject({
      state: 'not_assessed',
      inferred: false,
    });
  });
});
