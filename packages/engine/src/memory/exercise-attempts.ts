import type { ContentIndex, IndexedExercise } from '../course/types.js';
import { isExplainItBeforeQuiz } from '../lessons/initial-learn-progress.js';
import {
  applyPlacementGrantOutcome,
  placementCreditWithdrawn,
} from '../placement/grant-commands.js';
import { updateActivityAndAdvance } from '../planner/activity-advance.js';
import { reviewActivityReason } from '../planner/review-topics.js';
import type { Attempt } from '../store/core-store.js';
import type { FlowStore } from '../store/flow-store.js';
import type { PlacementReviewStore } from '../store/placement-review-store.js';
import type { Activity } from '../store/session-store.js';
import { hintsSincePreviousAttempt } from './hint-evidence.js';
import { calculateCredit } from './mastery.js';
import { applyMastery } from './mastery-service.js';
import { attemptAllowsRetry } from './retry.js';
import {
  completeReviewActivity,
  type ReviewScheduler,
  recordRecoveredReviewRatings,
  recordReviewRating,
} from './review-completion.js';
import type { GradedBy, MasteryRecord } from './types.js';

export type ExerciseSubmission = {
  activityId?: string;
  mode: Attempt['mode'];
  answer: unknown;
  durationMs?: number;
};

type Session = { id: string; activities: Activity[] };
type LoadSession = (id: string) => Promise<Session | undefined>;

export async function prepareExerciseAttempt(
  store: PlacementReviewStore,
  userId: string,
  index: ContentIndex,
  exercise: IndexedExercise,
  input: ExerciseSubmission,
  loadSession: LoadSession,
) {
  const [activityRow] = input.activityId
    ? await store.listActivities(userId, { ids: [input.activityId] })
    : [];
  const session = activityRow ? await loadSession(activityRow.sessionId) : undefined;
  const activity = session?.activities.find((item) => item.id === input.activityId);
  if (input.activityId && !activity) {
    return { kind: 'not_found' as const, body: { error: 'Activity not found' } };
  }
  if (input.mode === 'review' && !input.activityId) {
    return { kind: 'invalid' as const, body: { error: 'Review attempts need a review activity.' } };
  }
  const inlineLessonExercise =
    activity?.kind === 'learn' &&
    typeof activity.conceptId === 'string' &&
    index.lessonsByConcept
      .get(activity.conceptId)
      ?.blocks.some((block) => 'exercise' in block && block.exercise === exercise.id);
  if (activity && !activity.exerciseIds.includes(exercise.id) && !inlineLessonExercise) {
    return { kind: 'invalid' as const, body: { error: 'Exercise is not part of this activity.' } };
  }
  if (
    activity &&
    activity.kind === 'quick_check' &&
    input.mode !== 'diagnostic' &&
    input.mode !== 'assessment'
  ) {
    return { kind: 'invalid' as const, body: { error: 'This activity requires assessment mode.' } };
  }
  if (activity?.kind === 'review' && input.mode !== 'review') {
    return { kind: 'invalid' as const, body: { error: 'Review attempts must use review mode.' } };
  }
  if (
    activity &&
    activity.kind !== 'review' &&
    activity.kind !== 'quick_check' &&
    input.mode !== 'practice'
  ) {
    return { kind: 'invalid' as const, body: { error: 'This activity requires practice mode.' } };
  }
  if (activity && activity.kind !== 'review' && input.mode === 'review') {
    return {
      kind: 'invalid' as const,
      body: { error: 'Review mode is only available for review activities.' },
    };
  }
  const previousAttempts = input.activityId
    ? await store.listAttempts(userId, {
        activityIds: [input.activityId],
        exerciseIds: [exercise.id],
        order: 'activity_attempt_no',
      })
    : [];
  const priorAttemptForRetry = previousAttempts.at(-1);
  if (input.mode === 'practice' && previousAttempts.length >= 2) {
    return {
      kind: 'conflict' as const,
      body: {
        error: 'No retries remain.',
        ...(exercise.type === 'explain'
          ? { exemplar: exercise.exemplar }
          : { solution: exercise.solution }),
      },
    };
  }
  if (
    input.mode !== 'practice' &&
    priorAttemptForRetry &&
    !attemptAllowsRetry(priorAttemptForRetry)
  ) {
    return { kind: 'conflict' as const, body: { error: 'This activity allows one attempt.' } };
  }
  return {
    kind: 'ready' as const,
    attemptNo: previousAttempts.length + 1,
    sessionId: activityRow?.sessionId,
    session,
    activity,
    exercise,
    index,
    input,
    userId,
  };
}

type PreparedExercise = Extract<
  Awaited<ReturnType<typeof prepareExerciseAttempt>>,
  { kind: 'ready' }
>;
type GradedAnswer = {
  correct: number;
  feedback: string;
  gradedBy?: GradedBy;
  mistakeCategory?: string;
  yourAnswer?: unknown;
  rubric?: unknown;
};

export async function recordExerciseAttempt(
  store: FlowStore,
  runtime: ReviewScheduler & {
    now: () => Date;
    newId: () => string;
    session: LoadSession;
  },
  prepared: PreparedExercise,
  grade: GradedAnswer,
  timeZone: string,
) {
  const { userId, index, exercise, input, attemptNo, sessionId, session } = prepared;
  let { activity } = prepared;
  const followUp =
    (input.mode === 'practice' || input.mode === 'review') &&
    exercise.type === 'explain' &&
    grade.correct > 0 &&
    grade.correct < 1 &&
    attemptNo < 2;
  const retryAllowed =
    attemptNo < 2 &&
    ((input.mode === 'practice' && grade.correct === 0) ||
      ((input.mode === 'practice' || input.mode === 'review') && followUp));
  const answerWithheld = retryAllowed;
  const now = runtime.now();
  const attemptId = runtime.newId();
  const gradedBy = grade.gradedBy ?? 'deterministic';
  const hintsUsed = await hintsSincePreviousAttempt(store, userId, exercise.id, input.activityId);
  const credit = calculateCredit({
    correct: grade.correct,
    hintsUsed,
    attemptNo,
    gradedBy,
    followUp,
  });
  await store.insertAttempt(userId, {
    id: attemptId,
    sessionId: sessionId ?? null,
    activityId: input.activityId ?? null,
    exerciseId: exercise.id,
    exerciseVersion: exercise.contentVersion,
    conceptId: exercise.concept,
    dimension: exercise.dimension,
    mode: input.mode,
    answer: input.answer,
    correct: grade.correct,
    credit,
    hintsUsed,
    attemptNo,
    gradedBy,
    feedback: {
      message: grade.feedback,
      status: 'graded',
      ...(grade.yourAnswer !== undefined ? { yourAnswer: grade.yourAnswer } : {}),
      ...(grade.rubric !== undefined ? { rubric: grade.rubric } : {}),
      ...(exercise.type === 'explain' && !answerWithheld
        ? {
            exemplar: exercise.exemplar,
            ...(exercise.solution ? { solution: exercise.solution } : {}),
          }
        : {}),
      ...(followUp ? { followUp: true } : {}),
    },
    mistakeCategory: grade.mistakeCategory ?? null,
    durationMs: input.durationMs ?? null,
    createdAt: now,
  });
  const withdrawnCredit = await placementCreditWithdrawn(store, userId, exercise.concept);
  const masteryResult = await applyMastery(store, {
    learnerId: userId,
    exercise,
    attemptId,
    correct: grade.correct,
    credit,
    hintsUsed,
    attemptNo,
    submitted: true,
    mode: input.mode,
    gradedBy,
    followUp,
    now,
    timeZone,
    enableFuzz: runtime.enableFsrsFuzz,
    ...(withdrawnCredit ? { createReviewCard: false } : {}),
  });
  if (input.mode === 'review' && !followUp && activity?.kind === 'review') {
    activity = await recordReviewRating(
      store,
      runtime,
      {
        index,
        userId,
        timeZone,
        now,
        session,
      },
      activity,
      exercise,
      attemptId,
    );
  }
  if (!followUp) {
    await applyPlacementGrantOutcome({
      store,
      userId,
      content: index,
      exerciseId: exercise.id,
      attemptId,
      mode: input.mode,
      correct: grade.correct,
      hintsUsed,
      attemptNo,
      gradedBy,
      now,
    });
  }
  let activityCompleted = false;
  if (sessionId && activity && !retryAllowed) {
    const progress = activity.progress as {
      completedExerciseIds?: string[];
      outcomes?: Record<string, 'correct' | 'incorrect'>;
    };
    const outcomes = {
      ...(progress.outcomes ?? {}),
      [exercise.id]: grade.correct > 0 ? 'correct' : 'incorrect',
    };
    const completedExerciseIds = [
      ...new Set([...(progress.completedExerciseIds ?? []), exercise.id]),
    ];
    let exerciseIds = activity.exerciseIds;
    let learningGoalMet = false;
    let lessonFinalNeedsQuiz = false;
    if (activity.kind === 'learn' && activity.conceptId) {
      const mastery = masteryResult.mastery as MasteryRecord;
      const lesson = index.lessonsByConcept.get(activity.conceptId);
      const finalExercise = lesson?.final === exercise.id;
      lessonFinalNeedsQuiz = isExplainItBeforeQuiz(lesson, exercise.id);
      learningGoalMet =
        finalExercise || (mastery.independentItemIds.length >= 2 && mastery.lastIndependentCorrect);
      if (!learningGoalMet) {
        const recentIds = new Set(
          (await store.listAttempts(userId, { limit: 100, order: 'recent' }))
            .filter((attempt) => now.getTime() - attempt.createdAt.getTime() < 7 * 86_400_000)
            .map((attempt) => attempt.exerciseId),
        );
        const nextExercise = (index.exercisesByConcept.get(activity.conceptId) ?? []).find(
          (candidate) =>
            candidate.dimension === exercise.dimension &&
            (candidate.role === 'core' || candidate.role === 'check') &&
            !exerciseIds.includes(candidate.id) &&
            !recentIds.has(candidate.id),
        );
        if (nextExercise) {
          exerciseIds = [...exerciseIds, nextExercise.id];
        }
      }
    }
    let completed =
      !lessonFinalNeedsQuiz &&
      (learningGoalMet || exerciseIds.every((id) => completedExerciseIds.includes(id)));
    if (
      completed &&
      activity.kind === 'review' &&
      reviewActivityReason(activity.reason).removedQuestions
    ) {
      activity = await recordRecoveredReviewRatings(
        store,
        runtime,
        { index, userId, timeZone, now, session },
        activity,
      );
      exerciseIds = activity.exerciseIds;
      completed = exerciseIds.every((id) => completedExerciseIds.includes(id));
    }
    activityCompleted = completed;
    const sessionForAdvance =
      completed && session ? ((await runtime.session(session.id)) ?? session) : session;
    const activityProgress = { ...progress, completedExerciseIds, outcomes };
    if (completed && activity.kind === 'review') {
      await completeReviewActivity(
        store,
        {
          index,
          userId,
          timeZone,
          now,
          session: sessionForAdvance,
        },
        activity,
        activityProgress,
      );
    } else {
      await updateActivityAndAdvance(store, {
        activityId: activity.id,
        completed,
        now,
        session: sessionForAdvance,
        exerciseIds,
        progress: activityProgress,
        userId,
        timeZone,
        knowledgePointActivity: Boolean(
          activity.kind === 'learn' &&
            activity.conceptId &&
            index.lessonsByConcept.get(activity.conceptId)?.knowledge_points?.length,
        ),
      });
    }
  }
  const step =
    activity?.kind === 'review' || activity?.kind === 'practice'
      ? (() => {
          const lesson = index.lessonsByConcept.get(exercise.concept);
          const pointId =
            exercise.role === 'recall'
              ? exercise.knowledge_point
              : lesson?.knowledge_points?.find((point) => point.problems.includes(exercise.id))?.id;
          const point = lesson?.knowledge_points?.find((candidate) => candidate.id === pointId);
          return point
            ? { conceptId: exercise.concept, pointId: point.id, title: point.title }
            : undefined;
        })()
      : undefined;
  return {
    attemptId,
    attemptNo,
    hintsUsed,
    credit,
    mastery: masteryResult,
    retryAllowed,
    activityCompleted,
    step,
    followUp,
  };
}
