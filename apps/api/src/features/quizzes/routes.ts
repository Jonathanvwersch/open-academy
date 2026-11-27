import type { EngineResult } from '@open-academy/engine';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import type { ApiEnv, ApiServices } from '../../http/context.js';

const send = (context: Context<ApiEnv>, result: EngineResult) =>
  context.json(result.body, result.status);
export function registerQuizRoutes(api: Hono<ApiEnv>, deps: ApiServices) {
  api.post('/quizzes/start', async (context) => {
    const body = z
      .object({ sessionId: z.string().uuid(), activityId: z.string().uuid() })
      .safeParse(await context.req.json().catch(() => ({})));
    if (!body.success) return context.json({ error: 'Invalid quiz activity' }, 400);
    return send(
      context,
      await deps.learner(context).startTimedQuiz({
        body: body.data,
      }),
    );
  });
  api.get('/quizzes/:id', async (context) => {
    const quizId = context.req.param('id');
    if (!z.string().uuid().safeParse(quizId).success)
      return context.json({ error: 'Quiz not found' }, 404);
    return send(context, await deps.learner(context).timedQuiz({ quizId }));
  });
  api.post('/quizzes/:id/answer', async (context) => {
    const body = z
      .object({
        position: z.number().int().nonnegative(),
        questionId: z.string().min(1).optional(),
        answer: z.unknown(),
      })
      .safeParse(await context.req.json().catch(() => ({})));
    if (!body.success) return context.json({ error: 'Invalid quiz answer' }, 400);
    const quizId = context.req.param('id');
    if (!z.string().uuid().safeParse(quizId).success)
      return context.json({ error: 'Quiz not found' }, 404);
    return send(
      context,
      await deps.learner(context).answerTimedQuiz({
        quizId,
        body: body.data,
      }),
    );
  });
  api.post('/quizzes/:id/finalize', async (context) => {
    const quizId = context.req.param('id');
    if (!z.string().uuid().safeParse(quizId).success)
      return context.json({ error: 'Quiz not found' }, 404);
    return send(context, await deps.learner(context).finalizeTimedQuiz({ quizId }));
  });
  api.post('/quizzes/:id/follow-ups', async (context) => {
    const quizId = context.req.param('id');
    if (!z.string().uuid().safeParse(quizId).success)
      return context.json({ error: 'Quiz not found' }, 404);
    return send(context, await deps.learner(context).timedQuizFollowUps({ quizId }));
  });
  api.post('/quizzes/:id/retake', async (context) => {
    const quizId = context.req.param('id');
    if (!z.string().uuid().safeParse(quizId).success)
      return context.json({ error: 'Quiz not found' }, 404);
    return send(context, await deps.learner(context).retakeTimedQuiz({ quizId }));
  });
}
