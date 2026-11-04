import type { Dimension } from '../content/schemas.js';

export type MasteryState = 'not_assessed' | 'introduced' | 'assisted' | 'independent' | 'retained';
export type LearningMode = 'practice' | 'assessment' | 'diagnostic' | 'review';
export type GradedBy = 'deterministic' | 'llm' | 'self';

export interface MasteryAttemptEvidence {
  attemptId: string;
  exerciseId: string;
  correct: number;
  credit: number;
  hintsUsed: number;
  attemptNo: number;
  mode: LearningMode;
  itemRole: 'core' | 'transfer' | 'review' | 'diagnostic' | 'check';
  gradedBy: GradedBy;
  independent: boolean;
  createdAt: string;
}

export interface MasteryRecord {
  conceptId: string;
  dimension: Dimension;
  state: MasteryState;
  provisional: boolean;
  inferred: boolean;
  independentItemIds: string[];
  independentDeterministicCount: number;
  lastIndependentCorrect: boolean;
  lastAssessedAt: string | null;
  lastIndependentAt: string | null;
  firstIndependentAt: string | null;
  attempts: MasteryAttemptEvidence[];
}

export interface MasteryAttemptInput {
  conceptId: string;
  dimension: Dimension;
  attemptId: string;
  exerciseId: string;
  correct: number;
  hintsUsed: number;
  attemptNo: number;
  mode: LearningMode;
  itemRole: MasteryAttemptEvidence['itemRole'];
  gradedBy: GradedBy;
}

export interface MasteryEvent {
  conceptId: string;
  dimension: Dimension;
  fromState: MasteryState;
  toState: MasteryState;
  attemptId?: string;
  rule: string;
  createdAt: string;
}

export interface MasteryTransition {
  mastery: MasteryRecord;
  credit: number;
  event?: MasteryEvent;
  remediationFlagOpen: boolean;
  remediationReason?: 'independent_failure_streak' | 'recent_failure_count';
}

export function initialMastery(conceptId: string, dimension: Dimension): MasteryRecord {
  return {
    conceptId,
    dimension,
    state: 'not_assessed',
    provisional: false,
    inferred: false,
    independentItemIds: [],
    independentDeterministicCount: 0,
    lastIndependentCorrect: false,
    lastAssessedAt: null,
    lastIndependentAt: null,
    firstIndependentAt: null,
    attempts: [],
  };
}

export function masteryRank(state: MasteryState): number {
  return ['not_assessed', 'introduced', 'assisted', 'independent', 'retained'].indexOf(state);
}
