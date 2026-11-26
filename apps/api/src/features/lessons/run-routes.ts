import { getLessonPrerequisites } from '@academy/aesop/course/index';
import { serializeExercise } from '@academy/aesop/course/serialize';
import {
  formatTemplateNumber,
  instantiateExercise,
  isTemplate,
} from '@academy/aesop/course/templates';
import type { ContentIndex, IndexedExercise, IndexedLesson } from '@academy/aesop/course/types';
import type { EngineHasTutorReply, EngineResult } from '@academy/aesop/engine/create-engine';
import { answerDisplay, answerText } from '@academy/aesop/lessons/answer-display';
import { answerOptionsFor } from '@academy/aesop/lessons/answer-options';
import { MULTIPLE_CHOICE_FALLBACK_FEEDBACK } from '@academy/aesop/lessons/grading/multiple-choice';
import { resolveLessonExercise } from '@academy/aesop/lessons/run-commands';
import type { LessonRuntime } from '@academy/aesop/lessons/run-recovery';
import { readLessonState } from '@academy/aesop/lessons/run-state';
import type { LessonRun } from '@academy/aesop/store/lesson-store';
import { and, eq, sql } from 'drizzle-orm';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { drizzleLearnerStore, readPassedLessonQuizItems } from '../../db/learner-store.js';
import {
  lessonProblems,
  lessonQuizAttempts,
  lessonQuizItems,
  lessonRuns,
  tutorMessages,
} from '../../db/schema.js';
import type { ApiEnv, ApiServices } from '../../http/context.js';
import { fsrsFuzzEnabled } from '../../learning/fsrs-fuzz.js';
import { resolveLessonCourse } from './course-context.js';

type LessonContext = Context<ApiEnv>;
const send = (context: LessonContext, result: EngineResult) =>
  context.json(result.body, result.status);

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

export function registerLessonRunRoutes(api: Hono<ApiEnv>, deps: ApiServices) {
  const store = drizzleLearnerStore(deps.db);
  const runtime = (context: LessonContext): LessonRuntime => ({
    now: () => deps.requestNow(context),
    random: () => Math.random(),
    newId: () => crypto.randomUUID(),
    enableFsrsFuzz: fsrsFuzzEnabled(),
  });
  const lessonFor = async (conceptId: string) => {
    const index = await deps.content();
    const lesson = index.lessonsByConcept.get(conceptId);
    if (!lesson?.knowledge_points?.length) return undefined;
    return { index, lesson };
  };
  const hasTutorReply: EngineHasTutorReply = async (tx, learnerId, problemId) => {
    const [reply] = await (tx as ReturnType<typeof drizzleLearnerStore>).connection
      .select({ id: tutorMessages.id })
      .from(tutorMessages)
      .where(
        and(
          eq(tutorMessages.userId, learnerId),
          eq(tutorMessages.lessonProblemId, problemId),
          sql`${tutorMessages.role} = 'assistant'`,
        ),
      )
      .limit(1);
    return !!reply;
  };

  const runState = async (
    context: LessonContext,
    lesson: IndexedLesson,
    index: ContentIndex,
    run: LessonRun,
  ) => {
    const userId = context.get('userId');
    const snapshot = await readLessonState(store, userId, run, lesson, index, runtime(context));
    if (!snapshot) return null;
    ({ run } = snapshot);
    const { derived, lastAttempt, practicePending, needsProgressSync, retry, currentQuiz } =
      snapshot;
    const point = lesson.knowledge_points?.find((item) => item.id === derived.currentPointId);
    const buildInstance = resolveLessonExercise;
    const pendingRow = derived.pending;
    const pendingExercise = pendingRow ? index.exercisesById.get(pendingRow.exerciseId) : undefined;
    const pendingInstance =
      pendingExercise && pendingRow ? buildInstance(pendingExercise, pendingRow.seed) : undefined;
    const lastRow = derived.lastAnswered;
    const lastExercise = lastRow ? index.exercisesById.get(lastRow.exerciseId) : undefined;
    const lastInstance =
      lastExercise && lastRow ? buildInstance(lastExercise, lastRow.seed) : undefined;
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
    const practiceExercise = practicePending
      ? index.exercisesById.get(practicePending.exerciseId)
      : undefined;
    const practiceInstance =
      practiceExercise && practicePending
        ? buildInstance(practiceExercise, practicePending.seed)
        : undefined;
    const quiz = currentQuiz
      ? {
          ...snapshot.quiz,
          current: {
            attemptId: currentQuiz.attemptId,
            items: currentQuiz.items.map((item) => {
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
      : snapshot.quiz;
    return {
      id: run.id,
      ...(needsProgressSync ? { needsProgressSync: true } : {}),
      status: run.status === 'needs_retry' ? 'needs_retry' : derived.status,
      ...(retry ? { retry: { ...retry, after: retry.after?.toISOString() ?? null } } : {}),
      ...(derived.halted ? { halted: derived.halted } : {}),
      where_this_fits: lesson.where_this_fits,
      prerequisites: getLessonPrerequisites(index, lesson.concept),
      points: snapshot.points,
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
      lastAnswered: lastInstance ? lastRow : undefined,
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
      xpEarned: snapshot.xpEarned,
      quiz,
    };
  };

  api.get('/lessons/:conceptId/run', async (context) => {
    const conceptId = context.req.param('conceptId');
    const resolved = await lessonFor(conceptId);
    if (!resolved) return context.json({ error: 'Knowledge-point lesson not found' }, 404);
    const run = await store.getLessonRun(context.get('userId'), { conceptId });
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
    if (!(await lessonFor(conceptId)))
      return context.json({ error: 'Knowledge-point lesson not found' }, 404);
    const body = z
      .object({
        activityId: z.string().uuid().optional(),
        reconcileProgress: z.boolean().optional(),
      })
      .safeParse(await context.req.json().catch(() => ({})));
    if (!body.success) return context.json({ error: 'Invalid lesson run request' }, 400);
    return send(
      context,
      await deps.learner(context).startLessonRun({
        conceptId,
        body: body.data,
      }),
    );
  });
  api.post('/lessons/:conceptId/run/practice', async (context) => {
    const conceptId = context.req.param('conceptId');
    if (!(await lessonFor(conceptId)))
      return context.json({ error: 'Knowledge-point lesson not found' }, 404);
    const body = z
      .object({
        pointId: z.string().min(1),
        activityId: z.string().uuid().optional(),
        warmup: z.boolean().optional(),
      })
      .safeParse(await context.req.json().catch(() => ({})));
    if (!body.success) return context.json({ error: 'Invalid practice request' }, 400);
    return send(
      context,
      await deps.learner(context).practiceLessonPoint({
        conceptId,
        body: body.data,
      }),
    );
  });
  api.post('/lessons/:conceptId/run/answer', async (context) => {
    const conceptId = context.req.param('conceptId');
    if (!(await lessonFor(conceptId)))
      return context.json({ error: 'Knowledge-point lesson not found' }, 404);
    const body = z
      .object({
        problemId: z.string().uuid(),
        answer: z.unknown(),
        activityId: z.string().uuid().optional(),
        durationMs: z.number().int().nonnegative().optional(),
      })
      .safeParse(await context.req.json().catch(() => ({})));
    if (!body.success) return context.json({ error: 'Invalid lesson answer' }, 400);
    return send(
      context,
      await deps.learner(context, undefined, hasTutorReply).answerLessonProblem({
        conceptId,
        body: body.data,
      }),
    );
  });
  api.post('/lessons/:conceptId/quiz/start', async (context) => {
    const conceptId = context.req.param('conceptId');
    if (!(await lessonFor(conceptId)))
      return context.json({ error: 'Knowledge-point lesson not found' }, 404);
    const body = z
      .object({ activityId: z.string().uuid().optional() })
      .safeParse(await context.req.json().catch(() => ({})));
    if (!body.success) return context.json({ error: 'Invalid quiz request' }, 400);
    return send(
      context,
      await deps.learner(context).startLessonQuiz({
        conceptId,
        body: body.data,
      }),
    );
  });
  api.post('/lessons/:conceptId/quiz/answer', async (context) => {
    const conceptId = context.req.param('conceptId');
    if (!(await lessonFor(conceptId)))
      return context.json({ error: 'Knowledge-point lesson not found' }, 404);
    const body = z
      .object({
        itemId: z.string().uuid(),
        answer: z.unknown(),
        activityId: z.string().uuid().optional(),
        durationMs: z.number().int().nonnegative().optional(),
      })
      .safeParse(await context.req.json().catch(() => ({})));
    if (!body.success) return context.json({ error: 'Invalid quiz answer' }, 400);
    return send(
      context,
      await deps.learner(context).answerLessonQuiz({
        conceptId,
        body: body.data,
      }),
    );
  });
  api.post('/lessons/:conceptId/quiz/submit', async (context) => {
    const conceptId = context.req.param('conceptId');
    if (!(await lessonFor(conceptId)))
      return context.json({ error: 'Knowledge-point lesson not found' }, 404);
    const body = z
      .object({ activityId: z.string().uuid().optional() })
      .safeParse(await context.req.json().catch(() => ({})));
    if (!body.success) return context.json({ error: 'Invalid quiz submission' }, 400);
    return send(
      context,
      await deps.learner(context).submitLessonQuiz({
        conceptId,
        body: body.data,
      }),
    );
  });

  api.get('/lessons/:conceptId/quiz/:attemptId/review', async (context) => {
    if (!z.string().uuid().safeParse(context.req.param('attemptId')).success)
      return context.json({ error: 'Quiz attempt not found' }, 404);
    const conceptId = context.req.param('conceptId');
    const resolved = await lessonFor(conceptId);
    if (!resolved) return context.json({ error: 'Knowledge-point lesson not found' }, 404);
    const userId = context.get('userId');
    const attemptId = context.req.param('attemptId').toLowerCase();
    const rows = await readPassedLessonQuizItems(deps.db, userId, conceptId, attemptId);
    if (!rows) {
      return context.json({ error: 'Quiz review is available after passing' }, 403);
    }
    const items = rows.flatMap((item) => {
      const indexed = resolved.index.exercisesById.get(item.exerciseId);
      const exercise = indexed ? resolveLessonExercise(indexed, item.seed) : undefined;
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
    return context.json({ attemptId, items });
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

function resolvedExercise(index: ContentIndex, exerciseId: string, seed: number | null) {
  const exercise = index.exercisesById.get(exerciseId);
  if (!exercise) return undefined;
  return isTemplate(exercise) && seed !== null
    ? instantiateExercise(exercise, seed).exercise
    : exercise;
}
