import type { EngineResult } from '@open-academy/engine/engine/create-engine';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import type { ApiEnv, ApiServices } from '../../http/context.js';

const send = (context: Context<ApiEnv>, result: EngineResult) =>
  context.json(result.body, result.status);
export function registerPlacementRoutes(api: Hono<ApiEnv>, deps: ApiServices) {
  api.post('/placement', async (context) => {
    return send(
      context,
      await deps.learner(context).startPlacement({
        body: await context.req.json().catch(() => null),
      }),
    );
  });
  api.get('/placement/:id/next', async (context) => {
    const placementId = context.req.param('id');
    if (!z.string().uuid().safeParse(placementId).success)
      return context.json({ error: 'Placement not found' }, 404);
    return send(context, await deps.learner(context).placementNext({ placementId }));
  });
  api.post('/placement/:id/answer', async (context) => {
    const placementId = context.req.param('id');
    if (!z.string().uuid().safeParse(placementId).success)
      return context.json({ error: 'Placement not found' }, 404);
    return send(
      context,
      await deps.learner(context).placementAnswer({
        placementId,
        body: await context.req.json().catch(() => null),
      }),
    );
  });
  api.get('/placement/:id/results', async (context) => {
    const placementId = context.req.param('id');
    if (!z.string().uuid().safeParse(placementId).success)
      return context.json({ error: 'Placement not found' }, 404);
    return send(context, await deps.learner(context).placementResults({ placementId }));
  });
}
