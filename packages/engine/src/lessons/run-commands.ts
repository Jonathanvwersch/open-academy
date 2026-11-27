import { Rating } from 'ts-fsrs';
import type { Dimension } from '../course/schemas.js';
import { instantiateExercise, isTemplate } from '../course/templates.js';
import type { ContentIndex, IndexedExercise, IndexedLesson } from '../course/types.js';
import { keyPrereqsForPoint } from '../graph/prerequisites.js';
import {
  newReviewCard,
  reviewActivityRating,
  scheduleReviewWithDetails,
  startOfNextCalendarDay,
} from '../memory/fsrs.js';
import { calculateCredit } from '../memory/mastery.js';
import {
  applyImplicitRepetitions,
  type applyMastery,
  getTopicSpeed,
} from '../memory/mastery-service.js';
import { openTargetedReviews } from '../memory/remediation-flags.js';
import { placementGrantStates } from '../placement/grant-commands.js';
import { conditionalPrerequisites } from '../placement/grants.js';
import { updateActivityAndAdvance } from '../planner/activity-advance.js';
import { localDateKey } from '../progress/xp.js';
import type { LessonQuizEvidence, LessonStore } from '../store/lesson-store.js';
import type { PlacementReviewStore } from '../store/placement-review-store.js';
import type { GradeResult } from './grading/types.js';
import { scoreLessonQuiz, selectQuizItems } from './lesson-quiz.js';
import { isLessonRetryReady } from './lesson-retry.js';
import { deriveLessonState, selectNextProblem, xpForPassedPoint } from './lesson-runner.js';
import {
  type LessonRuntime,
  loadRunProblems,
  loadRunQuiz,
  serveNextRunProblem,
} from './run-recovery.js';

export type LessonCommand = {
  userId: string;
  conceptId: string;
  timeZone: string;
  resolved: { index: ContentIndex; lesson: IndexedLesson };
};
type Attachment = { activityId?: string; sessionId?: string };
type ProblemAnswer = Attachment & { problemId: string; answer: unknown; durationMs?: number };
type QuizAnswer = { itemId: string; answer: unknown; durationMs?: number };

function lessonQuizEvidence(
  exercise: IndexedExercise,
  grade: LessonQuizEvidence['grade'],
): LessonQuizEvidence {
  const { id, concept, dimension, role, contentVersion, target_seconds } = exercise;
  return {
    exercise: {
      id,
      concept,
      dimension,
      role,
      contentVersion,
      ...(target_seconds === undefined ? {} : { target_seconds }),
    },
    grade,
  };
}

type MasteryHost = { applyMastery: typeof applyMastery };
export type LessonGrader = (
  exercise: IndexedExercise,
  answer: unknown,
  options: { random: () => number; requireAnswer?: true },
) => Promise<GradeResult>;

export type ProblemAnswerHost<S extends LessonStore> = MasteryHost & {
  grade: LessonGrader;
  hasTutorReply(store: S, learnerId: string, problemId: string): Promise<boolean>;
};

export type QuizSubmitHost = MasteryHost & { grade: LessonGrader };

export function resolveLessonExercise(
  exercise: IndexedExercise,
  seed: number | null,
): IndexedExercise | undefined {
  if (!isTemplate(exercise)) return exercise;
  if (seed === null) return undefined;
  return {
    ...instantiateExercise(exercise, seed).exercise,
    concept: exercise.concept,
    contentVersion: exercise.contentVersion,
  } as IndexedExercise;
}

async function listProblemsByPoint(store: LessonStore, learnerId: string, runId: string) {
  return (await store.listLessonProblems(learnerId, runId)).sort(
    (left, right) =>
      left.servedAt.getTime() - right.servedAt.getTime() ||
      (left.knowledgePointId < right.knowledgePointId
        ? -1
        : left.knowledgePointId > right.knowledgePointId
          ? 1
          : 0) ||
      left.round - right.round,
  );
}

export async function startLessonRun(
  store: LessonStore,
  runtime: LessonRuntime,
  input: LessonCommand & { reconcileProgress?: boolean },
) {
  const { userId, conceptId, timeZone, resolved } = input;
  const now = runtime.now();
  return store.transaction(async (tx) => {
    let existing = await tx.getLessonRun(userId, { conceptId }, { forUpdate: true });
    if (!existing) {
      existing =
        (await tx.insertLessonRunIfAbsent(userId, {
          conceptId,
          status: 'in_progress',
          startedAt: now,
          updatedAt: now,
          completedAt: null,
          quizPassedAt: null,
          attempt: 1,
          haltedAt: null,
          retryAfter: null,
          haltedPointIndex: null,
          haltCount: 0,
        })) ?? (await tx.getLessonRun(userId, { conceptId }, { forUpdate: true }));
    }
    if (!existing) throw new Error('Unable to create lesson run');
    const { rows: problems } = await loadRunProblems(tx, userId, existing.id, resolved.index);
    let state = deriveLessonState(
      resolved.lesson,
      problems,
      resolved.index.exercisesById,
      existing.quizPassedAt,
      existing.attempt,
    );
    if (existing.status === 'needs_retry') {
      if (!isLessonRetryReady(existing.retryAfter, false, now)) {
        return { kind: 'retry_tomorrow' as const };
      }
      const openFlags = await tx.listRemediationFlags(userId, { conceptId, status: 'open' });
      const reviewFirstIds = [
        ...new Set(openFlags.map((flag) => flag.targetPrereqId ?? conceptId)),
      ];
      if (!isLessonRetryReady(existing.retryAfter, openFlags.length > 0, now)) {
        return {
          kind: 'review_first' as const,
          titles: reviewFirstIds.map((id) => resolved.index.conceptsById.get(id)?.title ?? id),
        };
      }
      existing = await tx.patchLessonRun(userId, existing.id, {
        attempt: existing.attempt + 1,
        status: 'in_progress',
        retryAfter: null,
        updatedAt: now,
        completedAt: null,
      });
      state = deriveLessonState(
        resolved.lesson,
        problems,
        resolved.index.exercisesById,
        existing.quizPassedAt,
        existing.attempt,
      );
    } else if (state.halted) {
      existing = await tx.patchLessonRun(userId, existing.id, {
        attempt: existing.attempt + 1,
        status: 'in_progress',
        haltedAt: null,
        retryAfter: null,
        updatedAt: now,
        completedAt: null,
      });
      state = deriveLessonState(
        resolved.lesson,
        problems,
        resolved.index.exercisesById,
        existing.quizPassedAt,
        existing.attempt,
      );
    }
    // Repair completion earned under the old tutor-exclusion rule only on an explicit write.
    // Unique source keys retain historical awards and make repeated recovery safe.
    const passedPoints = state.points.filter((point) => point.status === 'passed');
    if (input.reconcileProgress && passedPoints.length) {
      for (const point of passedPoints) {
        await tx.insertXpEventOnce(userId, {
          kind: 'knowledge_point',
          sourceKey: `kp:${existing.id}:${point.id}`,
          conceptId,
          amount: xpForPassedPoint(point.answered),
          earnedAt: now,
          localDate: localDateKey(now, timeZone),
        });
      }
    }
    if (state.status !== 'in_progress') {
      if (existing.status !== state.status) {
        existing = await tx.patchLessonRun(userId, existing.id, {
          status: state.status,
          updatedAt: now,
          completedAt: state.status === 'completed' ? (existing.completedAt ?? now) : null,
        });
      }
      return { kind: 'ready' as const, run: existing };
    }
    if (existing.status !== 'in_progress') {
      existing = await tx.patchLessonRun(userId, existing.id, {
        status: 'in_progress',
        updatedAt: now,
        completedAt: null,
      });
    }
    await serveNextRunProblem(
      tx,
      userId,
      existing,
      resolved.lesson,
      resolved.index,
      problems,
      state,
      now,
      runtime.random,
    );
    return { kind: 'ready' as const, run: existing };
  });
}

export async function practiceLessonPoint(
  store: LessonStore,
  runtime: LessonRuntime,
  input: LessonCommand & { pointId: string; warmup?: boolean },
) {
  const { userId, conceptId, resolved } = input;
  const now = runtime.now();
  return store.transaction(async (tx) => {
    const run = await tx.getLessonRun(userId, { conceptId }, { forUpdate: true });
    if (!run) return { kind: 'not_found' as const };
    const problems = await listProblemsByPoint(tx, userId, run.id);
    const state = deriveLessonState(
      resolved.lesson,
      problems,
      resolved.index.exercisesById,
      run.quizPassedAt,
      run.attempt,
    );
    const pointState = state.points.find((item) => item.id === input.pointId);
    if (pointState?.status !== 'passed') return { kind: 'not_passed' as const, run };
    let availableProblems = problems;
    let warmupComplete = false;
    if (input.warmup) {
      const { quizAttempts, quizItems } = await tx.readLessonQuiz(userId, run.id);
      const latestQuizAttempt = quizAttempts.at(-1);
      const latestSubmittedAt = latestQuizAttempt?.submittedAt;
      if (!run.quizPassedAt && latestQuizAttempt?.passed === false && latestSubmittedAt) {
        const pointWasMissed = quizItems
          .filter((item) => item.quizAttemptId === latestQuizAttempt.id)
          .some(
            (item) =>
              item.knowledgePointId === input.pointId && item.correct !== null && item.correct < 1,
          );
        const answeredSinceFailure = problems.filter(
          (problem) =>
            problem.practiceOnly &&
            problem.knowledgePointId === input.pointId &&
            problem.answeredAt !== null &&
            problem.answeredAt > latestSubmittedAt,
        ).length;
        warmupComplete = !pointWasMissed || answeredSinceFailure >= 3;
      } else {
        warmupComplete = true;
      }
    }
    const pending = availableProblems.find((item) => item.practiceOnly && item.answeredAt === null);
    if (pending?.knowledgePointId === input.pointId && !warmupComplete) {
      return { kind: 'ready' as const, run };
    }
    if (pending) {
      await tx.deleteLessonProblems(userId, run.id, [pending.id]);
      availableProblems = availableProblems.filter((item) => item.id !== pending.id);
    }
    if (warmupComplete) return { kind: 'review_complete' as const, run };
    const point = resolved.lesson.knowledge_points?.find((item) => item.id === input.pointId);
    if (!point) return { kind: 'not_found' as const };
    const pointRows = availableProblems
      .filter((problem) => problem.knowledgePointId === point.id)
      .map(({ exerciseId, seed, position, correct, servedAt }) => ({
        exerciseId,
        seed,
        position,
        correct,
        servedAt,
      }));
    const usedSeeds = new Set(
      availableProblems.flatMap((problem) => (problem.seed === null ? [] : [problem.seed])),
    );
    const selection = selectNextProblem(
      point,
      resolved.index.exercisesById,
      pointRows,
      Math.floor(runtime.random() * 0x7fffffff),
      usedSeeds,
    );
    if (!selection) return { kind: 'no_problem' as const, run };
    await tx.insertLessonProblem(userId, run.id, {
      knowledgePointId: point.id,
      round: pointState.round,
      position: selection.position,
      exerciseId: selection.exerciseId,
      seed: selection.seed,
      practiceOnly: true,
      assisted: false,
      servedAt: now,
      answeredAt: null,
      correct: null,
      attemptId: null,
    });
    return { kind: 'ready' as const, run };
  });
}

export async function answerLessonProblem<S extends PlacementReviewStore>(
  store: S,
  runtime: LessonRuntime,
  input: LessonCommand & ProblemAnswer,
  host: ProblemAnswerHost<S>,
) {
  const { userId, conceptId, timeZone, resolved } = input;
  const now = runtime.now();
  return store.transaction(async (tx) => {
    const joined = await tx.lockLessonProblem(userId, conceptId, input.problemId);
    if (!joined) return { kind: 'not_found' as const };
    if (joined.problem.answeredAt) return { kind: 'conflict' as const, runId: joined.run.id };
    const allProblems = await listProblemsByPoint(tx, userId, joined.run.id);
    const stateBeforeAnswer = deriveLessonState(
      resolved.lesson,
      allProblems,
      resolved.index.exercisesById,
      joined.run.quizPassedAt,
      joined.run.attempt,
    );
    const pendingPractice = allProblems.find(
      (problem) => problem.practiceOnly && problem.answeredAt === null,
    );
    const expectedPending = joined.problem.practiceOnly
      ? pendingPractice?.id === joined.problem.id &&
        stateBeforeAnswer.points.find((point) => point.id === joined.problem.knowledgePointId)
          ?.status === 'passed'
      : stateBeforeAnswer.pending?.id === joined.problem.id &&
        stateBeforeAnswer.status === 'in_progress' &&
        !stateBeforeAnswer.halted;
    if (!expectedPending) {
      return { kind: 'conflict' as const, runId: joined.run.id };
    }
    const indexed = resolved.index.exercisesById.get(joined.problem.exerciseId);
    if (!indexed) return { kind: 'not_found' as const };
    if (
      joined.run.status === 'needs_retry' ||
      (joined.run.status === 'completed' && !joined.problem.practiceOnly)
    ) {
      return { kind: 'conflict' as const, runId: joined.run.id };
    }
    const exercise = resolveLessonExercise(indexed, joined.problem.seed);
    if (!exercise) return { kind: 'invalid' as const };
    const graded = await host.grade(exercise, input.answer, {
      random: runtime.random,
      requireAnswer: true,
    });
    if (graded.status !== 'graded') return { kind: 'invalid' as const, graded };
    const tutorHelped = await host.hasTutorReply(tx, userId, joined.problem.id);
    const attemptId = runtime.newId();
    const credit = calculateCredit({
      correct: graded.correct,
      hintsUsed: 0,
      attemptNo: 1,
      gradedBy: graded.graded_by ?? 'deterministic',
    });
    await tx.insertAttempt(userId, {
      id: attemptId,
      sessionId: input.sessionId ?? null,
      activityId: input.activityId ?? null,
      exerciseId: exercise.id,
      exerciseVersion: exercise.contentVersion,
      conceptId: exercise.concept,
      dimension: exercise.dimension,
      mode: 'practice',
      answer: input.answer,
      correct: graded.correct,
      credit,
      hintsUsed: 0,
      attemptNo: 1,
      gradedBy: graded.graded_by ?? 'deterministic',
      feedback: { message: graded.feedback },
      mistakeCategory: graded.mistake_category ?? null,
      durationMs: input.durationMs ?? null,
      createdAt: now,
    });
    await host.applyMastery(tx, {
      learnerId: userId,
      exercise,
      attemptId,
      correct: graded.correct,
      credit,
      hintsUsed: 0,
      attemptNo: 1,
      submitted: true,
      tutorHelped,
      mode: 'practice',
      gradedBy: graded.graded_by ?? 'deterministic',
      createReviewCard: false,
      now,
      timeZone: timeZone,
      enableFuzz: runtime.enableFsrsFuzz,
    });
    await tx.patchLessonProblem(userId, joined.run.id, joined.problem.id, {
      answeredAt: now,
      correct: graded.correct,
      attemptId,
    });
    const problems = await tx.listLessonProblems(userId, joined.run.id);
    const previous = deriveLessonState(
      resolved.lesson,
      problems.filter((item) => item.id !== joined.problem.id),
      resolved.index.exercisesById,
      joined.run.quizPassedAt,
      joined.run.attempt,
    );
    const state = deriveLessonState(
      resolved.lesson,
      problems,
      resolved.index.exercisesById,
      joined.run.quizPassedAt,
      joined.run.attempt,
    );
    const point = state.points.find((item) => item.id === joined.problem.knowledgePointId);
    let xpAwarded = 0;
    if (
      !joined.problem.practiceOnly &&
      point?.status === 'passed' &&
      previous.points.find((item) => item.id === point.id)?.status !== 'passed'
    ) {
      xpAwarded = xpForPassedPoint(point.answered);
      await tx.insertXpEventOnce(userId, {
        kind: 'knowledge_point',
        sourceKey: `kp:${joined.run.id}:${point.id}`,
        conceptId,
        amount: xpAwarded,
        earnedAt: now,
        localDate: localDateKey(now, timeZone),
      });
    }
    if (!joined.problem.practiceOnly) {
      const halted = state.halted;
      if (!previous.halted && halted !== undefined) {
        const haltedAt = now;
        const retryAfter = startOfNextCalendarDay(now, timeZone);
        const keyPrereqIds = keyPrereqsForPoint(resolved.index, conceptId, halted.pointId);
        await openTargetedReviews(tx, {
          learnerId: userId,
          conceptId,
          prerequisiteIds: conditionalPrerequisites(
            keyPrereqIds,
            await placementGrantStates(tx, userId),
          ),
          attemptId,
          now,
        });
        if (joined.run.haltedPointIndex !== null && halted.index <= joined.run.haltedPointIndex) {
          const openFlags = keyPrereqIds.length
            ? await tx.listRemediationFlags(userId, {
                conceptId,
                status: 'open',
                targetPrereqIds: keyPrereqIds,
              })
            : [];
          const alreadyOpen = new Set(
            openFlags.flatMap((flag) => (flag.targetPrereqId ? [flag.targetPrereqId] : [])),
          );
          const flagsToInsert = keyPrereqIds
            .filter((targetPrereqId) => !alreadyOpen.has(targetPrereqId))
            .map((targetPrereqId) => ({
              conceptId,
              targetPrereqId,
              openedByAttemptId: attemptId,
              status: 'open' as const,
              createdAt: now,
              resolvedAt: null,
            }));
          await tx.insertRemediationFlags(userId, flagsToInsert);
        }
        await tx.patchLessonRun(userId, joined.run.id, {
          status: 'needs_retry',
          haltedAt,
          retryAfter,
          haltedPointIndex: halted.index,
          haltCount: joined.run.haltCount + 1,
          updatedAt: now,
          completedAt: null,
        });
      } else {
        await tx.patchLessonRun(userId, joined.run.id, {
          status: state.status,
          updatedAt: now,
          completedAt: state.status === 'completed' ? now : null,
        });
      }
    }
    return {
      kind: 'answered' as const,
      runId: joined.run.id,
      correct: graded.correct,
      feedback: graded.feedback,
      solution: exercise.solution,
      xpAwarded,
    };
  });
}

function seededRandom(seed: string): () => number {
  let state = 0x811c9dc5;
  for (const character of seed) {
    state = Math.imul(state ^ character.charCodeAt(0), 0x01000193);
  }
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
  };
}

export async function startLessonQuiz(
  store: LessonStore,
  runtime: LessonRuntime,
  input: LessonCommand,
) {
  const { userId, conceptId, resolved } = input;
  const now = runtime.now();
  return store.transaction(async (tx) => {
    const run = await tx.getLessonRun(userId, { conceptId }, { forUpdate: true });
    if (!run) return { kind: 'not_found' as const };
    const problems = await listProblemsByPoint(tx, userId, run.id);
    const state = deriveLessonState(
      resolved.lesson,
      problems,
      resolved.index.exercisesById,
      run.quizPassedAt,
      run.attempt,
    );
    if (state.status === 'in_progress') return { kind: 'steps_incomplete' as const, run };
    const { quizAttempts: previousAttempts, quizItems: allQuizItems } = await tx.readLessonQuiz(
      userId,
      run.id,
    );
    const lastSubmittedAttempt = [...previousAttempts]
      .reverse()
      .find((attempt) => attempt.submittedAt !== null);
    const lastSubmittedAt = lastSubmittedAttempt?.submittedAt;
    if (!run.quizPassedAt && lastSubmittedAttempt?.passed === false && lastSubmittedAt) {
      const failedItems = allQuizItems.filter(
        (item) => item.quizAttemptId === lastSubmittedAttempt.id,
      );
      const missedPointIds = new Set(
        failedItems
          .filter((item) => item.correct !== null && item.correct < 1)
          .map((item) => item.knowledgePointId),
      );
      const reviewIncomplete = [...missedPointIds].some(
        (pointId) =>
          problems.filter(
            (problem) =>
              problem.practiceOnly &&
              problem.knowledgePointId === pointId &&
              problem.answeredAt !== null &&
              problem.answeredAt > lastSubmittedAt,
          ).length < 3,
      );
      if (reviewIncomplete) return { kind: 'review_required' as const, run };
    }
    if (run.status !== state.status) {
      await tx.patchLessonRun(userId, run.id, {
        status: state.status,
        completedAt: state.status === 'completed' ? (run.completedAt ?? now) : null,
        updatedAt: now,
      });
    }
    const openAttempt = previousAttempts.find((attempt) => attempt.submittedAt === null);
    if (openAttempt) return { kind: 'ready' as const, runId: run.id };
    const previousAttempt = previousAttempts.at(-1);

    const previousAttemptItems = previousAttempt
      ? allQuizItems.filter((item) => item.quizAttemptId === previousAttempt.id)
      : [];
    const selection = selectQuizItems({
      lesson: resolved.lesson,
      exercises: resolved.index.exercisesById,
      servedProblems: problems.map((problem) => ({
        exerciseId: problem.exerciseId,
        seed: problem.seed,
      })),
      previousAttemptItems,
      usedSeeds: new Set([
        ...problems.flatMap((problem) => (problem.seed === null ? [] : [problem.seed])),
        ...allQuizItems.flatMap((item) => (item.seed === null ? [] : [item.seed])),
      ]),
      seed: Math.floor(runtime.random() * 0x7fffffff),
    });
    if (selection.length === 0) return { kind: 'no_questions' as const, run };
    const attemptNo = Math.max(0, ...previousAttempts.map((attempt) => attempt.attemptNo)) + 1;
    await tx.insertLessonQuiz(
      userId,
      run.id,
      {
        attemptNo,
        startedAt: now,
        submittedAt: null,
        score: null,
        passed: null,
      },
      selection.map((item) => ({
        answer: null,
        evidence: null,
        correct: null,
        durationMs: null,
        attemptId: null,
        answeredAt: null,
        position: item.position,
        knowledgePointId: item.pointId,
        exerciseId: item.exerciseId,
        seed: item.seed,
      })),
    );
    return { kind: 'ready' as const, runId: run.id };
  });
}

export async function answerLessonQuiz(
  store: LessonStore,
  runtime: LessonRuntime,
  input: LessonCommand & QuizAnswer,
  grade: LessonGrader,
) {
  const { userId, conceptId, resolved } = input;
  const now = runtime.now();
  return store.transaction(async (tx) => {
    const run = await tx.getLessonRun(
      userId,
      { conceptId, quizItemId: input.itemId },
      { forUpdate: true },
    );
    if (!run) return { kind: 'not_found' as const };
    const { quizAttempts, quizItems } = await loadRunQuiz(
      tx,
      userId,
      run.id,
      resolved.lesson,
      resolved.index,
      runtime,
    );
    const item = quizItems.find((row) => row.id === input.itemId);
    if (!item) return { kind: 'not_found' as const };
    if (
      item.attemptId ||
      quizAttempts.find((attempt) => attempt.id === item.quizAttemptId)?.submittedAt
    ) {
      return { kind: 'conflict' as const, runId: run.id };
    }
    const problems = await listProblemsByPoint(tx, userId, run.id);
    const runState = deriveLessonState(
      resolved.lesson,
      problems,
      resolved.index.exercisesById,
      run.quizPassedAt,
      run.attempt,
    );
    if (runState.status === 'in_progress') {
      return { kind: 'conflict' as const, runId: run.id };
    }
    const indexed = resolved.index.exercisesById.get(item.exerciseId);
    const exercise = indexed ? resolveLessonExercise(indexed, item.seed) : undefined;
    if (!exercise) return { kind: 'invalid' as const };
    const graded = await grade(exercise, input.answer, {
      random: seededRandom(item.id),
      requireAnswer: true,
    });
    if (graded.status !== 'graded') return { kind: 'invalid' as const };
    await tx.patchLessonQuizItem(userId, run.id, item.id, {
      answer: input.answer,
      evidence: lessonQuizEvidence(exercise, graded),
      correct: graded.correct,
      durationMs: input.durationMs ?? null,
      answeredAt: now,
    });
    return { kind: 'answered' as const, runId: run.id };
  });
}

export async function submitLessonQuiz(
  store: PlacementReviewStore,
  runtime: LessonRuntime,
  input: LessonCommand & Attachment,
  host: QuizSubmitHost,
) {
  const { userId, conceptId, timeZone, resolved } = input;
  const now = runtime.now();
  return store.transaction(async (tx) => {
    const run = await tx.getLessonRun(userId, { conceptId }, { forUpdate: true });
    if (!run) return { kind: 'not_found' as const };
    const { quizAttempts, quizItems } = await loadRunQuiz(
      tx,
      userId,
      run.id,
      resolved.lesson,
      resolved.index,
      runtime,
    );
    const latestAttempt = quizAttempts.at(-1);
    if (!latestAttempt) return { kind: 'not_found' as const };
    if (latestAttempt.submittedAt) {
      return { kind: 'already_submitted' as const, runId: run.id };
    }
    const items = quizItems.filter((item) => item.quizAttemptId === latestAttempt.id);
    if (items.some((item) => item.answeredAt === null || item.correct === null)) {
      return { kind: 'unanswered' as const };
    }
    const pendingGrades: Array<{
      item: (typeof items)[number];
      evidence: LessonQuizEvidence;
    }> = [];
    for (const item of items) {
      if (item.attemptId !== null) continue;
      if (item.evidence) {
        pendingGrades.push({ item, evidence: item.evidence });
        continue;
      }
      const indexed = resolved.index.exercisesById.get(item.exerciseId);
      if (!indexed) continue;
      const exercise = resolveLessonExercise(indexed, item.seed);
      if (!exercise) return { kind: 'invalid_answer' as const };
      const graded = await host.grade(exercise, item.answer, { random: seededRandom(item.id) });
      if (graded.status !== 'graded') return { kind: 'invalid_answer' as const };
      pendingGrades.push({ item, evidence: lessonQuizEvidence(exercise, graded) });
    }
    const finalItems = new Map(items.map((item) => [item.id, item]));
    for (const pending of pendingGrades) {
      const { exercise, grade: graded } = pending.evidence;
      const attemptId = runtime.newId();
      const gradedBy = graded.graded_by ?? 'deterministic';
      const credit = calculateCredit({
        correct: graded.correct,
        hintsUsed: 0,
        attemptNo: 1,
        gradedBy,
      });
      await tx.insertAttempt(userId, {
        id: attemptId,
        sessionId: input.sessionId ?? null,
        activityId: input.activityId ?? null,
        exerciseId: exercise.id,
        exerciseVersion: exercise.contentVersion,
        conceptId: exercise.concept,
        dimension: exercise.dimension,
        mode: 'assessment',
        answer: pending.item.answer,
        correct: graded.correct,
        credit,
        hintsUsed: 0,
        attemptNo: 1,
        gradedBy,
        feedback: { message: graded.feedback },
        mistakeCategory: graded.mistake_category ?? null,
        durationMs: pending.item.durationMs,
        createdAt: now,
      });
      await host.applyMastery(tx, {
        learnerId: userId,
        exercise,
        attemptId,
        correct: graded.correct,
        credit,
        hintsUsed: 0,
        attemptNo: 1,
        submitted: true,
        mode: 'assessment',
        gradedBy,
        createReviewCard: false,
        now,
        timeZone,
        enableFuzz: runtime.enableFsrsFuzz,
      });
      const updatedItem = await tx.patchLessonQuizItem(userId, run.id, pending.item.id, {
        evidence: pending.evidence,
        correct: graded.correct,
        attemptId,
      });
      if (!updatedItem) throw new Error('Unable to finalize lesson quiz item');
      finalItems.set(updatedItem.id, updatedItem);
    }
    const submittedItems = items.map((item) => finalItems.get(item.id) ?? item);
    const result = scoreLessonQuiz(submittedItems.map((item) => item.correct ?? 0));
    await tx.patchLessonQuizAttempt(userId, run.id, latestAttempt.id, {
      submittedAt: now,
      score: result.score,
      passed: result.passed,
    });
    let xpAwarded = 0;
    if (result.passed) {
      if (!run.quizPassedAt) {
        await tx.patchLessonRun(userId, run.id, {
          status: 'completed',
          quizPassedAt: now,
          completedAt: now,
          updatedAt: now,
        });
        await tx.setReviewCardSuspension(userId, [conceptId], null);
        const inserted = await tx.insertXpEventOnce(userId, {
          kind: 'quiz',
          sourceKey: `quiz:${run.id}`,
          conceptId,
          amount: items.length,
          earnedAt: now,
          localDate: localDateKey(now, timeZone),
        });
        if (inserted) xpAwarded = items.length;
        const itemsByDimension = new Map<Dimension, (typeof items)[number][]>();
        for (const item of submittedItems) {
          const exercise =
            item.evidence?.exercise ?? resolved.index.exercisesById.get(item.exerciseId);
          if (!exercise) continue;
          const dimensionItems = itemsByDimension.get(exercise.dimension) ?? [];
          dimensionItems.push(item);
          itemsByDimension.set(exercise.dimension, dimensionItems);
        }
        const dimensionRatings = new Map<Dimension, Rating>();
        const speed = await getTopicSpeed(tx, userId, conceptId);
        for (const [dimension, dimensionItems] of itemsByDimension) {
          const rating = reviewActivityRating(
            dimensionItems.map((item) => {
              const exercise =
                item.evidence?.exercise ?? resolved.index.exercisesById.get(item.exerciseId);
              return {
                correct: item.correct ?? 0,
                hintsUsed: 0,
                durationMs: item.durationMs,
                targetSeconds: exercise?.target_seconds,
              };
            }),
          );
          dimensionRatings.set(dimension, rating);
          const existingCard = await tx.getReviewCard(userId, conceptId, dimension, {
            forUpdate: true,
          });
          const scheduled = scheduleReviewWithDetails(
            existingCard?.fsrs ?? newReviewCard(now),
            now,
            rating,
            timeZone,
            runtime.enableFsrsFuzz,
            speed,
          );
          const card = {
            fsrs: scheduled.card,
            dueAt: scheduled.card.due,
            lastReviewAt: now,
            reps: scheduled.card.reps,
            lapses: scheduled.card.lapses,
          };
          if (existingCard) await tx.patchReviewCard(userId, existingCard.id, card);
          const cardId =
            existingCard?.id ??
            (await tx.insertReviewCard(userId, { conceptId, dimension, ...card })).id;
          await tx.appendReviewLog(userId, cardId, {
            attemptId: dimensionItems.find((item) => item.attemptId)?.attemptId ?? undefined,
            rating,
            fsrsLog: { ...scheduled.log, effectiveDueAt: scheduled.card.due },
            speed,
            rawDueAt: scheduled.rawDueAt,
            createdAt: now,
          });
        }
        const ratings = [...dimensionRatings.values()];
        if (
          dimensionRatings.size === itemsByDimension.size &&
          ratings.length > 0 &&
          !ratings.includes(Rating.Again)
        ) {
          await applyImplicitRepetitions(tx, {
            learnerId: userId,
            conceptId,
            rating: ratings.every((rating) => rating === Rating.Good) ? Rating.Good : Rating.Hard,
            index: resolved.index,
            now,
            timeZone,
            enableFuzz: runtime.enableFsrsFuzz,
          });
        }
      }
    } else if (!run.quizPassedAt) {
      await tx.patchLessonRun(userId, run.id, {
        status: 'quiz',
        completedAt: null,
        updatedAt: now,
      });
    }

    const attemptIds = submittedItems.flatMap((item) => (item.attemptId ? [item.attemptId] : []));
    const quizAnswerAttempts = attemptIds.length
      ? await tx.listAttempts(userId, { ids: attemptIds, order: 'unordered' })
      : [];
    const attachedActivityId =
      input.activityId ?? quizAnswerAttempts.find((answer) => answer.activityId)?.activityId;
    if (attachedActivityId) {
      const [activityRow] = await tx.listActivities(userId, { ids: [attachedActivityId] });
      const [sessionRow] = activityRow
        ? await tx.listSessions(userId, { ids: [activityRow.sessionId] })
        : [];
      const session = sessionRow && {
        ...sessionRow,
        activities: await tx.listActivities(userId, { sessionIds: [sessionRow.id] }),
      };
      const sessionActivity = session?.activities.find((item) => item.id === attachedActivityId);
      if (sessionActivity?.kind === 'learn' && sessionActivity.conceptId === conceptId && session) {
        await updateActivityAndAdvance(tx, {
          userId,
          activityId: sessionActivity.id,
          completed: true,
          now,
          session,
          exerciseIds: sessionActivity.exerciseIds,
          progress: sessionActivity.progress,
          knowledgePointActivity: true,
        });
      }
    }
    return { kind: 'submitted' as const, runId: run.id, xpAwarded };
  });
}
