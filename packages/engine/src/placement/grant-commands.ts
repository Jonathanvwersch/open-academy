import type { ContentIndex } from '../course/types.js';
import {
  createPrerequisiteChecker,
  keyPrereqsForPoint,
  labActivityReady,
  masteryKey,
} from '../graph/prerequisites.js';
import { openTargetedReviews } from '../memory/remediation-flags.js';
import type { PlacementReviewStore } from '../store/placement-review-store.js';
import {
  capWithdrawnMastery,
  classifyPlacementGrants,
  conditionalPrerequisites,
  effectiveGrantStates,
  grantAnswerDecision,
  masteryAfterWithdrawal,
  type PlacementGrantState,
  planWithdrawal,
} from './grants.js';
import type { PlacementState } from './placement.js';

export async function placementGrantStates(
  store: PlacementReviewStore,
  userId: string,
): Promise<Map<string, PlacementGrantState>> {
  return effectiveGrantStates(await store.listPlacementGrants(userId));
}

export async function recordPlacementGrants(input: {
  store: PlacementReviewStore;
  userId: string;
  runId: string;
  state: PlacementState;
  content: ContentIndex;
  now: Date;
}): Promise<Map<string, 'conditional' | 'confirmed'>> {
  const studied = await studiedConceptIds(input.store, input.userId);
  const attemptIds = input.state.answers.flatMap((answer) =>
    answer.attemptId ? [answer.attemptId] : [],
  );
  const durations = new Map(
    (attemptIds.length
      ? await input.store.listAttempts(input.userId, { ids: attemptIds, order: 'unordered' })
      : []
    ).map((attempt) => [attempt.id, attempt.durationMs]),
  );
  const drafts = classifyPlacementGrants({
    known: input.state.known.filter((conceptId) => !studied.has(conceptId)),
    answers: input.state.answers.map((answer) => ({
      conceptId: answer.conceptId,
      attemptId: answer.attemptId ?? undefined,
      correct: answer.correct,
      durationMs: answer.attemptId ? durations.get(answer.attemptId) : undefined,
      targetSeconds: input.content.exercisesById.get(answer.exerciseId)?.target_seconds,
    })),
    content: input.content,
  });
  if (drafts.length > 0) {
    await input.store.insertPlacementGrantsOnce(
      input.userId,
      drafts.map((draft) => ({
        ...draft,
        runId: input.runId,
        createdAt: input.now,
        updatedAt: input.now,
        confirmedAt: draft.state === 'confirmed' ? input.now : null,
        confirmedByAttemptId: null,
        withdrawnAt: null,
        withdrawnByAttemptId: null,
      })),
    );
    await input.store.setReviewCardSuspension(
      input.userId,
      drafts.map(({ conceptId }) => conceptId),
      null,
    );
  }
  return new Map(drafts.map((draft) => [draft.conceptId, draft.state]));
}

export async function applyPlacementGrantOutcome(input: {
  store: PlacementReviewStore;
  userId: string;
  content: ContentIndex;
  exerciseId: string;
  attemptId: string;
  mode: string;
  correct: number;
  hintsUsed: number;
  attemptNo: number;
  gradedBy: string;
  now: Date;
}): Promise<{ confirmed: string[]; withdrawn: string[]; targetedReviews: string[] }> {
  const none = { confirmed: [], withdrawn: [], targetedReviews: [] };
  if (input.mode === 'diagnostic') return none;
  const exercise = input.content.exercisesById.get(input.exerciseId);
  if (!exercise) return none;
  const states = await placementGrantStates(input.store, input.userId);
  if (await placementCreditWithdrawn(input.store, input.userId, exercise.concept)) {
    for (const record of await input.store.listMastery(input.userId)) {
      if (record.conceptId !== exercise.concept) continue;
      const capped = capWithdrawnMastery(record);
      if (capped) await input.store.saveMastery(input.userId, capped);
    }
    await input.store.setReviewCardSuspension(input.userId, [exercise.concept], input.now);
  }
  if (![...states.values()].includes('conditional')) return none;
  const decision = grantAnswerDecision(states.get(exercise.concept), {
    independent:
      input.hintsUsed === 0 && input.attemptNo === 1 && input.gradedBy === 'deterministic',
    correct: input.correct >= 1,
  });
  if (decision === 'confirm') {
    await confirmGrant(input, exercise.concept);
    return { ...none, confirmed: [exercise.concept] };
  }
  const withdrawn =
    decision === 'withdraw'
      ? await withdrawGrants({ ...input, failedConceptId: exercise.concept, states })
      : [];
  if (input.mode !== 'review' || input.correct >= 1) return { ...none, withdrawn };
  const lesson = input.content.lessonsByConcept.get(exercise.concept);
  const pointId =
    exercise.role === 'recall'
      ? exercise.knowledge_point
      : lesson?.knowledge_points?.find((point) => point.problems.includes(exercise.id))?.id;
  const targets = conditionalPrerequisites(
    keyPrereqsForPoint(input.content, exercise.concept, pointId ?? ''),
    states,
  ).filter((conceptId) => !withdrawn.includes(conceptId));
  await openTargetedReviews(input.store, {
    learnerId: input.userId,
    conceptId: exercise.concept,
    prerequisiteIds: targets,
    attemptId: input.attemptId,
    now: input.now,
  });
  return { ...none, withdrawn, targetedReviews: targets };
}

async function confirmGrant(
  input: { store: PlacementReviewStore; userId: string; attemptId: string; now: Date },
  conceptId: string,
) {
  await input.store.patchPlacementGrants(
    input.userId,
    { conceptId, ifState: 'conditional' },
    {
      state: 'confirmed',
      reason: 'confirmed_by_answer',
      confirmedAt: input.now,
      confirmedByAttemptId: input.attemptId,
      updatedAt: input.now,
    },
  );
  for (const record of await input.store.listMastery(input.userId)) {
    if (record.conceptId !== conceptId || !record.provisional) continue;
    await input.store.saveMastery(input.userId, {
      ...record,
      provisional: false,
    });
  }
}

/** Withdraws grants, rebuilds mastery and updates the plan as one all-or-nothing change. */
async function withdrawGrants(input: {
  store: PlacementReviewStore;
  userId: string;
  content: ContentIndex;
  failedConceptId: string;
  states: ReadonlyMap<string, PlacementGrantState>;
  attemptId: string;
  now: Date;
}): Promise<string[]> {
  return input.store.transaction((tx) => withdrawGrantsInTransaction({ ...input, store: tx }));
}

async function withdrawGrantsInTransaction(input: {
  store: PlacementReviewStore;
  userId: string;
  content: ContentIndex;
  failedConceptId: string;
  states: ReadonlyMap<string, PlacementGrantState>;
  attemptId: string;
  now: Date;
}): Promise<string[]> {
  const plan = planWithdrawal({
    failedConceptId: input.failedConceptId,
    grantStates: input.states,
    studiedConceptIds: await studiedConceptIds(input.store, input.userId),
    content: input.content,
  });
  if (plan.length === 0) return [];
  const conceptIds = plan.map((entry) => entry.conceptId);
  const grants = await input.store.listPlacementGrants(input.userId, {
    conceptIds,
    state: 'conditional',
  });
  const mastery = await input.store.listMastery(input.userId);
  for (const { conceptId, reason } of plan) {
    const conceptGrants = grants.filter((grant) => grant.conceptId === conceptId);
    const evidence = new Set(conceptGrants.flatMap((grant) => grant.evidenceAttemptIds));
    await input.store.patchPlacementGrants(
      input.userId,
      { ids: conceptGrants.map(({ id }) => id) },
      {
        state: 'withdrawn',
        reason,
        withdrawnAt: input.now,
        withdrawnByAttemptId: input.attemptId,
        updatedAt: input.now,
      },
    );
    for (const record of mastery.filter((entry) => entry.conceptId === conceptId)) {
      const rebuilt = masteryAfterWithdrawal(record, evidence, input.now);
      await input.store.saveMastery(input.userId, rebuilt);
      await input.store.addMasteryEvent(input.userId, {
        conceptId,
        dimension: record.dimension,
        fromState: record.state,
        toState: rebuilt.state,
        rule: reason === 'cascade' ? 'placement_credit_cascade' : 'placement_credit_withdrawn',
        attemptId: input.attemptId,
        createdAt: input.now,
      });
    }
  }
  await input.store.setReviewCardSuspension(input.userId, conceptIds, input.now);
  await reopenPlanAfterWithdrawal(input, conceptIds);
  await input.store.resolveRemediationFlags(
    input.userId,
    { targetPrereqIds: conceptIds },
    input.now,
  );
  return conceptIds;
}

/** Reopens courses that hold a withdrawn topic and skips planned work it no longer unlocks. */
async function reopenPlanAfterWithdrawal(
  input: { store: PlacementReviewStore; userId: string; content: ContentIndex },
  conceptIds: string[],
) {
  const affectedCourseIds = input.content.courses
    .filter((course) =>
      course.units.some((unit) => unit.concepts.some((id) => conceptIds.includes(id))),
    )
    .map((course) => course.id);
  if (affectedCourseIds.length > 0) {
    await input.store.writeEnrollments(input.userId, {
      kind: 'set_status',
      courseIds: affectedCourseIds,
      status: 'active',
      completedAt: null,
      ifStatus: 'completed',
    });
  }
  const sessions = await input.store.listSessions(input.userId, {});
  if (sessions.length === 0) return;
  const statuses = ['planned', 'in_progress'] as const;
  const activities = await input.store.listActivities(input.userId, {
    sessionIds: sessions.map(({ id }) => id),
    statuses,
  });
  const [masteryRecords, runRows] = await Promise.all([
    input.store.listMastery(input.userId),
    input.store.listLessonRuns(input.userId),
  ]);
  const masteryByKey = new Map(
    masteryRecords.map((record) => [masteryKey(record.conceptId, record.dimension), record]),
  );
  const checker = createPrerequisiteChecker(masteryByKey, runRows, input.content);
  const blocked = activities
    .filter((activity) => {
      if (activity.kind === 'lab') {
        return !labActivityReady(activity, masteryByKey, runRows, input.content);
      }
      if ((activity.kind !== 'learn' && activity.kind !== 'practice') || !activity.conceptId) {
        return false;
      }
      return (
        input.content.conceptsById.has(activity.conceptId) &&
        !checker.chainReady(activity.conceptId)
      );
    })
    .map((activity) => activity.id);
  if (blocked.length === 0) return;
  await input.store.patchActivities(
    input.userId,
    { ids: blocked },
    { status: 'skipped' },
    { statuses },
  );
}

/** True when the topic's placement credit was withdrawn and its lesson was never started. */
export async function placementCreditWithdrawn(
  store: PlacementReviewStore,
  userId: string,
  conceptId: string,
): Promise<boolean> {
  const grants = await store.listPlacementGrants(userId, { conceptIds: [conceptId] });
  if (effectiveGrantStates(grants).get(conceptId) !== 'withdrawn') return false;
  return !(await store.getLessonRun(userId, { conceptId }));
}

async function studiedConceptIds(
  store: PlacementReviewStore,
  learnerId: string,
): Promise<Set<string>> {
  return new Set((await store.listLessonRuns(learnerId)).map(({ conceptId }) => conceptId));
}
