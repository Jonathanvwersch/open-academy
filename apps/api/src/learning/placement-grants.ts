import type { ContentIndex } from '@academy/aesop/course/types';
import {
  createPrerequisiteChecker,
  keyPrereqsForPoint,
  labActivityReady,
  masteryKey,
} from '@academy/aesop/graph/prerequisites';
import {
  capWithdrawnMastery,
  classifyPlacementGrants,
  conditionalPrerequisites,
  effectiveGrantStates,
  grantAnswerDecision,
  masteryAfterWithdrawal,
  type PlacementGrantState,
  planWithdrawal,
} from '@academy/aesop/placement/grants';
import type { PlacementState } from '@academy/aesop/placement/placement';
import { and, eq, inArray, or } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { drizzleLearnerStore } from '../db/learner-store.js';
import {
  attempts,
  courseEnrollments,
  lessonRuns,
  placementGrants,
  remediationFlags,
  reviewCards,
  sessionActivities,
  studySessions,
} from '../db/schema.js';

export async function placementGrantStates(
  db: Database,
  userId: string,
): Promise<Map<string, PlacementGrantState>> {
  return effectiveGrantStates(
    await db
      .select({
        conceptId: placementGrants.conceptId,
        state: placementGrants.state,
        createdAt: placementGrants.createdAt,
      })
      .from(placementGrants)
      .where(eq(placementGrants.userId, userId)),
  );
}

export async function recordPlacementGrants(input: {
  db: Database;
  userId: string;
  runId: string;
  state: PlacementState;
  content: ContentIndex;
  now: Date;
}): Promise<Map<string, 'conditional' | 'confirmed'>> {
  const studied = await studiedConceptIds(input.db, input.userId);
  const attemptIds = input.state.answers.flatMap((answer) =>
    answer.attemptId ? [answer.attemptId] : [],
  );
  const durations = new Map(
    (attemptIds.length
      ? await input.db
          .select({ id: attempts.id, durationMs: attempts.durationMs })
          .from(attempts)
          .where(and(eq(attempts.userId, input.userId), inArray(attempts.id, attemptIds)))
      : []
    ).map((attempt) => [attempt.id, attempt.durationMs]),
  );
  const drafts = classifyPlacementGrants({
    known: input.state.known.filter((conceptId) => !studied.has(conceptId)),
    answers: input.state.answers.flatMap((answer) =>
      answer.attemptId
        ? [
            {
              conceptId: answer.conceptId,
              attemptId: answer.attemptId,
              correct: answer.correct,
              durationMs: durations.get(answer.attemptId),
              targetSeconds: input.content.exercisesById.get(answer.exerciseId)?.target_seconds,
            },
          ]
        : [],
    ),
    content: input.content,
  });
  if (drafts.length > 0) {
    await input.db
      .insert(placementGrants)
      .values(
        drafts.map((draft) => ({
          userId: input.userId,
          runId: input.runId,
          conceptId: draft.conceptId,
          origin: draft.origin,
          state: draft.state,
          reason: draft.reason,
          evidenceAttemptIds: draft.evidenceAttemptIds,
          createdAt: input.now,
          updatedAt: input.now,
          confirmedAt: draft.state === 'confirmed' ? input.now : null,
        })),
      )
      .onConflictDoNothing();
  }
  return new Map(drafts.map((draft) => [draft.conceptId, draft.state]));
}

export async function applyPlacementGrantOutcome(input: {
  db: Database;
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
  const states = await placementGrantStates(input.db, input.userId);
  if (await placementCreditWithdrawn(input.db, input.userId, exercise.concept)) {
    for (const record of await drizzleLearnerStore(input.db).listMastery(input.userId)) {
      if (record.conceptId !== exercise.concept) continue;
      const capped = capWithdrawnMastery(record);
      if (capped) await drizzleLearnerStore(input.db).saveMastery(input.userId, capped);
    }
    await deletePlacementOnlyCards(input.db, input.userId, [exercise.concept]);
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
  await openTargetedReviews({
    db: input.db,
    userId: input.userId,
    conceptId: exercise.concept,
    prerequisiteIds: targets,
    attemptId: input.attemptId,
    now: input.now,
  });
  return { ...none, withdrawn, targetedReviews: targets };
}

export async function openTargetedReviews(input: {
  db: Database;
  userId: string;
  conceptId: string;
  prerequisiteIds: readonly string[];
  attemptId: string | null;
  now: Date;
}): Promise<void> {
  if (input.prerequisiteIds.length === 0) return;
  const existing = await input.db
    .select({
      targetPrereqId: remediationFlags.targetPrereqId,
      status: remediationFlags.status,
      openedByAttemptId: remediationFlags.openedByAttemptId,
    })
    .from(remediationFlags)
    .where(
      and(
        eq(remediationFlags.userId, input.userId),
        eq(remediationFlags.conceptId, input.conceptId),
        inArray(remediationFlags.targetPrereqId, [...input.prerequisiteIds]),
      ),
    );
  const alreadyOpen = new Set(
    existing
      .filter(
        (flag) =>
          flag.status === 'open' ||
          (input.attemptId !== null && flag.openedByAttemptId === input.attemptId),
      )
      .map((flag) => flag.targetPrereqId),
  );
  const values = input.prerequisiteIds
    .filter((prerequisiteId) => !alreadyOpen.has(prerequisiteId))
    .map((targetPrereqId) => ({
      userId: input.userId,
      conceptId: input.conceptId,
      targetPrereqId,
      openedByAttemptId: input.attemptId,
      status: 'open' as const,
      createdAt: input.now,
    }));
  if (values.length > 0) await input.db.insert(remediationFlags).values(values);
}

async function confirmGrant(
  input: { db: Database; userId: string; attemptId: string; now: Date },
  conceptId: string,
) {
  await input.db
    .update(placementGrants)
    .set({
      state: 'confirmed',
      reason: 'confirmed_by_answer',
      confirmedAt: input.now,
      confirmedByAttemptId: input.attemptId,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(placementGrants.userId, input.userId),
        eq(placementGrants.conceptId, conceptId),
        eq(placementGrants.state, 'conditional'),
      ),
    );
  for (const record of await drizzleLearnerStore(input.db).listMastery(input.userId)) {
    if (record.conceptId !== conceptId || !record.provisional) continue;
    await drizzleLearnerStore(input.db).saveMastery(input.userId, {
      ...record,
      provisional: false,
    });
  }
}

/** Withdraws grants, rebuilds mastery and updates the plan as one all-or-nothing change. */
async function withdrawGrants(input: {
  db: Database;
  userId: string;
  content: ContentIndex;
  failedConceptId: string;
  states: ReadonlyMap<string, PlacementGrantState>;
  attemptId: string;
  now: Date;
}): Promise<string[]> {
  return input.db.transaction((tx) =>
    withdrawGrantsInTransaction({ ...input, db: tx as unknown as Database }),
  );
}

async function withdrawGrantsInTransaction(input: {
  db: Database;
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
    studiedConceptIds: await studiedConceptIds(input.db, input.userId),
    content: input.content,
  });
  if (plan.length === 0) return [];
  const conceptIds = plan.map((entry) => entry.conceptId);
  const grants = await input.db
    .select()
    .from(placementGrants)
    .where(
      and(
        eq(placementGrants.userId, input.userId),
        inArray(placementGrants.conceptId, conceptIds),
        eq(placementGrants.state, 'conditional'),
      ),
    );
  const mastery = await drizzleLearnerStore(input.db).listMastery(input.userId);
  for (const { conceptId, reason } of plan) {
    const conceptGrants = grants.filter((grant) => grant.conceptId === conceptId);
    const evidence = new Set(conceptGrants.flatMap((grant) => grant.evidenceAttemptIds));
    await input.db
      .update(placementGrants)
      .set({
        state: 'withdrawn',
        reason,
        withdrawnAt: input.now,
        withdrawnByAttemptId: input.attemptId,
        updatedAt: input.now,
      })
      .where(
        inArray(
          placementGrants.id,
          conceptGrants.map((grant) => grant.id),
        ),
      );
    for (const record of mastery.filter((entry) => entry.conceptId === conceptId)) {
      const rebuilt = masteryAfterWithdrawal(record, evidence, input.now);
      await drizzleLearnerStore(input.db).saveMastery(input.userId, rebuilt);
      await drizzleLearnerStore(input.db).addMasteryEvent(input.userId, {
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
  await deletePlacementOnlyCards(input.db, input.userId, conceptIds);
  await reopenPlanAfterWithdrawal(input, conceptIds);
  await input.db
    .update(remediationFlags)
    .set({ status: 'resolved', resolvedAt: input.now })
    .where(
      and(
        eq(remediationFlags.userId, input.userId),
        eq(remediationFlags.status, 'open'),
        inArray(remediationFlags.targetPrereqId, conceptIds),
      ),
    );
  return conceptIds;
}

/** Removes placement-only cards; withdrawal only reaches topics the learner never studied. */
async function deletePlacementOnlyCards(db: Database, userId: string, conceptIds: string[]) {
  await db
    .delete(reviewCards)
    .where(and(eq(reviewCards.userId, userId), inArray(reviewCards.conceptId, conceptIds)));
}

/** Reopens courses that hold a withdrawn topic and skips planned work it no longer unlocks. */
async function reopenPlanAfterWithdrawal(
  input: { db: Database; userId: string; content: ContentIndex },
  conceptIds: string[],
) {
  const affectedCourseIds = input.content.courses
    .filter((course) =>
      course.units.some((unit) => unit.concepts.some((id) => conceptIds.includes(id))),
    )
    .map((course) => course.id);
  if (affectedCourseIds.length > 0) {
    await input.db
      .update(courseEnrollments)
      .set({ status: 'active', completedAt: null })
      .where(
        and(
          eq(courseEnrollments.userId, input.userId),
          eq(courseEnrollments.status, 'completed'),
          inArray(courseEnrollments.courseId, affectedCourseIds),
        ),
      );
  }
  const sessions = await input.db
    .select({ id: studySessions.id })
    .from(studySessions)
    .where(eq(studySessions.userId, input.userId));
  if (sessions.length === 0) return;
  const openActivities = or(
    eq(sessionActivities.status, 'planned'),
    eq(sessionActivities.status, 'in_progress'),
  );
  const activities = await input.db
    .select({
      id: sessionActivities.id,
      conceptId: sessionActivities.conceptId,
      kind: sessionActivities.kind,
      projectId: sessionActivities.projectId,
    })
    .from(sessionActivities)
    .where(
      and(
        inArray(
          sessionActivities.sessionId,
          sessions.map((session) => session.id),
        ),
        openActivities,
      ),
    );
  const [masteryRecords, runRows] = await Promise.all([
    drizzleLearnerStore(input.db).listMastery(input.userId),
    input.db
      .select({ conceptId: lessonRuns.conceptId, status: lessonRuns.status })
      .from(lessonRuns)
      .where(eq(lessonRuns.userId, input.userId)),
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
  await input.db
    .update(sessionActivities)
    .set({ status: 'skipped' })
    .where(and(inArray(sessionActivities.id, blocked), openActivities));
}

/** True when the topic's placement credit was withdrawn and its lesson was never started. */
export async function placementCreditWithdrawn(
  db: Database,
  userId: string,
  conceptId: string,
): Promise<boolean> {
  const grants = await db
    .select({
      conceptId: placementGrants.conceptId,
      state: placementGrants.state,
      createdAt: placementGrants.createdAt,
    })
    .from(placementGrants)
    .where(and(eq(placementGrants.userId, userId), eq(placementGrants.conceptId, conceptId)));
  if (effectiveGrantStates(grants).get(conceptId) !== 'withdrawn') return false;
  const [run] = await db
    .select({ id: lessonRuns.id })
    .from(lessonRuns)
    .where(and(eq(lessonRuns.userId, userId), eq(lessonRuns.conceptId, conceptId)))
    .limit(1);
  return !run;
}

async function studiedConceptIds(db: Database, userId: string): Promise<Set<string>> {
  return new Set(
    (
      await db
        .select({ conceptId: lessonRuns.conceptId })
        .from(lessonRuns)
        .where(eq(lessonRuns.userId, userId))
    ).map((run) => run.conceptId),
  );
}
