import type { EngineHasTutorReply, EngineResult } from '@open-academy/engine';
import { and, eq, sql } from 'drizzle-orm';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import type { drizzleLearnerStore } from '../../db/learner-store.js';
import {
  lessonProblems,
  lessonQuizAttempts,
  lessonQuizItems,
  lessonRuns,
  tutorMessages,
} from '../../db/schema.js';
import type { ApiEnv, ApiServices } from '../../http/context.js';

type LessonContext = Context<ApiEnv>;
const send = (context: LessonContext, result: EngineResult) =>
  context.json(result.body, result.status);

export function registerLessonRunRoutes(api: Hono<ApiEnv>, deps: ApiServices) {
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

  api.get('/lessons/:conceptId/run', async (context) => {
    const conceptId = context.req.param('conceptId');
    const activityId = context.req.query('activityId');
    return send(
      context,
      await deps.learner(context).lessonRun({
        conceptId,
        ...(activityId === undefined ? {} : { activityId }),
      }),
    );
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
      await deps.learner(context, { hasTutorReply }).answerLessonProblem({
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
    const attemptId = context.req.param('attemptId');
    if (!z.string().uuid().safeParse(attemptId).success)
      return context.json({ error: 'Quiz attempt not found' }, 404);
    return send(
      context,
      await deps.learner(context).lessonQuizReview({
        conceptId: context.req.param('conceptId'),
        attemptId: attemptId.toLowerCase(),
      }),
    );
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
      const content = await deps.content();
      if (!content.exercisesById.has(row.problem.exerciseId)) {
        return context.json({ error: 'Exercise not found' }, 404);
      }
      const { answerFor } = await import('@open-academy/engine/simulator');
      return context.json({
        answer: answerFor(content, row.problem.exerciseId, row.problem.seed ?? 0),
      });
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
      const content = await deps.content();
      if (!content.exercisesById.has(row.item.exerciseId)) {
        return context.json({ error: 'Exercise not found' }, 404);
      }
      const { answerFor } = await import('@open-academy/engine/simulator');
      return context.json({
        answer: answerFor(content, row.item.exerciseId, row.item.seed ?? 0),
      });
    });
  }
}
