import { and, eq, like } from 'drizzle-orm';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { serializeExercise } from '../content/serialize.js';
import { formatTemplateNumber, instantiateExercise, isTemplate } from '../content/templates.js';
import type { ContentIndex, IndexedExercise, IndexedLesson } from '../content/types.js';
import type { Database } from '../db/client.js';
import { LearnerRepository } from '../db/repository.js';
import { attempts, lessonProblems, lessonRuns, sessionActivities, xpEvents } from '../db/schema.js';
import { gradeExercise } from '../grading/index.js';
import { updateActivityAndAdvance } from '../learning/activity-completion.js';
import {
  deriveLessonState,
  selectNextProblem,
  xpForPassedPoint,
} from '../learning/lesson-runner.js';
import { calculateCredit } from '../learning/mastery.js';
import type { ApiEnv } from './api.js';

type LessonContext = Context<ApiEnv>;

function answerText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return formatTemplateNumber(value);
  if (Array.isArray(value)) return value.map(answerText).join(', ');
  if (value && typeof value === 'object') return JSON.stringify(value);
  return '';
}

function answerDisplay(exercise: IndexedExercise, answer: unknown): string {
  if (exercise.type === 'mc') {
    const ids = Array.isArray(answer) ? answer : [answer];
    return ids
      .map((id) => exercise.options.find((option) => option.id === id)?.text ?? answerText(id))
      .join('\n');
  }
  if (exercise.type === 'numeric') {
    const numeric = typeof answer === 'number' ? answer : Number(answer);
    return Number.isFinite(numeric) ? formatTemplateNumber(numeric) : answerText(answer);
  }
  return answerText(answer);
}

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
  mode: 'practice';
  gradedBy: 'deterministic' | 'llm' | 'self';
  now: Date;
}) => Promise<unknown>;

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
    const rows = await deps.db
      .select()
      .from(lessonProblems)
      .where(eq(lessonProblems.runId, run.id))
      .orderBy(lessonProblems.servedAt, lessonProblems.position);
    const derived = deriveLessonState(lesson, rows);
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
    const feedback =
      lastInstance?.type === 'mc' &&
      attemptFeedback === 'Select the option or set of options that answers the prompt.'
        ? ''
        : (attemptFeedback ?? (lastRow?.correct === 1 ? 'Correct.' : 'Not quite.'));
    const earnedEvents = await deps.db
      .select({ amount: xpEvents.amount })
      .from(xpEvents)
      .where(and(eq(xpEvents.userId, userId), like(xpEvents.sourceKey, `kp:${run.id}:%`)));
    return {
      id: run.id,
      status: derived.status,
      points: derived.points.map((point) => ({
        ...point,
        xpEarned: point.status === 'passed' ? xpForPassedPoint(point.answered) : 0,
      })),
      currentPointId: derived.currentPointId,
      currentPoint: point
        ? { id: point.id, title: point.title, explain: point.explain, worked: point.worked }
        : undefined,
      pending: pendingRow,
      pendingProblem:
        pendingRow && pendingInstance
          ? { ...pendingRow, exercise: serializeExercise(pendingInstance, userId) }
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
                feedback,
                solution: lastInstance.solution,
                yourAnswer: answerDisplay(lastInstance, lastAttempt?.answer),
                correctAnswer: correctAnswerDisplay(lastInstance),
              },
            }
          : undefined,
      xpEarned: earnedEvents.reduce((sum, event) => sum + event.amount, 0),
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
      run: run ? await runState(context, resolved.lesson, resolved.index, run) : null,
    });
  });

  api.post('/lessons/:conceptId/run', async (context) => {
    const conceptId = context.req.param('conceptId');
    const resolved = await lessonFor(conceptId);
    if (!resolved) return context.json({ error: 'Knowledge-point lesson not found' }, 404);
    const body = z
      .object({ activityId: z.string().uuid().optional() })
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
      let state = deriveLessonState(resolved.lesson, problems);
      if (state.status === 'completed') {
        if (existing.status !== 'completed') {
          [existing] = await tx
            .update(lessonRuns)
            .set({ status: 'completed', updatedAt: now, completedAt: now })
            .where(eq(lessonRuns.id, existing.id))
            .returning();
        }
        return existing;
      }
      let round = state.points.find((point) => point.id === state.currentPointId)?.round ?? 1;
      if (state.status === 'needs_retry') {
        round += 1;
        [existing] = await tx
          .update(lessonRuns)
          .set({ status: 'in_progress', updatedAt: now, completedAt: null })
          .where(eq(lessonRuns.id, existing.id))
          .returning();
        state = deriveLessonState(resolved.lesson, problems);
      }
      if (existing.status !== 'in_progress') {
        [existing] = await tx
          .update(lessonRuns)
          .set({ status: 'in_progress', updatedAt: now, completedAt: null })
          .where(eq(lessonRuns.id, existing.id))
          .returning();
      }
      if (state.pending || !state.currentPointId) return existing;
      const point = resolved.lesson.knowledge_points?.find(
        (item) => item.id === state.currentPointId,
      );
      if (!point) return existing;
      const pointRows = problems.filter(
        (problem) => problem.knowledgePointId === point.id && problem.round === round,
      );
      const selection = selectNextProblem(
        point,
        resolved.index.exercisesById,
        pointRows,
        Math.floor(Math.random() * 0x80000000),
      );
      if (!selection) return existing;
      await tx.insert(lessonProblems).values({
        runId: existing.id,
        knowledgePointId: point.id,
        round,
        position: selection.position,
        exerciseId: selection.exerciseId,
        seed: selection.seed,
        servedAt: now,
      });
      return existing;
    });
    return context.json({ run: await runState(context, resolved.lesson, resolved.index, run) });
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
      if (deriveLessonState(resolved.lesson, allProblems).pending?.id !== joined.problem.id) {
        return { kind: 'conflict' as const, runId: joined.run.id };
      }
      const indexed = resolved.index.exercisesById.get(joined.problem.exerciseId);
      if (!indexed) return { kind: 'not_found' as const };
      if (joined.run.status === 'completed') {
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
        now,
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
      );
      const state = deriveLessonState(resolved.lesson, problems);
      const point = state.points.find((item) => item.id === joined.problem.knowledgePointId);
      let xpAwarded = 0;
      if (
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
      await tx
        .update(lessonRuns)
        .set({
          status: state.status,
          updatedAt: now,
          completedAt: state.status === 'completed' ? now : null,
        })
        .where(eq(lessonRuns.id, joined.run.id));
      if (
        (state.status === 'completed' || state.status === 'needs_retry') &&
        activity.activity &&
        activity.session
      ) {
        await updateActivityAndAdvance(tx as unknown as Database, {
          activityId: activity.activity.id,
          completed: true,
          now,
          session: activity.session,
          exerciseIds: activity.activity.exerciseIds,
          progress: activity.activity.progress,
          knowledgePointActivity: true,
        });
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
  }
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
