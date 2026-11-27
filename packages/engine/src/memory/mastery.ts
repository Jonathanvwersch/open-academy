import type { Dimension } from '../course/schemas.js';
import {
  initialMastery,
  type MasteryAttemptEvidence,
  type MasteryAttemptInput,
  type MasteryEvent,
  type MasteryRecord,
  type MasteryState,
  type MasteryTransition,
  masteryRank,
} from './types.js';

const hintCredit = [1, 0.7, 0.5, 0.3, 0.1, 0.1] as const;

export interface MasteryModel {
  applyAttempt(
    previous: MasteryRecord | undefined,
    input: MasteryAttemptInput,
    now: Date,
    options?: { remediationOpen?: boolean; remediationResolved?: boolean },
  ): MasteryTransition;
}

export function calculateCredit(
  input: Pick<MasteryAttemptInput, 'correct' | 'hintsUsed' | 'attemptNo' | 'gradedBy' | 'followUp'>,
): number {
  if (input.correct <= 0 || input.followUp) {
    return 0;
  }
  const hintMultiplier = hintCredit[Math.min(5, Math.max(0, input.hintsUsed))] ?? 0.1;
  const retryMultiplier = input.attemptNo === 2 ? 0.5 : 1;
  const gradedCredit = input.correct * hintMultiplier * retryMultiplier;
  return input.gradedBy === 'llm' || input.gradedBy === 'self'
    ? Math.min(0.5, gradedCredit)
    : gradedCredit;
}

export class DefaultMasteryModel implements MasteryModel {
  applyAttempt(
    previous: MasteryRecord | undefined,
    input: MasteryAttemptInput,
    now: Date,
    options: { remediationOpen?: boolean; remediationResolved?: boolean } = {},
  ): MasteryTransition {
    const existing = previous ?? initialMastery(input.conceptId, input.dimension);
    const credit = calculateCredit(input);
    const nowIso = now.toISOString();
    const independent =
      input.hintsUsed === 0 && input.attemptNo === 1 && input.gradedBy === 'deterministic';
    const evidence: MasteryAttemptEvidence = {
      attemptId: input.attemptId,
      exerciseId: input.exerciseId,
      correct: input.correct,
      credit,
      hintsUsed: input.hintsUsed,
      attemptNo: input.attemptNo,
      mode: input.mode,
      itemRole: input.itemRole,
      gradedBy: input.gradedBy,
      independent,
      createdAt: nowIso,
    };
    const attempts = [...existing.attempts, evidence].slice(-100);
    const independentAttempts = attempts.filter(
      (attempt) => attempt.independent && attempt.correct === 1,
    );
    const independentItemIds = [
      ...new Set(independentAttempts.map((attempt) => attempt.exerciseId)),
    ];
    const independentDeterministicCount = independentAttempts.filter(
      (attempt) => attempt.gradedBy === 'deterministic',
    ).length;
    let state = existing.state;
    let provisional = existing.provisional;
    let lastIndependentCorrect = existing.lastIndependentCorrect;
    let firstIndependentAt = existing.firstIndependentAt;
    let lastIndependentAt = existing.lastIndependentAt;
    let rule: string | undefined;
    if (state === 'not_assessed') {
      state = 'introduced';
      rule = 'attempt_introduced';
    }

    if (independent && input.correct === 1) {
      firstIndependentAt ??= nowIso;
      lastIndependentAt = nowIso;
      lastIndependentCorrect = true;
      if (input.mode === 'diagnostic' && independentItemIds.length === 1) {
        state = 'independent';
        provisional = true;
        rule = 'placement_provisional_independent';
      } else if (
        independentItemIds.length >= 2 &&
        independentDeterministicCount >= 1 &&
        lastIndependentCorrect
      ) {
        if (state !== 'retained') {
          state = 'independent';
        }
        provisional = false;
        rule = 'two_distinct_independent_items';
        if (daysBetween(firstIndependentAt, now) >= 3) {
          state = 'retained';
          rule = 'delayed_recall_retained';
        }
      } else if (masteryRank(state) < masteryRank('assisted')) {
        state = 'assisted';
        provisional = false;
        rule = 'independent_correct_assisted';
      }
    } else if (independent && input.correct === 0) {
      lastIndependentCorrect = false;
      if (masteryRank(state) >= masteryRank('independent')) {
        state = provisional ? 'introduced' : state === 'retained' ? 'independent' : 'assisted';
        provisional = false;
        rule = 'independent_failure_demotion';
      }
    }

    if (!(independent && input.correct === 1) && !(independent && input.correct === 0)) {
      if (credit >= 0.3 && masteryRank(state) < masteryRank('assisted')) {
        state = 'assisted';
        rule = 'assisted_credit_threshold';
      }
    }

    const mastery: MasteryRecord = {
      ...existing,
      state,
      provisional,
      inferred: false,
      independentItemIds,
      independentDeterministicCount,
      lastIndependentCorrect,
      lastAssessedAt: nowIso,
      lastIndependentAt,
      firstIndependentAt,
      attempts,
    };
    const event =
      state !== existing.state || provisional !== existing.provisional || existing.inferred
        ? createEvent(existing, state, rule ?? 'mastery_evidence_updated', input.attemptId, nowIso)
        : undefined;

    const failureReason = remediationReason(attempts);
    const remediationFlagOpen = options.remediationResolved
      ? false
      : Boolean(options.remediationOpen || failureReason);
    return {
      mastery,
      credit,
      event,
      remediationFlagOpen,
      ...(remediationFlagOpen && failureReason ? { remediationReason: failureReason } : {}),
    };
  }
}

export function recordLessonViewed(
  previous: MasteryRecord | undefined,
  conceptId: string,
  dimension: Dimension,
  now: Date,
): { mastery: MasteryRecord; event?: MasteryEvent } {
  const existing = previous ?? initialMastery(conceptId, dimension);
  if (masteryRank(existing.state) >= masteryRank('introduced')) {
    return { mastery: existing };
  }
  const mastery: MasteryRecord = {
    ...existing,
    state: 'introduced',
    lastAssessedAt: now.toISOString(),
  };
  return {
    mastery,
    event: createEvent(existing, 'introduced', 'lesson_viewed', undefined, now.toISOString()),
  };
}

function remediationReason(
  attempts: MasteryAttemptEvidence[],
): 'independent_failure_streak' | 'recent_failure_count' | undefined {
  let failureStreak = 0;
  for (const attempt of [...attempts].reverse()) {
    if (!attempt.independent) {
      continue;
    }
    if (attempt.correct === 0) {
      failureStreak += 1;
    } else {
      break;
    }
  }
  if (failureStreak >= 2) {
    return 'independent_failure_streak';
  }
  const lastFiveFailures = attempts.slice(-5).filter((attempt) => attempt.correct === 0).length;
  return lastFiveFailures >= 3 ? 'recent_failure_count' : undefined;
}

function createEvent(
  existing: MasteryRecord,
  state: MasteryState,
  rule: string,
  attemptId: string | undefined,
  createdAt: string,
): MasteryEvent {
  return {
    conceptId: existing.conceptId,
    dimension: existing.dimension,
    fromState: existing.state,
    toState: state,
    ...(attemptId ? { attemptId } : {}),
    rule,
    createdAt,
  };
}

function daysBetween(first: string, now: Date): number {
  return (now.getTime() - Date.parse(first)) / 86_400_000;
}
