import type { EngineResult } from '@open-academy/engine/engine/create-engine';
import type { Context, Hono } from 'hono';
import type { ApiEnv, ApiServices } from '../../http/context.js';

const send = (context: Context<ApiEnv>, result: EngineResult) =>
  context.json(result.body, result.status);

export function registerCourseRoutes(api: Hono<ApiEnv>, deps: ApiServices) {
  api.get('/study-map', async (context) => {
    return send(context, await deps.learner(context).studyMap());
  });
  api.get('/concepts/:id', async (context) => {
    return send(
      context,
      await deps.learner(context).concept({ conceptId: context.req.param('id') }),
    );
  });
  api.get('/plan/week', async (context) => {
    return send(context, await deps.learner(context).planWeek());
  });
}
