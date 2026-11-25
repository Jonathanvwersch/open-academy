import { getLessonPrerequisites } from '@academy/aesop/course/index';
import { serializeExercise } from '@academy/aesop/course/serialize';
import {
  formatTemplateNumber,
  instantiateExercise,
  isTemplate,
} from '@academy/aesop/course/templates';
import type { ContentIndex, IndexedExercise, IndexedLesson } from '@academy/aesop/course/types';
import { answerDisplay, answerText } from '@academy/aesop/lessons/answer-display';
import { answerOptionsFor } from '@academy/aesop/lessons/answer-options';
import { gradeExercise } from '@academy/aesop/lessons/grading/index';
import { MULTIPLE_CHOICE_FALLBACK_FEEDBACK } from '@academy/aesop/lessons/grading/multiple-choice';
import {
  answerLessonProblem,
  answerLessonQuiz,
  type LessonGrader,
  practiceLessonPoint,
  resolveLessonExercise,
  startLessonQuiz,
  startLessonRun,
  submitLessonQuiz,
} from '@academy/aesop/lessons/run-commands';
import type { LessonRuntime } from '@academy/aesop/lessons/run-recovery';
import { readLessonState, readPassedQuiz } from '@academy/aesop/lessons/run-state';
import type { applyMastery } from '@academy/aesop/memory/mastery-service';
import type { LessonRun } from '@academy/aesop/store/lesson-store';
import { emptyAnswerMessage } from '@academy/shared/answer-validation';
import { and, eq, sql } from 'drizzle-orm';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import type { Database } from '../../db/client.js';
import { drizzleLearnerStore } from '../../db/learner-store.js';
import type { LearnerRepository } from '../../db/repository.js';
import {
  lessonProblems,
  lessonQuizAttempts,
  lessonQuizItems,
  lessonRuns,
  tutorMessages,
} from '../../db/schema.js';
import type { ApiEnv } from '../../http/context.js';
import { fsrsFuzzEnabled } from '../../learning/fsrs-fuzz.js';
import { resolveLessonCourse } from './course-context.js';

type LessonContext = Context<ApiEnv>;

const gradeLessonAnswer: LessonGrader = (exercise, answer, { random, requireAnswer }) => {
  const feedback = requireAnswer ? emptyAnswerMessage(exercise.type, answer) : null;
  return feedback
    ? Promise.resolve({ status: 'invalid', feedback, graded_by: 'deterministic' })
    : gradeExercise(exercise, answer, { random });
};

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

type MasteryApplier = typeof applyMastery;

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
  const store = drizzleLearnerStore(deps.db);
  const runtime = (context: LessonContext): LessonRuntime => ({
    now: () => deps.requestNow(context),
    random: () => Math.random(),
    newId: () => crypto.randomUUID(),
    enableFsrsFuzz: fsrsFuzzEnabled(),
  });
  const command = (
    context: LessonContext,
    conceptId: string,
    resolved: { index: ContentIndex; lesson: IndexedLesson },
  ) => ({ userId: context.get('userId'), timeZone: context.get('timeZone'), conceptId, resolved });
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

  const verifyActivity = async (
    context: LessonContext,
    activityId: string | undefined,
    conceptId: string,
  ) => {
    if (!activityId) return { activity: undefined, session: undefined };
    const [activityRow] = await store.listActivities(context.get('userId'), { ids: [activityId] });
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
    const run = await startLessonRun(store, runtime(context), {
      ...command(context, conceptId, resolved),
      reconcileProgress: body.data.reconcileProgress,
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
    const result = await practiceLessonPoint(store, runtime(context), {
      ...command(context, conceptId, resolved),
      ...body.data,
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
    const run = await store.getLessonRun(context.get('userId'), { runId: result.run.id });
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
    const options = runtime(context);
    const result = await answerLessonProblem(
      store,
      options,
      {
        ...command(context, conceptId, resolved),
        ...body.data,
        sessionId: activity.activity ? activity.session?.id : undefined,
      },
      {
        applyMastery: deps.applyMastery,
        grade: gradeLessonAnswer,
        async hasTutorReply(tx, learnerId, problemId) {
          const [reply] = await tx.connection
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
        },
      },
    );
    if (result.kind === 'not_found')
      return context.json({ error: 'Lesson problem not found' }, 404);
    if (result.kind === 'invalid') return context.json({ error: 'Invalid answer' }, 422);
    if (result.kind === 'conflict') {
      const run = await store.getLessonRun(userId, { runId: result.runId });
      return context.json(
        {
          error: 'Lesson problem has already been answered.',
          state:
            run && resolved ? await runState(context, resolved.lesson, resolved.index, run) : null,
        },
        409,
      );
    }
    const run = await store.getLessonRun(userId, { runId: result.runId });
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
    const result = await startLessonQuiz(
      store,
      runtime(context),
      command(context, conceptId, resolved),
    );
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
    const run = await store.getLessonRun(userId, { runId: result.runId });
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
    const result = await answerLessonQuiz(
      store,
      runtime(context),
      { ...command(context, conceptId, resolved), ...body.data },
      gradeLessonAnswer,
    );
    if (result.kind === 'not_found') return context.json({ error: 'Quiz item not found' }, 404);
    if (result.kind === 'invalid') return context.json({ error: 'Invalid answer' }, 422);
    if (result.kind === 'conflict') {
      return context.json({ error: 'Quiz item has already been answered.' }, 409);
    }
    const run = await store.getLessonRun(userId, { runId: result.runId });
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
    const result = await submitLessonQuiz(
      store,
      runtime(context),
      {
        ...command(context, conceptId, resolved),
        ...body.data,
        sessionId: activity.activity ? activity.session?.id : undefined,
      },
      {
        grade: gradeLessonAnswer,
        applyMastery: deps.applyMastery,
      },
    );
    if (result.kind === 'not_found') return context.json({ error: 'Lesson quiz not found' }, 404);
    if (result.kind === 'unanswered') {
      return context.json({ error: 'Answer every quiz question before submitting' }, 409);
    }
    if (result.kind === 'invalid_answer') {
      return context.json({ error: 'A saved quiz answer could not be graded' }, 422);
    }
    const run = await store.getLessonRun(userId, { runId: result.runId });
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
    const userId = context.get('userId');
    const attemptId = context.req.param('attemptId');
    const rows = await readPassedQuiz(store, userId, conceptId, attemptId);
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
