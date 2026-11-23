import { emptyAnswerMessage } from '@academy/shared/answer-validation';
import { and, desc, eq, inArray, isNull, like } from 'drizzle-orm';
import type { Context, Hono } from 'hono';
import { Rating } from 'ts-fsrs';
import { z } from 'zod';
import { getLessonPrerequisites } from '../../content/index.js';
import { serializeExercise } from '../../content/serialize.js';
import { formatTemplateNumber, instantiateExercise, isTemplate } from '../../content/templates.js';
import type { ContentIndex, IndexedExercise, IndexedLesson } from '../../content/types.js';
import type { Database } from '../../db/client.js';
import { LearnerRepository } from '../../db/repository.js';
import {
  attempts,
  lessonProblems,
  lessonQuizAttempts,
  lessonQuizItems,
  lessonRuns,
  remediationFlags,
  reviewCards,
  reviewLogs,
  sessionActivities,
  xpEvents,
} from '../../db/schema.js';
import type { ApiEnv } from '../../http/context.js';
import { updateActivityAndAdvance } from '../../learning/activity-completion.js';
import { answerDisplay, answerText } from '../../learning/answer-display.js';
import { answerOptionsFor } from '../../learning/answer-options.js';
import {
  newReviewCard,
  reviewActivityRating,
  scheduleReview,
  startOfNextCalendarDay,
} from '../../learning/fsrs.js';
import { gradeExercise } from '../../learning/grading/index.js';
import { MULTIPLE_CHOICE_FALLBACK_FEEDBACK } from '../../learning/grading/multiple-choice.js';
import { QUIZ_PASS_MARK, scoreLessonQuiz, selectQuizItems } from '../../learning/lesson-quiz.js';
import { isLessonRetryReady } from '../../learning/lesson-retry.js';
import {
  deriveLessonState,
  selectNextProblem,
  xpForPassedPoint,
} from '../../learning/lesson-runner.js';
import { calculateCredit } from '../../learning/mastery.js';
import { applyImplicitRepetitions } from '../../learning/mastery-service.js';
import { keyPrereqsForPoint } from '../../learning/prerequisites.js';
import { resolveLessonCourse } from './course-context.js';

type LessonContext = Context<ApiEnv>;

function correctAnswerDisplay(exercise: IndexedExercise): string {
  if (exercise.type === 'mc') {
    return exercise.options
      .filter((option) => option.correct)
      .map((option) => option.text)
      .join('\n');
  }
  if (exercise.type === 'numeric') {
    return 'answer' in exercise ? formatTemplateNumber(exercise.answer) : '';
  }
  if ('answer' in exercise) return answerText(exercise.answer);
  if ('accept' in exercise) return exercise.accept.join(', ');
  if (exercise.type === 'explain') return exercise.exemplar;
  if (exercise.type === 'debug') {
    return exercise.fix_options
      .filter((option) => option.correct)
      .map((option) => option.text)
      .join('\n');
  }
  return '';
}

type MasteryApplier = (input: {
  repo: LearnerRepository;
  userId: string;
  exercise: IndexedExercise;
  attemptId: string;
  correct: number;
  credit: number;
  hintsUsed: number;
  attemptNo: number;
  mode: 'practice' | 'assessment';
  gradedBy: 'deterministic' | 'llm' | 'self';
  createReviewCard?: boolean;
  now: Date;
  timeZone: string;
}) => Promise<unknown>;

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

function gradeQuizAnswer(exercise: IndexedExercise, answer: unknown, itemId: string) {
  return gradeExercise(exercise, answer, { random: seededRandom(itemId) });
}

export function registerLessonRunRoutes(
  api: Hono<ApiEnv>,
  deps: {
    db: Database;
    content: () => Promise<ContentIndex>;
    withRepo: (context: LessonContext) => LearnerRepository;
    requestNow: (context: LessonContext) => Date;
    applyMastery: MasteryApplier;
  },
) {
  const lessonFor = async (conceptId: string) => {
    const index = await deps.content();
    const lesson = index.lessonsByConcept.get(conceptId);
    if (!lesson?.knowledge_points?.length) return undefined;
    return { index, lesson };
  };

  const runState = async (
    context: LessonContext,
    lesson: IndexedLesson,
    index: ContentIndex,
    run: typeof lessonRuns.$inferSelect,
  ) => {
    const userId = context.get('userId');
    const now = deps.requestNow(context);
    const rows = await deps.db
      .select()
      .from(lessonProblems)
      .where(eq(lessonProblems.runId, run.id))
      .orderBy(lessonProblems.servedAt, lessonProblems.position);
    const derived = deriveLessonState(
      lesson,
      rows,
      index.exercisesById,
      run.quizPassedAt,
      run.attempt,
    );
    const point = lesson.knowledge_points?.find((item) => item.id === derived.currentPointId);
    const buildInstance = (exercise: IndexedExercise, seed: number | null) => {
      if (!isTemplate(exercise)) return exercise;
      if (seed === null) return undefined;
      const concrete = instantiateExercise(exercise, seed).exercise;
      return {
        ...concrete,
        concept: exercise.concept,
        contentVersion: exercise.contentVersion,
      } as IndexedExercise;
    };
    const pendingRow = derived.pending;
    const pendingExercise = pendingRow ? index.exercisesById.get(pendingRow.exerciseId) : undefined;
    const pendingInstance =
      pendingExercise && pendingRow ? buildInstance(pendingExercise, pendingRow.seed) : undefined;
    const lastRow = derived.lastAnswered;
    const lastExercise = lastRow ? index.exercisesById.get(lastRow.exerciseId) : undefined;
    const lastInstance =
      lastExercise && lastRow ? buildInstance(lastExercise, lastRow.seed) : undefined;
    const [lastAttempt] = lastRow?.attemptId
      ? await deps.db.select().from(attempts).where(eq(attempts.id, lastRow.attemptId)).limit(1)
      : [];
    const attemptFeedback = (lastAttempt?.feedback as { message?: string } | null)?.message;
    const lastAnswerOptions =
      lastAttempt && lastInstance
        ? answerOptionsFor(lastInstance, lastAttempt.answer, true)
        : undefined;
    const feedback =
      lastInstance?.type === 'mc' && attemptFeedback === MULTIPLE_CHOICE_FALLBACK_FEEDBACK
        ? ''
        : (attemptFeedback ??
          (lastRow?.correct === 1 ? 'Correct.' : MULTIPLE_CHOICE_FALLBACK_FEEDBACK));
    const earnedEvents = await deps.db
      .select({ amount: xpEvents.amount, sourceKey: xpEvents.sourceKey })
      .from(xpEvents)
      .where(and(eq(xpEvents.userId, userId), like(xpEvents.sourceKey, `kp:${run.id}:%`)));
    const earnedByPoint = new Map(earnedEvents.map((event) => [event.sourceKey, event.amount]));
    const needsProgressSync = derived.points.some(
      (point) =>
        point.status === 'passed' &&
        !earnedByPoint.has(`kp:${run.id}:${point.id}`) &&
        rows.some(
          (row) =>
            !row.practiceOnly &&
            row.assisted &&
            row.knowledgePointId === point.id &&
            row.round === point.round &&
            row.answeredAt !== null &&
            row.position <= (point.passedOn?.position ?? 0),
        ),
    );
    const practicePending = rows.find((row) => row.practiceOnly && row.answeredAt === null);
    const practiceExercise = practicePending
      ? index.exercisesById.get(practicePending.exerciseId)
      : undefined;
    const practiceInstance =
      practiceExercise && practicePending
        ? buildInstance(practiceExercise, practicePending.seed)
        : undefined;
    const quizAttempts = await deps.db
      .select()
      .from(lessonQuizAttempts)
      .where(eq(lessonQuizAttempts.runId, run.id))
      .orderBy(lessonQuizAttempts.attemptNo);
    const quizAttemptIds = quizAttempts.map((attempt) => attempt.id);
    const quizItems = quizAttemptIds.length
      ? await deps.db
          .select()
          .from(lessonQuizItems)
          .where(inArray(lessonQuizItems.quizAttemptId, quizAttemptIds))
          .orderBy(lessonQuizItems.position)
      : [];
    const itemsFor = (attemptId: string) =>
      quizItems.filter((item) => item.quizAttemptId === attemptId);
    const currentAttempt = quizAttempts.find((attempt) => attempt.submittedAt === null);
    const latestQuizAttempt = [...quizAttempts]
      .reverse()
      .find((attempt) => attempt.submittedAt !== null);
    const firstPassedAttempt = quizAttempts.find((attempt) => attempt.passed === true);
    const lastItems = latestQuizAttempt ? itemsFor(latestQuizAttempt.id) : [];
    const previousAttemptItems = latestQuizAttempt ? itemsFor(latestQuizAttempt.id) : [];
    const previewItems = selectQuizItems({
      lesson,
      exercises: index.exercisesById,
      servedProblems: rows.map((row) => ({ exerciseId: row.exerciseId, seed: row.seed })),
      previousAttemptItems,
      usedSeeds: new Set([
        ...rows.flatMap((row) => (row.seed === null ? [] : [row.seed])),
        ...quizItems.flatMap((item) => (item.seed === null ? [] : [item.seed])),
      ]),
      seed: 0,
    });
    const currentItems = currentAttempt ? itemsFor(currentAttempt.id) : [];
    const quizQuestionCount = currentItems.length || lastItems.length || previewItems.length;
    const quizStatus = run.quizPassedAt
      ? 'passed'
      : currentAttempt
        ? 'in_progress'
        : latestQuizAttempt
          ? latestQuizAttempt.passed
            ? 'passed'
            : 'failed'
          : 'not_started';
    const quizLast =
      latestQuizAttempt?.submittedAt &&
      latestQuizAttempt.score !== null &&
      latestQuizAttempt.passed !== null
        ? {
            attemptId: latestQuizAttempt.id,
            attemptNo: latestQuizAttempt.attemptNo,
            score: latestQuizAttempt.score,
            correctCount: lastItems.filter((item) => item.correct === 1).length,
            total: lastItems.length,
            passed: latestQuizAttempt.passed,
            perStep: (lesson.knowledge_points ?? []).map((knowledgePoint) => {
              const stepItems = lastItems.filter(
                (item) => item.knowledgePointId === knowledgePoint.id,
              );
              return {
                pointId: knowledgePoint.id,
                title: knowledgePoint.title,
                correct: stepItems.filter((item) => item.correct === 1).length,
                total: stepItems.length,
              };
            }),
          }
        : undefined;
    const latestQuizSubmittedAt = latestQuizAttempt?.submittedAt;
    const reviewRequired =
      !run.quizPassedAt && latestQuizAttempt?.passed === false && latestQuizSubmittedAt
        ? (lesson.knowledge_points ?? []).flatMap((knowledgePoint) => {
            const missed = lastItems.some(
              (item) =>
                item.knowledgePointId === knowledgePoint.id &&
                item.correct !== null &&
                item.correct < 1,
            );
            if (!missed) return [];
            const answered = Math.min(
              3,
              rows.filter(
                (row) =>
                  row.practiceOnly &&
                  row.knowledgePointId === knowledgePoint.id &&
                  row.answeredAt !== null &&
                  row.answeredAt > latestQuizSubmittedAt,
              ).length,
            );
            return [
              { pointId: knowledgePoint.id, title: knowledgePoint.title, answered, needed: 3 },
            ];
          })
        : [];
    const quizXpAwarded =
      latestQuizAttempt?.passed && firstPassedAttempt?.id === latestQuizAttempt.id
        ? lastItems.length
        : 0;
    const quiz = {
      status: quizStatus,
      passMark: QUIZ_PASS_MARK,
      questionCount: quizQuestionCount,
      ...(currentAttempt
        ? {
            current: {
              attemptId: currentAttempt.id,
              items: currentItems.map((item) => {
                const indexed = index.exercisesById.get(item.exerciseId);
                const instance = indexed ? buildInstance(indexed, item.seed) : undefined;
                return {
                  id: item.id,
                  position: item.position,
                  exercise: instance ? serializeExercise(instance, userId) : null,
                  answered: item.answeredAt !== null,
                  ...(item.answeredAt !== null ? { answer: item.answer } : {}),
                  locked: item.attemptId !== null,
                };
              }),
            },
          }
        : {}),
      ...(quizLast ? { last: quizLast } : {}),
      reviewRequired,
      bestPassed: Boolean(run.quizPassedAt || quizAttempts.some((attempt) => attempt.passed)),
      xpAwarded: quizXpAwarded,
    };
    const retryFlags =
      run.status === 'needs_retry'
        ? await deps.db
            .select({ targetPrereqId: remediationFlags.targetPrereqId })
            .from(remediationFlags)
            .where(
              and(
                eq(remediationFlags.userId, userId),
                eq(remediationFlags.conceptId, run.conceptId),
                eq(remediationFlags.status, 'open'),
              ),
            )
        : [];
    const reviewFirstIds = [
      ...new Set(retryFlags.map((flag) => flag.targetPrereqId ?? run.conceptId)),
    ];
    return {
      id: run.id,
      ...(needsProgressSync ? { needsProgressSync: true } : {}),
      status: run.status === 'needs_retry' ? 'needs_retry' : derived.status,
      ...(run.status === 'needs_retry'
        ? {
            retry: {
              after: run.retryAfter?.toISOString() ?? null,
              ready: isLessonRetryReady(run.retryAfter, retryFlags.length > 0, now),
              reviewFirst: reviewFirstIds.map((id) => ({
                id,
                title: index.conceptsById.get(id)?.title ?? id,
              })),
            },
          }
        : {}),
      ...(derived.halted ? { halted: derived.halted } : {}),
      where_this_fits: lesson.where_this_fits,
      prerequisites: getLessonPrerequisites(index, lesson.concept),
      points: derived.points.map((point) => ({
        ...point,
        xpEarned:
          point.status === 'passed'
            ? (earnedByPoint.get(`kp:${run.id}:${point.id}`) ?? xpForPassedPoint(point.answered))
            : 0,
      })),
      currentPointId: derived.currentPointId,
      currentPoint: point
        ? {
            id: point.id,
            title: point.title,
            tldr: point.tldr,
            explain: point.explain,
            worked: point.worked,
          }
        : undefined,
      pending: pendingRow,
      pendingProblem:
        pendingRow && pendingInstance
          ? { ...pendingRow, exercise: serializeExercise(pendingInstance, userId) }
          : undefined,
      pendingPracticeProblem:
        practicePending && practiceInstance
          ? { ...practicePending, exercise: serializeExercise(practiceInstance, userId) }
          : undefined,
      lastAnswered: lastRow,
      lastAnsweredProblem:
        lastRow && lastInstance
          ? {
              ...lastRow,
              activityId: lastAttempt?.activityId ?? null,
              exercise: serializeExercise(lastInstance, userId),
              result: {
                correct: lastRow.correct,
                attemptNo: lastAttempt?.attemptNo ?? 1,
                feedback,
                solution: lastInstance.solution,
                yourAnswer: answerDisplay(lastInstance, lastAttempt?.answer),
                correctAnswer: correctAnswerDisplay(lastInstance),
                ...(lastAnswerOptions ? { answerOptions: lastAnswerOptions } : {}),
              },
            }
          : undefined,
      xpEarned: earnedEvents.reduce((sum, event) => sum + event.amount, 0),
      quiz,
    };
  };

  const verifyActivity = async (
    context: LessonContext,
    activityId: string | undefined,
    conceptId: string,
  ) => {
    if (!activityId) return { activity: undefined, session: undefined };
    const [activityRow] = await deps.db
      .select()
      .from(sessionActivities)
      .where(eq(sessionActivities.id, activityId))
      .limit(1);
    const session = activityRow
      ? await deps.withRepo(context).session(activityRow.sessionId)
      : undefined;
    const activity = session?.activities.find((item) => item.id === activityId);
    if (activity?.kind !== 'learn' || activity.conceptId !== conceptId) {
      return undefined;
    }
    return { activity, session };
  };

  api.get('/lessons/:conceptId/run', async (context) => {
    const conceptId = context.req.param('conceptId');
    const resolved = await lessonFor(conceptId);
    if (!resolved) return context.json({ error: 'Knowledge-point lesson not found' }, 404);
    const [run] = await deps.db
      .select()
      .from(lessonRuns)
      .where(and(eq(lessonRuns.userId, context.get('userId')), eq(lessonRuns.conceptId, conceptId)))
      .limit(1);
    return context.json({
      course: await resolveLessonCourse(
        deps.db,
        deps.withRepo(context),
        resolved.index,
        context.get('userId'),
        conceptId,
        context.req.query('activityId'),
      ),
      run: run ? await runState(context, resolved.lesson, resolved.index, run) : null,
    });
  });

  api.post('/lessons/:conceptId/run', async (context) => {
    const conceptId = context.req.param('conceptId');
    const resolved = await lessonFor(conceptId);
    if (!resolved) return context.json({ error: 'Knowledge-point lesson not found' }, 404);
    const body = z
      .object({
        activityId: z.string().uuid().optional(),
        reconcileProgress: z.boolean().optional(),
      })
      .safeParse(await context.req.json().catch(() => ({})));
    if (!body.success) return context.json({ error: 'Invalid lesson run request' }, 400);
    const activity = await verifyActivity(context, body.data.activityId, conceptId);
    if (!activity) return context.json({ error: 'Learn activity not found' }, 403);
    const now = deps.requestNow(context);
    const userId = context.get('userId');
    const run = await deps.db.transaction(async (tx) => {
      let [existing] = await tx
        .select()
        .from(lessonRuns)
        .where(and(eq(lessonRuns.userId, userId), eq(lessonRuns.conceptId, conceptId)))
        .for('update')
        .limit(1);
      if (!existing) {
        [existing] = await tx
          .insert(lessonRuns)
          .values({ userId, conceptId, status: 'in_progress', startedAt: now, updatedAt: now })
          .onConflictDoNothing()
          .returning();
        if (!existing) {
          [existing] = await tx
            .select()
            .from(lessonRuns)
            .where(and(eq(lessonRuns.userId, userId), eq(lessonRuns.conceptId, conceptId)))
            .for('update')
            .limit(1);
        }
      }
      if (!existing) throw new Error('Unable to create lesson run');
      const problems = await tx
        .select()
        .from(lessonProblems)
        .where(eq(lessonProblems.runId, existing.id))
        .orderBy(lessonProblems.servedAt, lessonProblems.position);
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
        const openFlags = await tx
          .select({ targetPrereqId: remediationFlags.targetPrereqId })
          .from(remediationFlags)
          .where(
            and(
              eq(remediationFlags.userId, userId),
              eq(remediationFlags.conceptId, conceptId),
              eq(remediationFlags.status, 'open'),
            ),
          );
        const reviewFirstIds = [
          ...new Set(openFlags.map((flag) => flag.targetPrereqId ?? conceptId)),
        ];
        if (!isLessonRetryReady(existing.retryAfter, openFlags.length > 0, now)) {
          return {
            kind: 'review_first' as const,
            titles: reviewFirstIds.map((id) => resolved.index.conceptsById.get(id)?.title ?? id),
          };
        }
        [existing] = await tx
          .update(lessonRuns)
          .set({
            attempt: existing.attempt + 1,
            status: 'in_progress',
            retryAfter: null,
            updatedAt: now,
            completedAt: null,
          })
          .where(eq(lessonRuns.id, existing.id))
          .returning();
        state = deriveLessonState(
          resolved.lesson,
          problems,
          resolved.index.exercisesById,
          existing.quizPassedAt,
          existing.attempt,
        );
      } else if (state.halted) {
        [existing] = await tx
          .update(lessonRuns)
          .set({
            attempt: existing.attempt + 1,
            status: 'in_progress',
            haltedAt: null,
            retryAfter: null,
            updatedAt: now,
            completedAt: null,
          })
          .where(eq(lessonRuns.id, existing.id))
          .returning();
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
      if (body.data.reconcileProgress && passedPoints.length) {
        await tx
          .insert(xpEvents)
          .values(
            passedPoints.map((point) => ({
              userId,
              kind: 'knowledge_point' as const,
              sourceKey: `kp:${existing.id}:${point.id}`,
              conceptId,
              amount: xpForPassedPoint(point.answered),
              earnedAt: now,
              localDate: localDate(now, context.get('timeZone')),
            })),
          )
          .onConflictDoNothing();
      }
      if (state.status !== 'in_progress') {
        if (existing.status !== state.status) {
          [existing] = await tx
            .update(lessonRuns)
            .set({
              status: state.status,
              updatedAt: now,
              completedAt: state.status === 'completed' ? (existing.completedAt ?? now) : null,
            })
            .where(eq(lessonRuns.id, existing.id))
            .returning();
        }
        return { kind: 'ready' as const, run: existing };
      }
      if (existing.status !== 'in_progress') {
        [existing] = await tx
          .update(lessonRuns)
          .set({ status: 'in_progress', updatedAt: now, completedAt: null })
          .where(eq(lessonRuns.id, existing.id))
          .returning();
      }
      const round = existing.attempt;
      if (state.pending || !state.currentPointId) {
        return { kind: 'ready' as const, run: existing };
      }
      const point = resolved.lesson.knowledge_points?.find(
        (item) => item.id === state.currentPointId,
      );
      if (!point) return { kind: 'ready' as const, run: existing };
      const pointRows = problems
        .filter((problem) => problem.knowledgePointId === point.id && problem.round === round)
        .filter((problem) => !problem.practiceOnly)
        .map(({ exerciseId, seed, position, correct, servedAt }) => ({
          exerciseId,
          seed,
          position,
          correct,
          servedAt,
        }));
      const usedSeeds = new Set(
        problems.flatMap((problem) => (problem.seed === null ? [] : [problem.seed])),
      );
      const selection = selectNextProblem(
        point,
        resolved.index.exercisesById,
        pointRows,
        Math.floor(Math.random() * 0x80000000),
        usedSeeds,
      );
      if (!selection) return { kind: 'ready' as const, run: existing };
      await tx.insert(lessonProblems).values({
        runId: existing.id,
        knowledgePointId: point.id,
        round,
        position: selection.position,
        exerciseId: selection.exerciseId,
        seed: selection.seed,
        servedAt: now,
      });
      return { kind: 'ready' as const, run: existing };
    });
    if (run.kind === 'retry_tomorrow') {
      return context.json({ error: 'This lesson comes back tomorrow.' }, 409);
    }
    if (run.kind === 'review_first') {
      return context.json({ error: `Review ${run.titles.join(' and ')} first.` }, 409);
    }
    return context.json({
      course: await resolveLessonCourse(
        deps.db,
        deps.withRepo(context),
        resolved.index,
        context.get('userId'),
        conceptId,
        body.data.activityId,
      ),
      run: await runState(context, resolved.lesson, resolved.index, run.run),
    });
  });

  api.post('/lessons/:conceptId/run/practice', async (context) => {
    const conceptId = context.req.param('conceptId');
    const resolved = await lessonFor(conceptId);
    if (!resolved) return context.json({ error: 'Knowledge-point lesson not found' }, 404);
    const body = z
      .object({
        pointId: z.string().min(1),
        activityId: z.string().uuid().optional(),
        warmup: z.boolean().optional(),
      })
      .safeParse(await context.req.json().catch(() => ({})));
    if (!body.success) return context.json({ error: 'Invalid practice request' }, 400);
    const activity = await verifyActivity(context, body.data.activityId, conceptId);
    if (!activity) return context.json({ error: 'Learn activity not found' }, 403);
    const userId = context.get('userId');
    const now = deps.requestNow(context);
    const result = await deps.db.transaction(async (tx) => {
      const [run] = await tx
        .select()
        .from(lessonRuns)
        .where(and(eq(lessonRuns.userId, userId), eq(lessonRuns.conceptId, conceptId)))
        .for('update')
        .limit(1);
      if (!run) return { kind: 'not_found' as const };
      const problems = await tx
        .select()
        .from(lessonProblems)
        .where(eq(lessonProblems.runId, run.id));
      const state = deriveLessonState(
        resolved.lesson,
        problems,
        resolved.index.exercisesById,
        run.quizPassedAt,
        run.attempt,
      );
      const pointState = state.points.find((item) => item.id === body.data.pointId);
      if (pointState?.status !== 'passed') return { kind: 'not_passed' as const, run };
      let availableProblems = problems;
      let warmupComplete = false;
      if (body.data.warmup) {
        const [latestQuizAttempt] = await tx
          .select()
          .from(lessonQuizAttempts)
          .where(eq(lessonQuizAttempts.runId, run.id))
          .orderBy(desc(lessonQuizAttempts.attemptNo))
          .limit(1);
        const latestSubmittedAt = latestQuizAttempt?.submittedAt;
        if (!run.quizPassedAt && latestQuizAttempt?.passed === false && latestSubmittedAt) {
          const quizItems = await tx
            .select({
              knowledgePointId: lessonQuizItems.knowledgePointId,
              correct: lessonQuizItems.correct,
            })
            .from(lessonQuizItems)
            .where(eq(lessonQuizItems.quizAttemptId, latestQuizAttempt.id));
          const pointWasMissed = quizItems.some(
            (item) =>
              item.knowledgePointId === body.data.pointId &&
              item.correct !== null &&
              item.correct < 1,
          );
          const answeredSinceFailure = problems.filter(
            (problem) =>
              problem.practiceOnly &&
              problem.knowledgePointId === body.data.pointId &&
              problem.answeredAt !== null &&
              problem.answeredAt > latestSubmittedAt,
          ).length;
          warmupComplete = !pointWasMissed || answeredSinceFailure >= 3;
        } else {
          warmupComplete = true;
        }
      }
      const pending = availableProblems.find(
        (item) => item.practiceOnly && item.answeredAt === null,
      );
      if (pending?.knowledgePointId === body.data.pointId && !warmupComplete) {
        return { kind: 'ready' as const, run };
      }
      if (pending) {
        await tx.delete(lessonProblems).where(eq(lessonProblems.id, pending.id));
        availableProblems = availableProblems.filter((item) => item.id !== pending.id);
      }
      if (warmupComplete) return { kind: 'review_complete' as const, run };
      const point = resolved.lesson.knowledge_points?.find((item) => item.id === body.data.pointId);
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
        Math.floor(Math.random() * 0x7fffffff),
        usedSeeds,
      );
      if (!selection) return { kind: 'no_problem' as const, run };
      await tx.insert(lessonProblems).values({
        runId: run.id,
        knowledgePointId: point.id,
        round: pointState.round,
        position: selection.position,
        exerciseId: selection.exerciseId,
        seed: selection.seed,
        practiceOnly: true,
        servedAt: now,
      });
      return { kind: 'ready' as const, run };
    });
    if (result.kind === 'not_found') return context.json({ error: 'Lesson step not found' }, 404);
    if (result.kind === 'not_passed') {
      return context.json({ error: 'Only a passed step can be practised again' }, 409);
    }
    if (result.kind === 'review_complete') {
      return context.json({ error: 'Quiz practice is complete for this step' }, 409);
    }
    if (result.kind === 'no_problem') {
      return context.json({ error: 'No practice question is available' }, 409);
    }
    const [run] = await deps.db
      .select()
      .from(lessonRuns)
      .where(eq(lessonRuns.id, result.run.id))
      .limit(1);
    return context.json({
      course: await resolveLessonCourse(
        deps.db,
        deps.withRepo(context),
        resolved.index,
        context.get('userId'),
        conceptId,
        body.data.activityId,
      ),
      run: run ? await runState(context, resolved.lesson, resolved.index, run) : null,
    });
  });

  api.post('/lessons/:conceptId/run/answer', async (context) => {
    const conceptId = context.req.param('conceptId');
    const resolved = await lessonFor(conceptId);
    if (!resolved) return context.json({ error: 'Knowledge-point lesson not found' }, 404);
    const body = z
      .object({
        problemId: z.string().uuid(),
        answer: z.unknown(),
        activityId: z.string().uuid().optional(),
        durationMs: z.number().int().nonnegative().optional(),
      })
      .safeParse(await context.req.json().catch(() => ({})));
    if (!body.success) return context.json({ error: 'Invalid lesson answer' }, 400);
    const activity = await verifyActivity(context, body.data.activityId, conceptId);
    if (!activity) return context.json({ error: 'Learn activity not found' }, 403);
    const userId = context.get('userId');
    const now = deps.requestNow(context);
    const result = await deps.db.transaction(async (tx) => {
      const [joined] = await tx
        .select({ problem: lessonProblems, run: lessonRuns })
        .from(lessonProblems)
        .innerJoin(lessonRuns, eq(lessonProblems.runId, lessonRuns.id))
        .where(
          and(
            eq(lessonProblems.id, body.data.problemId),
            eq(lessonRuns.userId, userId),
            eq(lessonRuns.conceptId, conceptId),
          ),
        )
        .for('update')
        .limit(1);
      if (!joined) return { kind: 'not_found' as const };
      if (joined.problem.answeredAt) return { kind: 'conflict' as const, runId: joined.run.id };
      const allProblems = await tx
        .select()
        .from(lessonProblems)
        .where(eq(lessonProblems.runId, joined.run.id));
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
      const exercise =
        isTemplate(indexed) && joined.problem.seed !== null
          ? ({
              ...instantiateExercise(indexed, joined.problem.seed).exercise,
              concept: indexed.concept,
              contentVersion: indexed.contentVersion,
            } as IndexedExercise)
          : indexed;
      if (isTemplate(indexed) && joined.problem.seed === null) {
        return { kind: 'invalid' as const };
      }
      if (emptyAnswerMessage(exercise.type, body.data.answer)) {
        return { kind: 'invalid' as const };
      }
      const graded = await gradeExercise(exercise, body.data.answer);
      if (graded.status !== 'graded') return { kind: 'invalid' as const, graded };
      const attemptId = crypto.randomUUID();
      const credit = calculateCredit({
        correct: graded.correct,
        hintsUsed: 0,
        attemptNo: 1,
        gradedBy: graded.graded_by ?? 'deterministic',
      });
      const repo = new LearnerRepository(tx as unknown as Database, userId);
      await tx.insert(attempts).values({
        id: attemptId,
        userId,
        sessionId: activity.activity ? activity.session?.id : undefined,
        activityId: body.data.activityId,
        exerciseId: exercise.id,
        exerciseVersion: exercise.contentVersion,
        conceptId: exercise.concept,
        dimension: exercise.dimension,
        mode: 'practice',
        answer: body.data.answer,
        correct: graded.correct,
        credit,
        hintsUsed: 0,
        attemptNo: 1,
        gradedBy: graded.graded_by ?? 'deterministic',
        feedback: { message: graded.feedback },
        mistakeCategory: graded.mistake_category,
        durationMs: body.data.durationMs,
        createdAt: now,
      });
      await deps.applyMastery({
        repo,
        userId,
        exercise,
        attemptId,
        correct: graded.correct,
        credit,
        hintsUsed: 0,
        attemptNo: 1,
        mode: 'practice',
        gradedBy: graded.graded_by ?? 'deterministic',
        createReviewCard: false,
        now,
        timeZone: context.get('timeZone'),
      });
      await tx
        .update(lessonProblems)
        .set({ answeredAt: now, correct: graded.correct, attemptId })
        .where(eq(lessonProblems.id, joined.problem.id));
      const problems = await tx
        .select()
        .from(lessonProblems)
        .where(eq(lessonProblems.runId, joined.run.id))
        .orderBy(lessonProblems.servedAt, lessonProblems.position);
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
        await tx
          .insert(xpEvents)
          .values({
            userId,
            kind: 'knowledge_point',
            sourceKey: `kp:${joined.run.id}:${point.id}`,
            conceptId,
            amount: xpAwarded,
            earnedAt: now,
            localDate: localDate(now, context.get('timeZone')),
          })
          .onConflictDoNothing();
      }
      if (!joined.problem.practiceOnly) {
        const halted = state.halted;
        if (!previous.halted && halted !== undefined) {
          const haltedAt = now;
          const retryAfter = startOfNextCalendarDay(now, context.get('timeZone'));
          if (joined.run.haltedPointIndex !== null && halted.index <= joined.run.haltedPointIndex) {
            const keyPrereqIds = keyPrereqsForPoint(resolved.index, conceptId, halted.pointId);
            const openFlags = keyPrereqIds.length
              ? await tx
                  .select({ targetPrereqId: remediationFlags.targetPrereqId })
                  .from(remediationFlags)
                  .where(
                    and(
                      eq(remediationFlags.userId, userId),
                      eq(remediationFlags.conceptId, conceptId),
                      eq(remediationFlags.status, 'open'),
                      inArray(remediationFlags.targetPrereqId, keyPrereqIds),
                    ),
                  )
              : [];
            const alreadyOpen = new Set(
              openFlags.flatMap((flag) => (flag.targetPrereqId ? [flag.targetPrereqId] : [])),
            );
            const flagsToInsert = keyPrereqIds
              .filter((targetPrereqId) => !alreadyOpen.has(targetPrereqId))
              .map((targetPrereqId) => ({
                userId,
                conceptId,
                targetPrereqId,
                openedByAttemptId: attemptId,
                status: 'open' as const,
                createdAt: now,
              }));
            if (flagsToInsert.length > 0) {
              await tx.insert(remediationFlags).values(flagsToInsert);
            }
          }
          await tx
            .update(lessonRuns)
            .set({
              status: 'needs_retry',
              haltedAt,
              retryAfter,
              haltedPointIndex: halted.index,
              haltCount: joined.run.haltCount + 1,
              updatedAt: now,
              completedAt: null,
            })
            .where(eq(lessonRuns.id, joined.run.id));
        } else {
          await tx
            .update(lessonRuns)
            .set({
              status: state.status,
              updatedAt: now,
              completedAt: state.status === 'completed' ? now : null,
            })
            .where(eq(lessonRuns.id, joined.run.id));
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
    if (result.kind === 'not_found')
      return context.json({ error: 'Lesson problem not found' }, 404);
    if (result.kind === 'invalid') return context.json({ error: 'Invalid answer' }, 422);
    if (result.kind === 'conflict') {
      const [run] = await deps.db
        .select()
        .from(lessonRuns)
        .where(eq(lessonRuns.id, result.runId))
        .limit(1);
      return context.json(
        {
          error: 'Lesson problem has already been answered.',
          state:
            run && resolved ? await runState(context, resolved.lesson, resolved.index, run) : null,
        },
        409,
      );
    }
    const [run] = await deps.db
      .select()
      .from(lessonRuns)
      .where(eq(lessonRuns.id, result.runId))
      .limit(1);
    const state =
      run && resolved ? await runState(context, resolved.lesson, resolved.index, run) : null;
    return context.json({
      correct: result.correct,
      feedback: result.feedback,
      solution: result.solution,
      xpAwarded: result.xpAwarded,
      state,
    });
  });

  api.post('/lessons/:conceptId/quiz/start', async (context) => {
    const conceptId = context.req.param('conceptId');
    const resolved = await lessonFor(conceptId);
    if (!resolved) return context.json({ error: 'Knowledge-point lesson not found' }, 404);
    const body = z
      .object({ activityId: z.string().uuid().optional() })
      .safeParse(await context.req.json().catch(() => ({})));
    if (!body.success) return context.json({ error: 'Invalid quiz request' }, 400);
    const activity = await verifyActivity(context, body.data.activityId, conceptId);
    if (!activity) return context.json({ error: 'Learn activity not found' }, 403);
    const userId = context.get('userId');
    const now = deps.requestNow(context);
    const result = await deps.db.transaction(async (tx) => {
      const [run] = await tx
        .select()
        .from(lessonRuns)
        .where(and(eq(lessonRuns.userId, userId), eq(lessonRuns.conceptId, conceptId)))
        .for('update')
        .limit(1);
      if (!run) return { kind: 'not_found' as const };
      const problems = await tx
        .select()
        .from(lessonProblems)
        .where(eq(lessonProblems.runId, run.id));
      const state = deriveLessonState(
        resolved.lesson,
        problems,
        resolved.index.exercisesById,
        run.quizPassedAt,
        run.attempt,
      );
      if (state.status === 'in_progress') return { kind: 'steps_incomplete' as const, run };
      const previousAttempts = await tx
        .select()
        .from(lessonQuizAttempts)
        .where(eq(lessonQuizAttempts.runId, run.id))
        .orderBy(lessonQuizAttempts.attemptNo);
      const lastSubmittedAttempt = [...previousAttempts]
        .reverse()
        .find((attempt) => attempt.submittedAt !== null);
      const lastSubmittedAt = lastSubmittedAttempt?.submittedAt;
      if (!run.quizPassedAt && lastSubmittedAttempt?.passed === false && lastSubmittedAt) {
        const failedItems = await tx
          .select()
          .from(lessonQuizItems)
          .where(eq(lessonQuizItems.quizAttemptId, lastSubmittedAttempt.id));
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
        await tx
          .update(lessonRuns)
          .set({
            status: state.status,
            completedAt: state.status === 'completed' ? (run.completedAt ?? now) : null,
            updatedAt: now,
          })
          .where(eq(lessonRuns.id, run.id));
      }
      const [openAttempt] = await tx
        .select()
        .from(lessonQuizAttempts)
        .where(and(eq(lessonQuizAttempts.runId, run.id), isNull(lessonQuizAttempts.submittedAt)))
        .orderBy(lessonQuizAttempts.attemptNo)
        .limit(1);
      if (openAttempt) return { kind: 'ready' as const, runId: run.id };
      const previousAttempt = previousAttempts.at(-1);
      const allQuizItems = previousAttempts.length
        ? await tx
            .select()
            .from(lessonQuizItems)
            .where(
              inArray(
                lessonQuizItems.quizAttemptId,
                previousAttempts.map((attempt) => attempt.id),
              ),
            )
        : [];
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
        seed: Math.floor(Math.random() * 0x7fffffff),
      });
      if (selection.length === 0) return { kind: 'no_questions' as const, run };
      const attemptNo = Math.max(0, ...previousAttempts.map((attempt) => attempt.attemptNo)) + 1;
      const [quizAttempt] = await tx
        .insert(lessonQuizAttempts)
        .values({ runId: run.id, attemptNo, startedAt: now })
        .returning();
      if (!quizAttempt) throw new Error('Unable to create lesson quiz attempt');
      await tx.insert(lessonQuizItems).values(
        selection.map((item) => ({
          quizAttemptId: quizAttempt.id,
          position: item.position,
          knowledgePointId: item.pointId,
          exerciseId: item.exerciseId,
          seed: item.seed,
        })),
      );
      return { kind: 'ready' as const, runId: run.id };
    });
    if (result.kind === 'not_found') return context.json({ error: 'Lesson run not found' }, 404);
    if (result.kind === 'steps_incomplete') {
      return context.json({ error: 'Finish every lesson step before starting the quiz' }, 409);
    }
    if (result.kind === 'review_required') {
      return context.json({ error: 'Review the steps you missed before retaking the quiz' }, 409);
    }
    if (result.kind === 'no_questions') {
      return context.json({ error: 'No lesson quiz questions are available' }, 409);
    }
    const [run] = await deps.db
      .select()
      .from(lessonRuns)
      .where(eq(lessonRuns.id, result.runId))
      .limit(1);
    return context.json({
      course: await resolveLessonCourse(
        deps.db,
        deps.withRepo(context),
        resolved.index,
        context.get('userId'),
        conceptId,
        body.data.activityId,
      ),
      run: run ? await runState(context, resolved.lesson, resolved.index, run) : null,
    });
  });

  api.post('/lessons/:conceptId/quiz/answer', async (context) => {
    const conceptId = context.req.param('conceptId');
    const resolved = await lessonFor(conceptId);
    if (!resolved) return context.json({ error: 'Knowledge-point lesson not found' }, 404);
    const body = z
      .object({
        itemId: z.string().uuid(),
        answer: z.unknown(),
        activityId: z.string().uuid().optional(),
        durationMs: z.number().int().nonnegative().optional(),
      })
      .safeParse(await context.req.json().catch(() => ({})));
    if (!body.success) return context.json({ error: 'Invalid quiz answer' }, 400);
    const activity = await verifyActivity(context, body.data.activityId, conceptId);
    if (!activity) return context.json({ error: 'Learn activity not found' }, 403);
    const userId = context.get('userId');
    const now = deps.requestNow(context);
    const result = await deps.db.transaction(async (tx) => {
      const [joined] = await tx
        .select({ item: lessonQuizItems, quiz: lessonQuizAttempts, run: lessonRuns })
        .from(lessonQuizItems)
        .innerJoin(lessonQuizAttempts, eq(lessonQuizItems.quizAttemptId, lessonQuizAttempts.id))
        .innerJoin(lessonRuns, eq(lessonQuizAttempts.runId, lessonRuns.id))
        .where(
          and(
            eq(lessonQuizItems.id, body.data.itemId),
            eq(lessonRuns.userId, userId),
            eq(lessonRuns.conceptId, conceptId),
          ),
        )
        .for('update')
        .limit(1);
      if (!joined) return { kind: 'not_found' as const };
      if (joined.item.attemptId || joined.quiz.submittedAt) {
        return { kind: 'conflict' as const, runId: joined.run.id };
      }
      const problems = await tx
        .select()
        .from(lessonProblems)
        .where(eq(lessonProblems.runId, joined.run.id));
      const runState = deriveLessonState(
        resolved.lesson,
        problems,
        resolved.index.exercisesById,
        joined.run.quizPassedAt,
        joined.run.attempt,
      );
      if (runState.status === 'in_progress') {
        return { kind: 'conflict' as const, runId: joined.run.id };
      }
      const indexed = resolved.index.exercisesById.get(joined.item.exerciseId);
      const exercise = indexed ? resolvedIndexedExercise(indexed, joined.item.seed) : undefined;
      if (!exercise) return { kind: 'invalid' as const };
      if (emptyAnswerMessage(exercise.type, body.data.answer)) {
        return { kind: 'invalid' as const };
      }
      const graded = await gradeQuizAnswer(exercise, body.data.answer, joined.item.id);
      if (graded.status !== 'graded') return { kind: 'invalid' as const };
      await tx
        .update(lessonQuizItems)
        .set({
          answer: body.data.answer,
          correct: graded.correct,
          durationMs: body.data.durationMs ?? null,
          answeredAt: now,
        })
        .where(eq(lessonQuizItems.id, joined.item.id));
      return { kind: 'answered' as const, runId: joined.run.id };
    });
    if (result.kind === 'not_found') return context.json({ error: 'Quiz item not found' }, 404);
    if (result.kind === 'invalid') return context.json({ error: 'Invalid answer' }, 422);
    if (result.kind === 'conflict') {
      return context.json({ error: 'Quiz item has already been answered.' }, 409);
    }
    const [run] = await deps.db
      .select()
      .from(lessonRuns)
      .where(eq(lessonRuns.id, result.runId))
      .limit(1);
    return context.json({
      saved: true,
      course: await resolveLessonCourse(
        deps.db,
        deps.withRepo(context),
        resolved.index,
        context.get('userId'),
        conceptId,
        body.data.activityId,
      ),
      run: run ? await runState(context, resolved.lesson, resolved.index, run) : null,
    });
  });

  api.post('/lessons/:conceptId/quiz/submit', async (context) => {
    const conceptId = context.req.param('conceptId');
    const resolved = await lessonFor(conceptId);
    if (!resolved) return context.json({ error: 'Knowledge-point lesson not found' }, 404);
    const body = z
      .object({ activityId: z.string().uuid().optional() })
      .safeParse(await context.req.json().catch(() => ({})));
    if (!body.success) return context.json({ error: 'Invalid quiz submission' }, 400);
    const activity = await verifyActivity(context, body.data.activityId, conceptId);
    if (!activity) return context.json({ error: 'Learn activity not found' }, 403);
    const userId = context.get('userId');
    const now = deps.requestNow(context);
    const result = await deps.db.transaction(async (tx) => {
      const [run] = await tx
        .select()
        .from(lessonRuns)
        .where(and(eq(lessonRuns.userId, userId), eq(lessonRuns.conceptId, conceptId)))
        .for('update')
        .limit(1);
      if (!run) return { kind: 'not_found' as const };
      const quizAttempts = await tx
        .select()
        .from(lessonQuizAttempts)
        .where(eq(lessonQuizAttempts.runId, run.id))
        .orderBy(lessonQuizAttempts.attemptNo);
      const latestAttempt = quizAttempts.at(-1);
      if (!latestAttempt) return { kind: 'not_found' as const };
      if (latestAttempt.submittedAt) {
        return { kind: 'already_submitted' as const, runId: run.id };
      }
      const items = await tx
        .select()
        .from(lessonQuizItems)
        .where(eq(lessonQuizItems.quizAttemptId, latestAttempt.id))
        .orderBy(lessonQuizItems.position);
      if (items.some((item) => item.answeredAt === null || item.correct === null)) {
        return { kind: 'unanswered' as const };
      }
      const pendingGrades: Array<{
        item: (typeof items)[number];
        exercise: IndexedExercise;
        graded: Extract<Awaited<ReturnType<typeof gradeExercise>>, { status: 'graded' }>;
      }> = [];
      for (const item of items) {
        if (item.attemptId !== null) continue;
        const indexed = resolved.index.exercisesById.get(item.exerciseId);
        const exercise = indexed ? resolvedIndexedExercise(indexed, item.seed) : undefined;
        if (!exercise) return { kind: 'invalid_answer' as const };
        const graded = await gradeQuizAnswer(exercise, item.answer, item.id);
        if (graded.status !== 'graded') return { kind: 'invalid_answer' as const };
        pendingGrades.push({ item, exercise, graded });
      }
      const repo = new LearnerRepository(tx as unknown as Database, userId);
      const finalItems = new Map(items.map((item) => [item.id, item]));
      for (const pending of pendingGrades) {
        const { graded } = pending;
        const attemptId = crypto.randomUUID();
        const gradedBy = graded.graded_by ?? 'deterministic';
        const credit = calculateCredit({
          correct: graded.correct,
          hintsUsed: 0,
          attemptNo: 1,
          gradedBy,
        });
        await tx.insert(attempts).values({
          id: attemptId,
          userId,
          sessionId: activity.activity ? activity.session?.id : undefined,
          activityId: body.data.activityId,
          exerciseId: pending.exercise.id,
          exerciseVersion: pending.exercise.contentVersion,
          conceptId: pending.exercise.concept,
          dimension: pending.exercise.dimension,
          mode: 'assessment',
          answer: pending.item.answer,
          correct: graded.correct,
          credit,
          hintsUsed: 0,
          attemptNo: 1,
          gradedBy,
          feedback: { message: graded.feedback },
          mistakeCategory: graded.mistake_category,
          durationMs: pending.item.durationMs,
          createdAt: now,
        });
        await deps.applyMastery({
          repo,
          userId,
          exercise: pending.exercise,
          attemptId,
          correct: graded.correct,
          credit,
          hintsUsed: 0,
          attemptNo: 1,
          mode: 'assessment',
          gradedBy,
          createReviewCard: false,
          now,
          timeZone: context.get('timeZone'),
        });
        const [updatedItem] = await tx
          .update(lessonQuizItems)
          .set({ correct: graded.correct, attemptId })
          .where(eq(lessonQuizItems.id, pending.item.id))
          .returning();
        if (!updatedItem) throw new Error('Unable to finalize lesson quiz item');
        finalItems.set(updatedItem.id, updatedItem);
      }
      const submittedItems = items.map((item) => finalItems.get(item.id) ?? item);
      const result = scoreLessonQuiz(submittedItems.map((item) => item.correct ?? 0));
      await tx
        .update(lessonQuizAttempts)
        .set({ submittedAt: now, score: result.score, passed: result.passed })
        .where(eq(lessonQuizAttempts.id, latestAttempt.id));
      let xpAwarded = 0;
      if (result.passed) {
        if (!run.quizPassedAt) {
          await tx
            .update(lessonRuns)
            .set({ status: 'completed', quizPassedAt: now, completedAt: now, updatedAt: now })
            .where(eq(lessonRuns.id, run.id));
          const inserted = await tx
            .insert(xpEvents)
            .values({
              userId,
              kind: 'quiz',
              sourceKey: `quiz:${run.id}`,
              conceptId,
              amount: items.length,
              earnedAt: now,
              localDate: localDate(now, context.get('timeZone')),
            })
            .onConflictDoNothing()
            .returning({ id: xpEvents.id });
          if (inserted.length > 0) xpAwarded = items.length;
          const itemsByDimension = new Map<string, (typeof items)[number][]>();
          for (const item of submittedItems) {
            const exercise = resolved.index.exercisesById.get(item.exerciseId);
            if (!exercise) continue;
            const dimensionItems = itemsByDimension.get(exercise.dimension) ?? [];
            dimensionItems.push(item);
            itemsByDimension.set(exercise.dimension, dimensionItems);
          }
          const dimensionRatings = new Map<string, Rating>();
          for (const [dimension, dimensionItems] of itemsByDimension) {
            const [existingCard] = await tx
              .select()
              .from(reviewCards)
              .where(
                and(
                  eq(reviewCards.userId, userId),
                  eq(reviewCards.conceptId, conceptId),
                  eq(reviewCards.dimension, dimension),
                ),
              )
              .for('update')
              .limit(1);
            const rating = reviewActivityRating(
              dimensionItems.map((item) => {
                const exercise = resolved.index.exercisesById.get(item.exerciseId);
                return {
                  correct: item.correct ?? 0,
                  hintsUsed: 0,
                  durationMs: item.durationMs,
                  targetSeconds: exercise?.target_seconds,
                };
              }),
            );
            dimensionRatings.set(dimension, rating);
            const scheduled = scheduleReview(
              existingCard ? (existingCard.fsrs as never) : newReviewCard(now),
              now,
              rating,
              context.get('timeZone'),
              process.env.NODE_ENV !== 'test',
            );
            let cardId = existingCard?.id;
            const cardValues = {
              fsrs: scheduled.card,
              dueAt: scheduled.card.due,
              lastReviewAt: now,
              reps: scheduled.card.reps,
              lapses: scheduled.card.lapses,
            };
            if (existingCard) {
              await tx
                .update(reviewCards)
                .set(cardValues)
                .where(eq(reviewCards.id, existingCard.id));
            } else {
              const [createdCard] = await tx
                .insert(reviewCards)
                .values({
                  userId,
                  conceptId,
                  dimension,
                  ...cardValues,
                })
                .returning({ id: reviewCards.id });
              cardId = createdCard?.id;
            }
            if (cardId) {
              await tx.insert(reviewLogs).values({
                cardId,
                attemptId: dimensionItems.find((item) => item.attemptId)?.attemptId ?? null,
                rating: String(rating),
                fsrsLog: scheduled.log,
                createdAt: now,
              });
            }
          }
          const ratings = [...dimensionRatings.values()];
          if (
            dimensionRatings.size === itemsByDimension.size &&
            ratings.length > 0 &&
            !ratings.includes(Rating.Again)
          ) {
            await applyImplicitRepetitions(tx, {
              userId,
              conceptId,
              rating: ratings.every((rating) => rating === Rating.Good) ? Rating.Good : Rating.Hard,
              index: resolved.index,
              now,
              timeZone: context.get('timeZone'),
            });
          }
        }
      } else if (!run.quizPassedAt) {
        await tx
          .update(lessonRuns)
          .set({ status: 'quiz', completedAt: null, updatedAt: now })
          .where(eq(lessonRuns.id, run.id));
      }

      const attemptIds = submittedItems.flatMap((item) => (item.attemptId ? [item.attemptId] : []));
      const quizAnswerAttempts = attemptIds.length
        ? await tx.select().from(attempts).where(inArray(attempts.id, attemptIds))
        : [];
      const attachedActivityId =
        body.data.activityId ?? quizAnswerAttempts.find((answer) => answer.activityId)?.activityId;
      if (attachedActivityId) {
        const [activityRow] = await tx
          .select()
          .from(sessionActivities)
          .where(eq(sessionActivities.id, attachedActivityId))
          .limit(1);
        const repo = new LearnerRepository(tx as unknown as Database, userId);
        const session = activityRow ? await repo.session(activityRow.sessionId) : undefined;
        const sessionActivity = session?.activities.find((item) => item.id === attachedActivityId);
        if (
          sessionActivity?.kind === 'learn' &&
          sessionActivity.conceptId === conceptId &&
          session
        ) {
          await updateActivityAndAdvance(tx as unknown as Database, {
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
    if (result.kind === 'not_found') return context.json({ error: 'Lesson quiz not found' }, 404);
    if (result.kind === 'unanswered') {
      return context.json({ error: 'Answer every quiz question before submitting' }, 409);
    }
    if (result.kind === 'invalid_answer') {
      return context.json({ error: 'A saved quiz answer could not be graded' }, 422);
    }
    const [run] = await deps.db
      .select()
      .from(lessonRuns)
      .where(eq(lessonRuns.id, result.runId))
      .limit(1);
    const state = run ? await runState(context, resolved.lesson, resolved.index, run) : null;
    return context.json({
      run: state,
      course: await resolveLessonCourse(
        deps.db,
        deps.withRepo(context),
        resolved.index,
        context.get('userId'),
        conceptId,
        body.data.activityId,
      ),
      xpAwarded: result.kind === 'submitted' ? result.xpAwarded : 0,
    });
  });

  api.get('/lessons/:conceptId/quiz/:attemptId/review', async (context) => {
    if (!z.string().uuid().safeParse(context.req.param('attemptId')).success)
      return context.json({ error: 'Quiz attempt not found' }, 404);
    const conceptId = context.req.param('conceptId');
    const resolved = await lessonFor(conceptId);
    if (!resolved) return context.json({ error: 'Knowledge-point lesson not found' }, 404);
    const [attempt] = await deps.db
      .select({ quiz: lessonQuizAttempts, run: lessonRuns })
      .from(lessonQuizAttempts)
      .innerJoin(lessonRuns, eq(lessonQuizAttempts.runId, lessonRuns.id))
      .where(
        and(
          eq(lessonQuizAttempts.id, context.req.param('attemptId')),
          eq(lessonRuns.userId, context.get('userId')),
          eq(lessonRuns.conceptId, conceptId),
        ),
      )
      .limit(1);
    if (!attempt?.quiz.submittedAt || attempt.quiz.passed !== true) {
      return context.json({ error: 'Quiz review is available after passing' }, 403);
    }
    const rows = await deps.db
      .select()
      .from(lessonQuizItems)
      .where(eq(lessonQuizItems.quizAttemptId, attempt.quiz.id))
      .orderBy(lessonQuizItems.position);
    const items = rows.flatMap((item) => {
      const indexed = resolved.index.exercisesById.get(item.exerciseId);
      const exercise = indexed ? resolvedIndexedExercise(indexed, item.seed) : undefined;
      if (!exercise) return [];
      return [
        {
          id: item.id,
          position: item.position,
          pointId: item.knowledgePointId,
          title:
            resolved.lesson.knowledge_points?.find((point) => point.id === item.knowledgePointId)
              ?.title ?? item.knowledgePointId,
          exercise: serializeExercise(exercise, context.get('userId')),
          yourAnswer: answerDisplay(exercise, item.answer),
          correctAnswer: correctAnswerDisplay(exercise),
          answerOptions: answerOptionsFor(exercise, item.answer, true),
          solution: exercise.solution ?? '',
          correct: item.correct,
          durationMs: item.durationMs,
        },
      ];
    });
    return context.json({ attemptId: attempt.quiz.id, items });
  });

  if (process.env.ACADEMY_E2E === '1') {
    api.get('/test/lesson-problems/:id/answer', async (context) => {
      const [row] = await deps.db
        .select({ problem: lessonProblems, userId: lessonRuns.userId })
        .from(lessonProblems)
        .innerJoin(lessonRuns, eq(lessonProblems.runId, lessonRuns.id))
        .where(
          and(
            eq(lessonProblems.id, context.req.param('id')),
            eq(lessonRuns.userId, context.get('userId')),
          ),
        )
        .limit(1);
      if (!row) return context.json({ error: 'Lesson problem not found' }, 404);
      const exercise = resolvedExercise(
        await deps.content(),
        row.problem.exerciseId,
        row.problem.seed,
      );
      if (!exercise) return context.json({ error: 'Exercise not found' }, 404);
      const answer =
        exercise.type === 'mc'
          ? exercise.multi
            ? exercise.options.filter((option) => option.correct).map((option) => option.id)
            : exercise.options.find((option) => option.correct)?.id
          : 'answer' in exercise
            ? exercise.answer
            : undefined;
      return context.json({ answer });
    });

    api.get('/test/lesson-quiz-items/:id/answer', async (context) => {
      const [row] = await deps.db
        .select({ item: lessonQuizItems, userId: lessonRuns.userId })
        .from(lessonQuizItems)
        .innerJoin(lessonQuizAttempts, eq(lessonQuizItems.quizAttemptId, lessonQuizAttempts.id))
        .innerJoin(lessonRuns, eq(lessonQuizAttempts.runId, lessonRuns.id))
        .where(
          and(
            eq(lessonQuizItems.id, context.req.param('id')),
            eq(lessonRuns.userId, context.get('userId')),
          ),
        )
        .limit(1);
      if (!row) return context.json({ error: 'Quiz item not found' }, 404);
      const exercise = resolvedExercise(await deps.content(), row.item.exerciseId, row.item.seed);
      if (!exercise) return context.json({ error: 'Exercise not found' }, 404);
      const answer =
        exercise.type === 'mc'
          ? exercise.multi
            ? exercise.options.filter((option) => option.correct).map((option) => option.id)
            : exercise.options.find((option) => option.correct)?.id
          : 'answer' in exercise
            ? exercise.answer
            : undefined;
      return context.json({ answer });
    });
  }
}

function resolvedIndexedExercise(
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

function resolvedExercise(index: ContentIndex, exerciseId: string, seed: number | null) {
  const exercise = index.exercisesById.get(exerciseId);
  if (!exercise) return undefined;
  return isTemplate(exercise) && seed !== null
    ? instantiateExercise(exercise, seed).exercise
    : exercise;
}

function localDate(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const fields = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${fields.year}-${fields.month}-${fields.day}`;
}
