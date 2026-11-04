import type { Dimension } from '../content/schemas.js';
import type { MasteryEvent, MasteryRecord } from './types.js';

export interface DebtAttempt {
  conceptId: string;
  dimension: Dimension;
  correct: number;
  hintsUsed: number;
}

export interface OpenRemediationFlag {
  conceptId: string;
  targetPrereqId?: string;
}

export interface LabFailure {
  conceptIds: string[];
  projectId: string;
}

export interface LearningDebt {
  conceptId: string;
  dimension: Dimension;
  reason:
    | 'implementation_below_assisted'
    | 'mastery_demotion'
    | 'assisted_after_four_attempts'
    | 'high_hint_dependence'
    | 'open_remediation'
    | 'lab_test_failure';
  remediationAction: string;
}

export function deriveLearningDebt(input: {
  mastery: MasteryRecord[];
  events: MasteryEvent[];
  attempts: DebtAttempt[];
  remediationFlags: OpenRemediationFlag[];
  labFailures?: LabFailure[];
}): LearningDebt[] {
  const debt = new Map<string, LearningDebt>();
  const add = (entry: LearningDebt) => {
    debt.set(`${entry.conceptId}:${entry.dimension}:${entry.reason}`, entry);
  };
  const recordsByConcept = groupBy(input.mastery, (record) => record.conceptId);
  const attemptsByKey = groupBy(
    input.attempts,
    (attempt) => `${attempt.conceptId}:${attempt.dimension}`,
  );

  for (const [conceptId, records] of recordsByConcept) {
    const conceptual = records.find((record) => record.dimension === 'conceptual');
    const implementation = records.find((record) => record.dimension === 'implementation');
    if (
      conceptual &&
      implementation &&
      rank(conceptual.state) >= rank('independent') &&
      rank(implementation.state) < rank('assisted')
    ) {
      add({
        conceptId,
        dimension: 'implementation',
        reason: 'implementation_below_assisted',
        remediationAction: 'Complete an implementation exercise for this concept.',
      });
    }
  }

  for (const event of input.events) {
    if (
      (event.fromState === 'independent' || event.fromState === 'retained') &&
      rank(event.toState) < rank(event.fromState)
    ) {
      add({
        conceptId: event.conceptId,
        dimension: event.dimension,
        reason: 'mastery_demotion',
        remediationAction: 'Revisit the concept and complete a fresh independent item.',
      });
    }
  }

  for (const record of input.mastery) {
    const attempts = attemptsByKey.get(`${record.conceptId}:${record.dimension}`) ?? [];
    if (record.state === 'assisted' && attempts.length >= 4) {
      add({
        conceptId: record.conceptId,
        dimension: record.dimension,
        reason: 'assisted_after_four_attempts',
        remediationAction: 'Use a targeted explanation, then retry a different item.',
      });
    }
  }

  for (const [key, attempts] of attemptsByKey) {
    const lastThreeCorrect = attempts.filter((attempt) => attempt.correct > 0).slice(-3);
    if (
      lastThreeCorrect.length === 3 &&
      lastThreeCorrect.reduce((sum, attempt) => sum + attempt.hintsUsed, 0) / 3 >= 2
    ) {
      const [conceptId, dimension] = key.split(':') as [string, Dimension];
      add({
        conceptId,
        dimension,
        reason: 'high_hint_dependence',
        remediationAction: 'Practice the next item without hints, then request help only if stuck.',
      });
    }
  }

  for (const flag of input.remediationFlags) {
    const record = recordsByConcept.get(flag.conceptId)?.[0];
    if (record) {
      add({
        conceptId: flag.conceptId,
        dimension: record.dimension,
        reason: 'open_remediation',
        remediationAction: `Remediate ${flag.targetPrereqId ?? flag.conceptId} before continuing.`,
      });
    }
  }

  for (const failure of input.labFailures ?? []) {
    for (const conceptId of failure.conceptIds) {
      const implementation = recordsByConcept
        .get(conceptId)
        ?.find((record) => record.dimension === 'implementation');
      if (implementation) {
        add({
          conceptId,
          dimension: 'implementation',
          reason: 'lab_test_failure',
          remediationAction: `Fix the failing ${failure.projectId} test and retry the linked task.`,
        });
      }
    }
  }
  return [...debt.values()];
}

function groupBy<Value>(values: Value[], getKey: (value: Value) => string): Map<string, Value[]> {
  const result = new Map<string, Value[]>();
  for (const value of values) {
    const key = getKey(value);
    result.set(key, [...(result.get(key) ?? []), value]);
  }
  return result;
}

function rank(state: MasteryRecord['state']): number {
  return ['not_assessed', 'introduced', 'assisted', 'independent', 'retained'].indexOf(state);
}
