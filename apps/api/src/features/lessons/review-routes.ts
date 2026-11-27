import type { EngineResult } from '@open-academy/engine/engine/create-engine';
import type { Context, Hono } from 'hono';
import type { ApiEnv, ApiServices } from '../../http/context.js';

const send = (context: Context<ApiEnv>, result: EngineResult) =>
  context.json(result.body, result.status);

export function registerLessonsRoutes(api: Hono<ApiEnv>, deps: ApiServices) {
  api.get('/lessons/:conceptId', async (context) => {
    return send(
      context,
      await deps.learner(context).lesson({ conceptId: context.req.param('conceptId') }),
    );
  });
  api.get('/lessons/:conceptId/review', async (context) => {
    return send(
      context,
      await deps.learner(context).lessonReview({ conceptId: context.req.param('conceptId') }),
    );
  });
}
