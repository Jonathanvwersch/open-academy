import type { AttemptResponse } from '@academy/contracts/exercises';
import { emptyAnswerMessage } from '@academy/shared/answer-validation';
import { onScreenOptions } from '@academy/shared/shuffle';
import { and, asc, desc, eq, gt, inArray } from 'drizzle-orm';
import type { Card } from 'ts-fsrs';
import { Rating } from 'ts-fsrs';
import { z } from 'zod';
import { serializedOptionOrder, serializeExercise } from '../../content/serialize.js';
import { isTemplate } from '../../content/templates.js';
import type { IndexedExercise } from '../../content/types.js';
import {
  attempts,
  reviewCards,
  reviewLogs,
  sessionActivities,
  tutorMessages,
} from '../../db/schema.js';
import { updateActivityAndAdvance } from '../../learning/activity-completion.js';
import { answerOptionsFor } from '../../learning/answer-options.js';
import { isDueToday, reviewActivityRating, scheduleReview } from '../../learning/fsrs.js';
import { gradeExercise } from '../../learning/grading/index.js';
import { rubricFeedbackWithScoredFlags } from '../../learning/grading/rubric-score.js';
import { calculateCredit } from '../../learning/mastery.js';
import { applyMastery, creditHardPrerequisites } from '../../learning/mastery-service.js';
import {
  bringWeakestPrerequisiteCardDueNow,
  canBringPrerequisiteDueNow,
} from '../../learning/prerequisite-review.js';
import { attemptAllowsRetry } from '../../learning/retry.js';
import { buildReviewActivityForConcept } from '../../learning/scheduler.js';
import type { MasteryRecord } from '../../learning/types.js';
import { type FeatureRequest, type FeatureServices, serviceResult } from '../../service-context.js';
import {
  formatGraderFeedback,
  graderVerdictFor,
  tutorAnswerFor,
  tutorAnswerKeyFor,
  tutorSolutionFor,
} from '../tutor/feedback-context.js';
import { scoreRubric } from '../tutor/scoring.js';
import { hintsSincePreviousAttempt } from './hint-history.js';

type TutorGradeResult = {
  status: 'graded';
  correct: number;
  feedback: string;
  graded_by: 'llm';
  mistake_category?: string;
  rubric: Array<{
    id: string;
    criterion: string;
    judgement: 'met' | 'partial' | 'missing';
    required: boolean;
  }>;
  exemplar: string;
};
export async function getExercisesById(deps: FeatureServices, request: FeatureRequest) {
  const { content } = deps;
  const exercise = (await content()).exercisesById.get(request.params.id);
  if (exercise && isTemplate(exercise)) {
    return serviceResult(
      { error: 'Template exercises are only available through a lesson run.' },
      400,
    );
  }
  return exercise
    ? serviceResult(serializeExercise(exercise, request.userId))
    : serviceResult({ error: 'Exercise not found' }, 404);
}

export async function postHints(deps: FeatureServices, request: FeatureRequest) {
  const { db, content, tutorProvider } = deps;
  const body = z
    .object({
      exerciseId: z.string(),
      activityId: z.string().uuid().optional(),
      mode: z.enum(['practice', 'review', 'assessment', 'diagnostic']).default('practice'),
      stuck: z.boolean().default(false),
      revealSolution: z.boolean().default(false),
    })
    .safeParse(request.body);
  if (!body.success) {
    return serviceResult({ error: 'Invalid hint request' }, 400);
  }
  if (body.data.mode === 'assessment' || body.data.mode === 'diagnostic') {
    return serviceResult({ error: 'Hints are unavailable in assessment mode.' }, 403);
  }
  if (body.data.mode === 'review' && !body.data.stuck) {
    return serviceResult(
      { error: 'Confirm that you are stuck before requesting review help.' },
      400,
    );
  }
  const exercise = (await content()).exercisesById.get(body.data.exerciseId);
  if (!exercise) {
    return serviceResult({ error: 'Exercise not found' }, 404);
  }
  const solution = exercise.solution ?? (exercise.type === 'explain' ? exercise.exemplar : '');
  if (exercise.role === 'diagnostic') {
    return serviceResult({ error: 'Placement check exercises do not allow hints.' }, 403);
  }
  if (body.data.activityId) {
    const [activityRow] = await db
      .select()
      .from(sessionActivities)
      .where(eq(sessionActivities.id, body.data.activityId))
      .limit(1);
    const session = activityRow ? await request.repo.session(activityRow.sessionId) : undefined;
    const activity = session?.activities.find((item) => item.id === body.data.activityId);
    if (!activity?.exerciseIds.includes(exercise.id)) {
      return serviceResult({ error: 'Activity or exercise not found' }, 404);
    }
    if (activity.kind === 'quick_check') {
      return serviceResult({ error: 'Assessment activities do not allow hints.' }, 403);
    }
    if (
      (activity.kind === 'review' && body.data.mode !== 'review') ||
      (activity.kind !== 'review' && body.data.mode !== 'practice')
    ) {
      return serviceResult({ error: 'Hint mode does not match this activity.' }, 400);
    }
  }
  const hintsUsed = await hintsSincePreviousAttempt(
    db,
    request.userId,
    exercise.id,
    body.data.activityId,
  );
  const hints = (exercise as IndexedExercise & { hints?: string[] }).hints ?? [];
  if (body.data.revealSolution) {
    if (hintsUsed >= 5)
      return serviceResult({ error: 'The solution has already been revealed.' }, 409);
    const [event] = await request.repo.saveHintEvent({
      activityId: body.data.activityId,
      exerciseId: exercise.id,
      level: 5,
      text: solution,
      createdAt: request.now(),
    });
    return serviceResult({
      level: 5,
      text: solution,
      revealedSolution: true,
      hintEventId: event?.id,
    });
  }
  const level = hintsUsed + 1;
  let text = hints[level - 1];
  let generated = false;
  if (!text && level <= 4 && tutorProvider) {
    const index = await content();
    const concept = index.conceptsById.get(exercise.concept);
    const lesson = index.lessonsByConcept.get(exercise.concept);
    const recentAttempts = await request.repo.recentAttempts(100);
    const recentMistakes = recentAttempts
      .filter((attempt) => attempt.conceptId === exercise.concept && attempt.mistakeCategory)
      .slice(0, 5)
      .map((attempt) => attempt.mistakeCategory ?? '');
    const priorAttempt = recentAttempts.find((attempt) => attempt.exerciseId === exercise.id);
    const retrying = priorAttempt ? attemptAllowsRetry(priorAttempt) : false;
    const problemStatus = !priorAttempt ? 'unanswered' : retrying ? 'retrying' : 'answered';
    const tutorService = request.tutor;
    if (!tutorService) {
      return serviceResult({
        level,
        hasMore: level < hints.length,
        revealedSolution: false,
      });
    }
    const optionTexts =
      exercise.type === 'mc'
        ? onScreenOptions(
            serializedOptionOrder(exercise.options, request.userId, exercise.id),
            exercise.id,
          )
        : exercise.type === 'debug'
          ? onScreenOptions(exercise.fix_options, exercise.id)
          : [];
    const generatedHint = await tutorService.respond(
      {
        conceptTitle: concept?.title ?? exercise.concept,
        objectives: concept?.objectives.map((objective) => objective.text) ?? [],
        lessonSummary:
          lesson?.blocks
            .filter((block) => block.kind === 'summary')
            .map((block) => block.md)
            .join('\n') ?? '',
        exercisePrompt: exercise.prompt,
        exerciseLabel: 'Current question',
        exerciseOptions: optionTexts.map(
          ({ text }, index) => `${String.fromCharCode(65 + index)}. ${text}`,
        ),
        answerKey: tutorAnswerKeyFor(exercise, optionTexts),
        learnerAnswer: priorAttempt ? tutorAnswerFor(exercise, priorAttempt.answer) : '',
        graderVerdict: priorAttempt ? graderVerdictFor(priorAttempt.correct) : 'No prior answer.',
        graderFeedback: priorAttempt ? formatGraderFeedback(priorAttempt.feedback, retrying) : '',
        hintLevel: level,
        authoredHints: hints,
        solution: problemStatus === 'answered' ? tutorSolutionFor(exercise) : '',
        recentMistakes,
        history: [],
        problem_status: problemStatus,
        page: 'none',
        page_content: '',
      },
      level === 1 ? 'nudge' : level === 2 ? 'hint' : 'worked_step',
      index,
    );
    if (generatedHint.status === 'ok' && generatedHint.value) {
      text = generatedHint.value.message_md;
      generated = true;
    } else {
      return serviceResult({
        level,
        hasMore: false,
        revealedSolution: false,
        tutorUnavailable: true,
      });
    }
  }
  if (!text && !tutorProvider) {
    return serviceResult({
      level,
      hasMore: level < hints.length,
      revealedSolution: false,
    });
  }
  if (!text || level > 4) {
    return serviceResult({ level, hasMore: false, revealedSolution: false });
  }
  const [event] = await request.repo.saveHintEvent({
    activityId: body.data.activityId,
    exerciseId: exercise.id,
    level,
    text,
    source: generated ? 'llm' : 'authored',
    createdAt: request.now(),
  });
  return serviceResult({
    level,
    text,
    hasMore: tutorProvider ? level < Math.max(hints.length, 4) : level < hints.length,
    revealedSolution: false,
    hintEventId: event?.id,
  });
}

export async function postAttempts(deps: FeatureServices, request: FeatureRequest) {
  const { db, content, tutorProvider } = deps;
  const body = z
    .object({
      exerciseId: z.string(),
      activityId: z.string().uuid().optional(),
      answer: z.unknown(),
      mode: z.enum(['practice', 'assessment', 'diagnostic', 'review']).default('practice'),
      durationMs: z.number().int().nonnegative().optional(),
    })
    .safeParse(request.body);
  if (!body.success) {
    return serviceResult({ error: 'Invalid attempt' }, 400);
  }
  const index = await content();
  const exercise = index.exercisesById.get(body.data.exerciseId);
  if (!exercise) {
    return serviceResult({ error: 'Exercise not found' }, 404);
  }
  const emptyMessage = emptyAnswerMessage(exercise.type, body.data.answer);
  if (emptyMessage) return serviceResult({ error: emptyMessage }, 422);
  if (isTemplate(exercise)) {
    return serviceResult(
      { error: 'Template exercises must be answered through a lesson run.' },
      400,
    );
  }
  const repo = request.repo;
  const [activityRow] = body.data.activityId
    ? await db
        .select()
        .from(sessionActivities)
        .where(eq(sessionActivities.id, body.data.activityId))
        .limit(1)
    : [];
  const session = activityRow ? await repo.session(activityRow.sessionId) : undefined;
  const activity = session?.activities.find((item) => item.id === body.data.activityId);
  if (body.data.activityId && !activity) {
    return serviceResult({ error: 'Activity not found' }, 404);
  }
  if (body.data.mode === 'review' && !body.data.activityId) {
    return serviceResult({ error: 'Review attempts need a review activity.' }, 400);
  }
  const inlineLessonExercise =
    activity?.kind === 'learn' &&
    typeof activity.conceptId === 'string' &&
    index.lessonsByConcept
      .get(activity.conceptId)
      ?.blocks.some((block) => 'exercise' in block && block.exercise === exercise.id);
  if (activity && !activity.exerciseIds.includes(exercise.id) && !inlineLessonExercise) {
    return serviceResult({ error: 'Exercise is not part of this activity.' }, 400);
  }
  if (
    activity &&
    activity.kind === 'quick_check' &&
    body.data.mode !== 'diagnostic' &&
    body.data.mode !== 'assessment'
  ) {
    return serviceResult({ error: 'This activity requires assessment mode.' }, 400);
  }
  if (activity?.kind === 'review' && body.data.mode !== 'review') {
    return serviceResult({ error: 'Review attempts must use review mode.' }, 400);
  }
  if (
    activity &&
    activity.kind !== 'review' &&
    activity.kind !== 'quick_check' &&
    body.data.mode !== 'practice'
  ) {
    return serviceResult({ error: 'This activity requires practice mode.' }, 400);
  }
  if (activity && activity.kind !== 'review' && body.data.mode === 'review') {
    return serviceResult({ error: 'Review mode is only available for review activities.' }, 400);
  }
  const previousAttempts = body.data.activityId
    ? await repo.attemptsForActivity(body.data.activityId, exercise.id)
    : [];
  const priorAttemptForRetry = previousAttempts.at(-1);
  if (body.data.mode === 'practice' && previousAttempts.length >= 2) {
    return serviceResult(
      {
        error: 'No retries remain.',
        ...(exercise.type === 'explain'
          ? { exemplar: exercise.exemplar }
          : { solution: exercise.solution }),
      },
      409,
    );
  }
  if (
    body.data.mode !== 'practice' &&
    priorAttemptForRetry &&
    !attemptAllowsRetry(priorAttemptForRetry)
  ) {
    return serviceResult({ error: 'This activity allows one attempt.' }, 409);
  }
  const attemptNo = previousAttempts.length + 1;
  let result: Awaited<ReturnType<typeof gradeExercise>> | TutorGradeResult;
  if (
    exercise.type === 'explain' &&
    tutorProvider &&
    typeof body.data.answer === 'object' &&
    body.data.answer !== null &&
    'text' in body.data.answer &&
    typeof body.data.answer.text === 'string'
  ) {
    const tutorService = request.tutor;
    const judged = tutorService
      ? await tutorService.gradeExplanation({
          question: exercise.prompt,
          rubric: exercise.rubric,
          exemplar: exercise.exemplar,
          answer: body.data.answer.text,
        })
      : { status: 'fallback' as const };
    if (judged.status === 'ok' && judged.value) {
      const score = scoreRubric(exercise.rubric, judged.value);
      result = {
        status: 'graded' as const,
        correct: score.score,
        feedback: score.feedback,
        graded_by: 'llm' as const,
        rubric: exercise.rubric.map((criterion) => ({
          id: criterion.id,
          criterion: criterion.criterion,
          required: criterion.required,
          judgement:
            judged.value?.criteria.find((entry) => entry.id === criterion.id)?.judgement ??
            'missing',
        })),
        exemplar: exercise.exemplar,
      };
    } else {
      result = await gradeExercise(exercise, body.data.answer);
    }
  } else {
    result = await gradeExercise(exercise, body.data.answer);
  }
  const rubricForFeedback =
    exercise.type === 'explain' && 'rubric' in result && Array.isArray(result.rubric)
      ? rubricFeedbackWithScoredFlags(exercise.rubric, result.rubric)
      : undefined;
  if (result.status !== 'graded') {
    return serviceResult(
      exercise.type === 'explain' && result.status === 'self_check_required'
        ? {
            ...result,
            ...(rubricForFeedback ? { rubric: rubricForFeedback } : {}),
            ...(typeof body.data.answer === 'object' &&
            body.data.answer !== null &&
            'text' in body.data.answer &&
            typeof body.data.answer.text === 'string'
              ? { yourAnswer: body.data.answer.text }
              : {}),
            exemplar: exercise.exemplar,
            ...(exercise.solution ? { solution: exercise.solution } : {}),
          }
        : result,
      result.status === 'invalid' ? 422 : 200,
    );
  }
  const followUp =
    (body.data.mode === 'practice' || body.data.mode === 'review') &&
    exercise.type === 'explain' &&
    result.correct > 0 &&
    result.correct < 1 &&
    attemptNo < 2;
  const now = request.now();
  const attemptId = crypto.randomUUID();
  const gradedBy = result.graded_by ?? 'deterministic';
  const hintCount = await hintsSincePreviousAttempt(
    db,
    request.userId,
    exercise.id,
    body.data.activityId,
  );
  let previousAttempt: (typeof previousAttempts)[number] | undefined;
  for (const attempt of previousAttempts) {
    if (!previousAttempt || attempt.createdAt > previousAttempt.createdAt) {
      previousAttempt = attempt;
    }
  }
  let tutorAssisted = false;
  if (body.data.activityId) {
    const [message] = await db
      .select({ id: tutorMessages.id })
      .from(tutorMessages)
      .where(
        and(
          eq(tutorMessages.userId, request.userId),
          eq(tutorMessages.activityId, body.data.activityId),
          eq(tutorMessages.exerciseId, exercise.id),
          eq(tutorMessages.role, 'user'),
          ...(previousAttempt ? [gt(tutorMessages.createdAt, previousAttempt.createdAt)] : []),
        ),
      )
      .limit(1);
    tutorAssisted = Boolean(message);
  }
  const hintsUsed = Math.max(hintCount, tutorAssisted ? 1 : 0);
  const credit = calculateCredit({
    correct: result.correct,
    hintsUsed,
    attemptNo,
    gradedBy,
    followUp,
  });
  const sessionId = activityRow?.sessionId;
  await db.insert(attempts).values({
    id: attemptId,
    userId: request.userId,
    sessionId,
    activityId: body.data.activityId,
    exerciseId: exercise.id,
    exerciseVersion: exercise.contentVersion,
    conceptId: exercise.concept,
    dimension: exercise.dimension,
    mode: body.data.mode,
    answer: body.data.answer,
    correct: result.correct,
    credit,
    hintsUsed,
    attemptNo,
    gradedBy,
    feedback: {
      message: result.feedback,
      status: result.status,
      ...('yourAnswer' in result ? { yourAnswer: result.yourAnswer } : {}),
      ...('rubric' in result ? { rubric: rubricForFeedback ?? result.rubric } : {}),
      ...(exercise.type === 'explain' && !followUp
        ? {
            exemplar: exercise.exemplar,
            ...(exercise.solution ? { solution: exercise.solution } : {}),
          }
        : {}),
      ...(followUp ? { followUp: true } : {}),
    },
    mistakeCategory: result.mistake_category,
    durationMs: body.data.durationMs,
    createdAt: now,
  });
  const masteryResult = await applyMastery({
    repo,
    userId: request.userId,
    exercise,
    attemptId,
    correct: result.correct,
    credit,
    hintsUsed,
    attemptNo,
    mode: body.data.mode,
    gradedBy,
    followUp,
    now,
    timeZone: request.timeZone,
  });
  if (body.data.mode === 'review' && !followUp) {
    const [card] = await db
      .select()
      .from(reviewCards)
      .where(
        and(
          eq(reviewCards.userId, request.userId),
          eq(reviewCards.conceptId, exercise.concept),
          eq(reviewCards.dimension, exercise.dimension),
        ),
      )
      .limit(1);
    if (card) {
      if (activity?.kind === 'review' && body.data.activityId && activity.exerciseIds.length > 0) {
        const topicExerciseIds = activity.exerciseIds.filter((exerciseId) => {
          const indexedExercise = index.exercisesById.get(exerciseId);
          return (
            indexedExercise?.concept === card.conceptId &&
            indexedExercise.dimension === card.dimension
          );
        });
        const activityAttempts = await db
          .select()
          .from(attempts)
          .where(
            and(
              eq(attempts.activityId, body.data.activityId),
              inArray(attempts.exerciseId, topicExerciseIds),
            ),
          )
          .orderBy(asc(attempts.createdAt), asc(attempts.attemptNo));
        const exerciseAttempts = topicExerciseIds.map((exerciseId) =>
          activityAttempts.filter((attempt) => attempt.exerciseId === exerciseId),
        );
        if (exerciseAttempts.every((items) => items.length > 0)) {
          const [existingLog] = await db
            .select({ id: reviewLogs.id })
            .from(reviewLogs)
            .innerJoin(attempts, eq(reviewLogs.attemptId, attempts.id))
            .where(
              and(eq(attempts.activityId, body.data.activityId), eq(reviewLogs.cardId, card.id)),
            )
            .limit(1);
          if (!existingLog) {
            const rating = reviewActivityRating(
              exerciseAttempts.map((items) => {
                const lastAttempt = items.at(-1);
                const reviewedExercise = lastAttempt
                  ? index.exercisesById.get(lastAttempt.exerciseId)
                  : undefined;
                return {
                  correct: lastAttempt?.correct ?? 0,
                  hintsUsed: items.reduce((total, attempt) => total + attempt.hintsUsed, 0),
                  durationMs: lastAttempt?.durationMs,
                  targetSeconds: reviewedExercise?.target_seconds,
                };
              }),
            );
            const [previousLog] =
              rating === Rating.Again
                ? await db
                    .select({ rating: reviewLogs.rating })
                    .from(reviewLogs)
                    .where(eq(reviewLogs.cardId, card.id))
                    .orderBy(desc(reviewLogs.createdAt))
                    .limit(1)
                : [];
            const scheduled = scheduleReview(
              card.fsrs as never,
              now,
              rating,
              request.timeZone,
              process.env.NODE_ENV !== 'test',
            );
            await db
              .update(reviewCards)
              .set({
                fsrs: scheduled.card,
                dueAt: scheduled.card.due,
                lastReviewAt: now,
                reps: scheduled.card.reps,
                lapses: scheduled.card.lapses,
              })
              .where(eq(reviewCards.id, card.id));
            await db.insert(reviewLogs).values({
              cardId: card.id,
              attemptId,
              rating: String(rating),
              fsrsLog: scheduled.log,
              createdAt: now,
            });
            if (rating === Rating.Good) {
              await creditHardPrerequisites(db, {
                userId: request.userId,
                conceptId: card.conceptId,
                index,
                now,
                timeZone: request.timeZone,
              });
            }
            if (rating === Rating.Again && previousLog?.rating === String(Rating.Again)) {
              const hardPrerequisiteIds =
                index.conceptsById
                  .get(card.conceptId)
                  ?.prereqs.filter((prerequisite) => prerequisite.strength === 'hard')
                  .map((prerequisite) => prerequisite.id) ?? [];
              if (hardPrerequisiteIds.length > 0) {
                const prerequisiteCards = await db
                  .select({
                    id: reviewCards.id,
                    conceptId: reviewCards.conceptId,
                    dimension: reviewCards.dimension,
                    dueAt: reviewCards.dueAt,
                    lastReviewAt: reviewCards.lastReviewAt,
                    fsrs: reviewCards.fsrs,
                  })
                  .from(reviewCards)
                  .where(
                    and(
                      eq(reviewCards.userId, request.userId),
                      inArray(reviewCards.conceptId, hardPrerequisiteIds),
                    ),
                  );
                const coveredConceptIds = new Set(
                  (activity?.exerciseIds ?? []).flatMap((exerciseId) => {
                    const conceptId = index.exercisesById.get(exerciseId)?.concept;
                    return conceptId ? [conceptId] : [];
                  }),
                );
                const weakest = bringWeakestPrerequisiteCardDueNow(
                  prerequisiteCards
                    .filter((prerequisiteCard) =>
                      canBringPrerequisiteDueNow({
                        lastReviewAt: prerequisiteCard.lastReviewAt,
                        now,
                        timeZone: request.timeZone,
                        coveredByActivity: coveredConceptIds.has(prerequisiteCard.conceptId),
                      }),
                    )
                    .map((prerequisiteCard) => ({
                      ...prerequisiteCard,
                      fsrs: prerequisiteCard.fsrs as Card,
                    })),
                  now,
                  process.env.NODE_ENV !== 'test',
                );
                if (weakest) {
                  const schedulerState = await repo.schedulerState(now, index);
                  const stateWithWeakestDueNow = {
                    ...schedulerState,
                    cards: schedulerState.cards.map((card) =>
                      card.conceptId === weakest.conceptId && card.dimension === weakest.dimension
                        ? { ...card, dueAt: weakest.dueAt.toISOString() }
                        : card,
                    ),
                  };
                  const dueCardsForConcept = stateWithWeakestDueNow.cards.filter(
                    (card) =>
                      card.conceptId === weakest.conceptId &&
                      isDueToday(
                        card.dueAt,
                        now,
                        stateWithWeakestDueNow.timezone ?? request.timeZone,
                      ),
                  );
                  const usedExerciseIds = [
                    ...(schedulerState.usedExerciseIds ?? []),
                    ...(session?.activities.flatMap(
                      (sessionActivity) => sessionActivity.exerciseIds,
                    ) ?? []),
                  ];
                  const reviewActivity = buildReviewActivityForConcept(
                    { ...stateWithWeakestDueNow, usedExerciseIds },
                    index,
                    now,
                    weakest.conceptId,
                    dueCardsForConcept,
                  );
                  await db.transaction(async (tx) => {
                    await tx
                      .update(reviewCards)
                      .set({ dueAt: weakest.dueAt, fsrs: weakest.fsrs })
                      .where(eq(reviewCards.id, weakest.id));
                    if (!reviewActivity || !activityRow || activity?.kind !== 'review') return;
                    const sessionReviewActivities = await tx
                      .select({
                        kind: sessionActivities.kind,
                        status: sessionActivities.status,
                        exerciseIds: sessionActivities.exerciseIds,
                      })
                      .from(sessionActivities)
                      .where(eq(sessionActivities.sessionId, activityRow.sessionId));
                    const alreadyCovered = sessionReviewActivities.some(
                      (sessionActivity) =>
                        sessionActivity.kind === 'review' &&
                        ['planned', 'in_progress'].includes(sessionActivity.status) &&
                        sessionActivity.exerciseIds.some(
                          (exerciseId) =>
                            index.exercisesById.get(exerciseId)?.concept === weakest.conceptId,
                        ),
                    );
                    if (alreadyCovered) return;
                    const laterPlanned = await tx
                      .select({ id: sessionActivities.id, idx: sessionActivities.idx })
                      .from(sessionActivities)
                      .where(
                        and(
                          eq(sessionActivities.sessionId, activityRow.sessionId),
                          eq(sessionActivities.status, 'planned'),
                          gt(sessionActivities.idx, activityRow.idx),
                        ),
                      )
                      .orderBy(desc(sessionActivities.idx));
                    for (const laterActivity of laterPlanned) {
                      await tx
                        .update(sessionActivities)
                        .set({ idx: laterActivity.idx + 1 })
                        .where(eq(sessionActivities.id, laterActivity.id));
                    }
                    await tx.insert(sessionActivities).values({
                      sessionId: activityRow.sessionId,
                      idx: activityRow.idx + 1,
                      kind: 'review',
                      conceptId: weakest.conceptId,
                      exerciseIds: reviewActivity.exerciseIds,
                      plannedMinutes: reviewActivity.plannedMinutes,
                      status: 'planned',
                      reason: reviewActivity.reason,
                    });
                  });
                }
              }
            }
          }
        }
      }
    }
  }
  const retryAllowed =
    attemptNo < 2 &&
    ((body.data.mode === 'practice' && result.correct === 0) ||
      ((body.data.mode === 'practice' || body.data.mode === 'review') && followUp));
  const answerOptions = answerOptionsFor(exercise, body.data.answer, !retryAllowed);
  let activityCompleted = false;
  if (activityRow && activity && !retryAllowed) {
    const progress = activity.progress as {
      completedExerciseIds?: string[];
      outcomes?: Record<string, 'correct' | 'incorrect'>;
    };
    const outcomes = {
      ...(progress.outcomes ?? {}),
      [exercise.id]: result.correct > 0 ? 'correct' : 'incorrect',
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
      lessonFinalNeedsQuiz = Boolean(finalExercise && lesson?.knowledge_points?.length);
      learningGoalMet =
        finalExercise || (mastery.independentItemIds.length >= 2 && mastery.lastIndependentCorrect);
      if (!learningGoalMet) {
        const recentIds = new Set(
          (await repo.recentAttempts(100))
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
    const completed =
      !lessonFinalNeedsQuiz &&
      (learningGoalMet || exerciseIds.every((id) => completedExerciseIds.includes(id)));
    activityCompleted = completed;
    const sessionForAdvance =
      completed && session ? ((await repo.session(session.id)) ?? session) : session;
    await updateActivityAndAdvance(db, {
      activityId: activity.id,
      completed,
      now,
      session: sessionForAdvance,
      exerciseIds,
      progress: { ...progress, completedExerciseIds, outcomes },
      userId: request.userId,
      timeZone: request.timeZone,
      knowledgePointActivity: Boolean(
        activity.kind === 'learn' &&
          activity.conceptId &&
          index.lessonsByConcept.get(activity.conceptId)?.knowledge_points?.length,
      ),
    });
  }
  const resultForResponse: Record<string, unknown> = { ...result };
  if (followUp) {
    delete resultForResponse.exemplar;
    delete resultForResponse.solution;
  }
  return serviceResult({
    ...resultForResponse,
    attemptId,
    attemptNo,
    hintsUsed,
    credit,
    mastery: masteryResult,
    retryAllowed,
    activityCompleted,
    ...(followUp ? { followUp: true } : {}),
    ...(answerOptions ? { answerOptions } : {}),
    ...(!retryAllowed && !followUp && exercise.type !== 'explain' && exercise.solution
      ? { solution: exercise.solution }
      : {}),
    ...(exercise.type === 'explain'
      ? {
          ...(!followUp
            ? {
                exemplar: exercise.exemplar,
                ...(exercise.solution ? { solution: exercise.solution } : {}),
              }
            : {}),
          ...('rubric' in result ? { rubric: rubricForFeedback ?? result.rubric } : {}),
        }
      : {}),
  } satisfies AttemptResponse);
}
