import type { ContentIndex } from '@academy/aesop/course/types';
import { asc, eq } from 'drizzle-orm';
import type { Database } from '../src/db/client.js';
import { LearnerRepository } from '../src/db/repository.js';
import {
  attempts,
  lessonRuns,
  mastery,
  masteryEvents,
  placementGrants,
  remediationFlags,
  reviewCards,
  xpEvents,
} from '../src/db/schema.js';
import { applyPlacementGrantOutcome } from '../src/learning/placement-grants.js';

export type PlacementInvariantId = 'P20' | 'P21' | 'P22' | 'P23';

/** Attributable failures (direct answers plus downstream signals) before withdrawal must happen. */
export const p21FailureBound = 3;

export interface SimulationPlacementGrantEvidence {
  conceptId: string;
  origin: string;
  state: string;
  reason: string;
  confirmedAt: string | null;
  withdrawnAt: string | null;
  withdrawnByAttemptId: string | null;
  directFailures?: number;
  downstreamFailures?: number;
}

export interface PlacementAuditState {
  trulyKnown: Set<string>;
  overplaced: Set<string>;
  learned: Set<string>;
  failures: Map<string, { direct: number; downstream: number }>;
  seenAttemptIds: Set<string>;
  seenFlagIds: Set<string>;
  withdrawnDay: Map<string, number>;
  replayedAttemptIds: Set<string>;
  history: { attempts: Map<string, string>; xp: Map<string, string> } | null;
}

export function emptyPlacementAuditState(): PlacementAuditState {
  return {
    trulyKnown: new Set(),
    overplaced: new Set(),
    learned: new Set(),
    failures: new Map(),
    seenAttemptIds: new Set(),
    seenFlagIds: new Set(),
    withdrawnDay: new Map(),
    replayedAttemptIds: new Set(),
    history: null,
  };
}

export function isOverplacedGap(state: PlacementAuditState, conceptId: string): boolean {
  return state.overplaced.has(conceptId) && !state.learned.has(conceptId);
}

export function p20HasWithdrawnCreditViolation(input: {
  countsComplete: boolean;
  shownPlacedOut: boolean;
  unlockedDependentIds: readonly string[];
}): boolean {
  return input.countsComplete || input.shownPlacedOut || input.unlockedDependentIds.length > 0;
}

export function p21HasUnboundedWithdrawalViolation(input: {
  state: string;
  directFailures: number;
  downstreamFailures: number;
  bound?: number;
}): boolean {
  return (
    input.state === 'conditional' &&
    (input.directFailures > 0 ||
      input.directFailures + input.downstreamFailures >= (input.bound ?? p21FailureBound))
  );
}

export function p22HasProtectedWithdrawalViolation(input: {
  state: string;
  confirmedAt: Date | string | null;
  studiedBeforeWithdrawal: boolean;
}): boolean {
  return (
    input.state === 'withdrawn' && (input.confirmedAt !== null || input.studiedBeforeWithdrawal)
  );
}

export function p23ChangedHistoryIds(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): string[] {
  return [...before].flatMap(([id, row]) => (after.get(id) === row ? [] : [id]));
}

function hardDependents(conceptId: string, content: ContentIndex): string[] {
  const found = new Set<string>();
  const visit = (currentId: string) => {
    for (const edge of content.edges) {
      if (edge.prerequisiteId !== currentId || edge.strength !== 'hard') continue;
      if (found.has(edge.conceptId)) continue;
      found.add(edge.conceptId);
      visit(edge.conceptId);
    }
  };
  visit(conceptId);
  return [...found];
}

async function historySnapshot(db: Database, userId: string) {
  const [attemptRows, xpRows] = await Promise.all([
    db.select().from(attempts).where(eq(attempts.userId, userId)),
    db.select().from(xpEvents).where(eq(xpEvents.userId, userId)),
  ]);
  return {
    attempts: new Map(attemptRows.map((row) => [row.id, JSON.stringify(row)])),
    xp: new Map(xpRows.map((row) => [row.id, JSON.stringify(row)])),
  };
}

async function learnerSnapshot(db: Database, userId: string): Promise<string> {
  const [grants, masteryRows, events, cards, flags, history] = await Promise.all([
    db
      .select()
      .from(placementGrants)
      .where(eq(placementGrants.userId, userId))
      .orderBy(asc(placementGrants.id)),
    db
      .select()
      .from(mastery)
      .where(eq(mastery.userId, userId))
      .orderBy(asc(mastery.conceptId), asc(mastery.dimension)),
    db.select({ id: masteryEvents.id }).from(masteryEvents).where(eq(masteryEvents.userId, userId)),
    db
      .select()
      .from(reviewCards)
      .where(eq(reviewCards.userId, userId))
      .orderBy(asc(reviewCards.id)),
    db
      .select()
      .from(remediationFlags)
      .where(eq(remediationFlags.userId, userId))
      .orderBy(asc(remediationFlags.id)),
    historySnapshot(db, userId),
  ]);
  return JSON.stringify({
    grants,
    mastery: masteryRows,
    masteryEvents: events.length,
    cards,
    flags,
    attempts: [...history.attempts].sort(),
    xp: [...history.xp].sort(),
  });
}

/** Records which conditional placement credit the overplaced learner does not actually know. */
export async function recordOverplacement(
  db: Database,
  userId: string,
  state: PlacementAuditState,
): Promise<void> {
  const grants = await db
    .select({ conceptId: placementGrants.conceptId, state: placementGrants.state })
    .from(placementGrants)
    .where(eq(placementGrants.userId, userId));
  for (const grant of grants) {
    if (grant.state === 'conditional' && !state.trulyKnown.has(grant.conceptId)) {
      state.overplaced.add(grant.conceptId);
    }
  }
}

export async function auditPlacementGrants(input: {
  db: Database;
  userId: string;
  content: ContentIndex;
  day: number;
  state: PlacementAuditState;
  coursePageTopics: ReadonlyArray<{ conceptId: string; status: string; placedOut?: boolean }>;
  plannedLearnConceptIds: readonly string[];
  countsComplete: (conceptId: string) => boolean;
  markChecked: (invariant: PlacementInvariantId) => void;
  addViolation: (
    invariant: PlacementInvariantId,
    conceptId: string,
    details: string,
    evidenceConceptIds: string[],
    grants: SimulationPlacementGrantEvidence[],
  ) => void;
}): Promise<void> {
  const { db, userId, content, day, state } = input;
  const grants = await db
    .select()
    .from(placementGrants)
    .where(eq(placementGrants.userId, userId))
    .orderBy(asc(placementGrants.createdAt), asc(placementGrants.id));
  if (grants.length === 0) return;
  const latest = new Map(grants.map((grant) => [grant.conceptId, grant]));
  const [runs, newAttempts, flags] = await Promise.all([
    db.select().from(lessonRuns).where(eq(lessonRuns.userId, userId)),
    db.select().from(attempts).where(eq(attempts.userId, userId)),
    db.select().from(remediationFlags).where(eq(remediationFlags.userId, userId)),
  ]);
  const evidenceFor = (conceptIds: readonly string[]): SimulationPlacementGrantEvidence[] =>
    conceptIds.flatMap((conceptId) => {
      const grant = latest.get(conceptId);
      if (!grant) return [];
      const failures = state.failures.get(conceptId);
      return [
        {
          conceptId,
          origin: grant.origin,
          state: grant.state,
          reason: grant.reason,
          confirmedAt: grant.confirmedAt?.toISOString() ?? null,
          withdrawnAt: grant.withdrawnAt?.toISOString() ?? null,
          withdrawnByAttemptId: grant.withdrawnByAttemptId,
          ...(failures
            ? { directFailures: failures.direct, downstreamFailures: failures.downstream }
            : {}),
        },
      ];
    });

  for (const attempt of newAttempts) {
    if (state.seenAttemptIds.has(attempt.id)) continue;
    state.seenAttemptIds.add(attempt.id);
    const grant = latest.get(attempt.conceptId);
    if (
      attempt.mode === 'diagnostic' ||
      !state.overplaced.has(attempt.conceptId) ||
      attempt.correct >= 1 ||
      attempt.hintsUsed > 0 ||
      attempt.attemptNo !== 1 ||
      attempt.gradedBy !== 'deterministic' ||
      (grant?.withdrawnAt && grant.withdrawnAt < attempt.createdAt)
    ) {
      continue;
    }
    const failures = state.failures.get(attempt.conceptId) ?? { direct: 0, downstream: 0 };
    failures.direct += 1;
    state.failures.set(attempt.conceptId, failures);
  }
  for (const flag of flags) {
    if (state.seenFlagIds.has(flag.id) || !flag.targetPrereqId) continue;
    state.seenFlagIds.add(flag.id);
    if (!state.overplaced.has(flag.targetPrereqId)) continue;
    const failures = state.failures.get(flag.targetPrereqId) ?? { direct: 0, downstream: 0 };
    failures.downstream += 1;
    state.failures.set(flag.targetPrereqId, failures);
  }

  const newlyWithdrawn: string[] = [];
  for (const grant of latest.values()) {
    if (grant.state === 'withdrawn' && !state.withdrawnDay.has(grant.conceptId)) {
      state.withdrawnDay.set(grant.conceptId, day);
      newlyWithdrawn.push(grant.conceptId);
    }
  }

  for (const grant of latest.values()) {
    if (grant.state !== 'withdrawn') continue;
    const relearned = runs.some(
      (run) => run.conceptId === grant.conceptId && run.status === 'completed',
    );
    if (relearned) continue;
    input.markChecked('P20');
    const dependents = hardDependents(grant.conceptId, content);
    const completedDependents = new Set(
      runs.filter((run) => run.status === 'completed').map((run) => run.conceptId),
    );
    const withdrawnBeforeToday = (state.withdrawnDay.get(grant.conceptId) ?? day) < day;
    const unlockedDependentIds = [
      ...input.coursePageTopics
        .filter(
          (topic) =>
            dependents.includes(topic.conceptId) &&
            !completedDependents.has(topic.conceptId) &&
            topic.status === 'available',
        )
        .map((topic) => topic.conceptId),
      ...(withdrawnBeforeToday
        ? input.plannedLearnConceptIds.filter(
            (conceptId) =>
              dependents.includes(conceptId) &&
              !runs.some((run) => run.conceptId === conceptId && run.startedAt < grant.updatedAt),
          )
        : []),
    ];
    const topic = input.coursePageTopics.find((item) => item.conceptId === grant.conceptId);
    const countsComplete = input.countsComplete(grant.conceptId) || topic?.status === 'complete';
    const shownPlacedOut = topic?.placedOut === true;
    if (p20HasWithdrawnCreditViolation({ countsComplete, shownPlacedOut, unlockedDependentIds })) {
      input.addViolation(
        'P20',
        grant.conceptId,
        `withdrawn topic ${countsComplete ? 'counts as complete' : shownPlacedOut ? 'is shown as placed out' : `unlocks ${[...new Set(unlockedDependentIds)].join(', ')}`}`,
        [...new Set(unlockedDependentIds)],
        evidenceFor([grant.conceptId]),
      );
    }
  }

  for (const conceptId of state.overplaced) {
    const grant = latest.get(conceptId);
    if (!grant) continue;
    input.markChecked('P21');
    const failures = state.failures.get(conceptId) ?? { direct: 0, downstream: 0 };
    if (
      p21HasUnboundedWithdrawalViolation({
        state: grant.state,
        directFailures: failures.direct,
        downstreamFailures: failures.downstream,
      })
    ) {
      input.addViolation(
        'P21',
        conceptId,
        `conditional grant survived ${failures.direct} direct and ${failures.downstream} downstream failures`,
        [],
        evidenceFor([conceptId]),
      );
    }
  }

  for (const grant of latest.values()) {
    input.markChecked('P22');
    const withdrawnAt = grant.withdrawnAt;
    const studiedBeforeWithdrawal =
      withdrawnAt !== null &&
      runs.some((run) => run.conceptId === grant.conceptId && run.startedAt < withdrawnAt);
    if (
      p22HasProtectedWithdrawalViolation({
        state: grant.state,
        confirmedAt: grant.confirmedAt,
        studiedBeforeWithdrawal,
      })
    ) {
      input.addViolation(
        'P22',
        grant.conceptId,
        grant.confirmedAt ? 'confirmed grant was withdrawn' : 'studied topic was withdrawn',
        [],
        evidenceFor([grant.conceptId]),
      );
    }
  }

  const history = await historySnapshot(db, userId);
  if (state.history && newlyWithdrawn.length > 0) {
    input.markChecked('P23');
    const changed = [
      ...p23ChangedHistoryIds(state.history.attempts, history.attempts).map(
        (id) => `attempt ${id}`,
      ),
      ...p23ChangedHistoryIds(state.history.xp, history.xp).map((id) => `xp ${id}`),
    ];
    if (changed.length > 0) {
      input.addViolation(
        'P23',
        newlyWithdrawn[0] ?? '',
        `withdrawal changed history: ${changed.slice(0, 5).join(', ')}`,
        newlyWithdrawn,
        evidenceFor(newlyWithdrawn),
      );
    }
  }
  state.history = history;

  const repo = new LearnerRepository(db, userId);
  for (const conceptId of newlyWithdrawn) {
    const attemptId = latest.get(conceptId)?.withdrawnByAttemptId;
    if (!attemptId || state.replayedAttemptIds.has(attemptId)) continue;
    state.replayedAttemptIds.add(attemptId);
    const attempt = newAttempts.find((row) => row.id === attemptId);
    if (!attempt) continue;
    input.markChecked('P23');
    const before = await learnerSnapshot(db, userId);
    await applyPlacementGrantOutcome({
      db,
      repo,
      userId,
      content,
      exerciseId: attempt.exerciseId,
      attemptId,
      mode: attempt.mode,
      correct: attempt.correct,
      hintsUsed: attempt.hintsUsed,
      attemptNo: attempt.attemptNo,
      gradedBy: attempt.gradedBy,
      now: attempt.createdAt,
    });
    if ((await learnerSnapshot(db, userId)) !== before) {
      input.addViolation(
        'P23',
        conceptId,
        `replaying withdrawal attempt ${attemptId} changed learner state`,
        newlyWithdrawn,
        evidenceFor(newlyWithdrawn),
      );
    }
    state.history = await historySnapshot(db, userId);
  }
}
