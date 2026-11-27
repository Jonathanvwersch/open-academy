import type { ContentIndex } from '../course/types.js';
import { isSlowCorrectAnswer } from '../memory/fsrs.js';
import { rebuildMasteryFromEvidence } from '../memory/mastery-rebuild.js';
import { type MasteryRecord, masteryRank } from '../memory/types.js';

export type PlacementGrantOrigin = 'direct' | 'inferred';
export type PlacementGrantState = 'conditional' | 'confirmed' | 'withdrawn';
export type PlacementGrantReason =
  | 'on_time'
  | 'inferred_only'
  | 'slow'
  | 'conflicting'
  | 'legacy_provisional'
  | 'legacy_confirmed'
  | 'confirmed_by_answer'
  | 'direct_failure'
  | 'cascade';

export interface PlacementGrantDraft {
  conceptId: string;
  origin: PlacementGrantOrigin;
  state: Exclude<PlacementGrantState, 'withdrawn'>;
  reason: PlacementGrantReason;
  evidenceAttemptIds: string[];
}

export interface PlacementAnswerEvidence {
  conceptId: string;
  /** Missing for answers recorded before attempts were linked to placement checks. */
  attemptId?: string;
  correct: boolean;
  durationMs?: number | null;
  targetSeconds?: number;
}

export interface PlacementGrantSnapshot {
  conceptId: string;
  state: PlacementGrantState;
  createdAt: string | Date;
}

export type PlacementGrantDecision = 'confirm' | 'withdraw' | 'none';

export function classifyPlacementGrants(input: {
  known: readonly string[];
  answers: readonly PlacementAnswerEvidence[];
  content: ContentIndex;
}): PlacementGrantDraft[] {
  const wrongConceptIds = new Set(
    input.answers.filter((answer) => !answer.correct).map((answer) => answer.conceptId),
  );
  return [...new Set(input.known)].map((conceptId) => {
    const correctAnswers = input.answers.filter(
      (answer) => answer.conceptId === conceptId && answer.correct,
    );
    const evidenceAttemptIds = correctAnswers.flatMap((answer) =>
      answer.attemptId ? [answer.attemptId] : [],
    );
    if (correctAnswers.length === 0) {
      return {
        conceptId,
        origin: 'inferred',
        state: 'conditional',
        reason: 'inferred_only',
        evidenceAttemptIds,
      };
    }
    const conflicting = hardAncestors(conceptId, input.content).some((ancestorId) =>
      wrongConceptIds.has(ancestorId),
    );
    if (conflicting) {
      return {
        conceptId,
        origin: 'direct',
        state: 'conditional',
        reason: 'conflicting',
        evidenceAttemptIds,
      };
    }
    const slow = correctAnswers.some((answer) =>
      isSlowCorrectAnswer({
        correct: 1,
        durationMs: answer.durationMs,
        targetSeconds: answer.targetSeconds,
      }),
    );
    return {
      conceptId,
      origin: 'direct',
      state: slow ? 'conditional' : 'confirmed',
      reason: slow ? 'slow' : 'on_time',
      evidenceAttemptIds,
    };
  });
}

export function grantAnswerDecision(
  state: PlacementGrantState | undefined,
  answer: { independent: boolean; correct: boolean },
): PlacementGrantDecision {
  if (state !== 'conditional' || !answer.independent) return 'none';
  return answer.correct ? 'confirm' : 'withdraw';
}

/** Any confirmed grant for a topic wins. Otherwise the latest grant decides. */
export function effectiveGrantStates(
  grants: readonly PlacementGrantSnapshot[],
): Map<string, PlacementGrantState> {
  const latest = new Map<string, PlacementGrantSnapshot>();
  const confirmed = new Set<string>();
  for (const grant of grants) {
    if (grant.state === 'confirmed') confirmed.add(grant.conceptId);
    const current = latest.get(grant.conceptId);
    if (!current || timeOf(grant.createdAt) >= timeOf(current.createdAt)) {
      latest.set(grant.conceptId, grant);
    }
  }
  return new Map(
    [...latest].map(([conceptId, grant]) => [
      conceptId,
      confirmed.has(conceptId) ? 'confirmed' : grant.state,
    ]),
  );
}

export function currentPlacementCredit(grants: readonly PlacementGrantSnapshot[]): Set<string> {
  return new Set(
    [...effectiveGrantStates(grants)].flatMap(([conceptId, state]) =>
      state === 'withdrawn' ? [] : [conceptId],
    ),
  );
}

export function withdrawnPlacementCredit(grants: readonly PlacementGrantSnapshot[]): Set<string> {
  return new Set(
    [...effectiveGrantStates(grants)].flatMap(([conceptId, state]) =>
      state === 'withdrawn' ? [conceptId] : [],
    ),
  );
}

export function conditionalPrerequisites(
  prerequisiteIds: readonly string[],
  grantStates: ReadonlyMap<string, PlacementGrantState>,
): string[] {
  return [...new Set(prerequisiteIds)].filter(
    (conceptId) => grantStates.get(conceptId) === 'conditional',
  );
}

export function planWithdrawal(input: {
  failedConceptId: string;
  grantStates: ReadonlyMap<string, PlacementGrantState>;
  studiedConceptIds: ReadonlySet<string>;
  content: ContentIndex;
}): Array<{ conceptId: string; reason: 'direct_failure' | 'cascade' }> {
  const withdrawable = (conceptId: string) =>
    input.grantStates.get(conceptId) === 'conditional' && !input.studiedConceptIds.has(conceptId);
  if (!withdrawable(input.failedConceptId)) return [];
  const planned: Array<{ conceptId: string; reason: 'direct_failure' | 'cascade' }> = [
    { conceptId: input.failedConceptId, reason: 'direct_failure' },
  ];
  for (const dependentId of hardDescendants(input.failedConceptId, input.content)) {
    if (withdrawable(dependentId)) planned.push({ conceptId: dependentId, reason: 'cascade' });
  }
  return planned;
}

export function masteryAfterWithdrawal(
  record: MasteryRecord,
  excludedAttemptIds: ReadonlySet<string>,
  now: Date,
): MasteryRecord {
  const rebuilt = rebuildMasteryFromEvidence(
    record.conceptId,
    record.dimension,
    record.attempts.filter((attempt) => !excludedAttemptIds.has(attempt.attemptId)),
  );
  return {
    ...(capWithdrawnMastery(rebuilt) ?? rebuilt),
    provisional: false,
    inferred: false,
    lastAssessedAt: now.toISOString(),
  };
}

/** Keeps a withdrawn, unstudied topic below learned until its lesson is done. */
export function capWithdrawnMastery(record: MasteryRecord): MasteryRecord | null {
  if (masteryRank(record.state) < masteryRank('assisted') && !record.inferred) return null;
  return {
    ...record,
    state: masteryRank(record.state) >= masteryRank('assisted') ? 'introduced' : record.state,
    inferred: false,
  };
}

function hardAncestors(conceptId: string, content: ContentIndex): string[] {
  const found = new Set<string>();
  const visit = (currentId: string) => {
    for (const prerequisite of content.conceptsById.get(currentId)?.prereqs ?? []) {
      if (prerequisite.strength !== 'hard' || found.has(prerequisite.id)) continue;
      found.add(prerequisite.id);
      visit(prerequisite.id);
    }
  };
  visit(conceptId);
  found.delete(conceptId);
  return [...found];
}

function hardDescendants(conceptId: string, content: ContentIndex): string[] {
  const dependents = new Map<string, string[]>();
  for (const concept of content.conceptsById.values()) {
    for (const prerequisite of concept.prereqs) {
      if (prerequisite.strength !== 'hard') continue;
      dependents.set(prerequisite.id, [...(dependents.get(prerequisite.id) ?? []), concept.id]);
    }
  }
  const found: string[] = [];
  const visited = new Set([conceptId]);
  const queue = [conceptId];
  while (queue.length > 0) {
    const currentId = queue.shift() ?? '';
    for (const dependentId of (dependents.get(currentId) ?? []).sort()) {
      if (visited.has(dependentId)) continue;
      visited.add(dependentId);
      found.push(dependentId);
      queue.push(dependentId);
    }
  }
  return found;
}

function timeOf(value: string | Date): number {
  return typeof value === 'string' ? Date.parse(value) : value.getTime();
}
