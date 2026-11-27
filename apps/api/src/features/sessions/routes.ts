import type { EngineResult } from '@open-academy/engine';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import type { ApiEnv, ApiServices } from '../../http/context.js';

const send = (context: Context<ApiEnv>, result: EngineResult) =>
  context.json(result.body, result.status);

export function registerSessionsRoutes(api: Hono<ApiEnv>, deps: ApiServices) {
  api.get('/today', async (context) => {
    return send(context, await deps.learner(context).today());
  });
  api.post('/sessions', async (context) => {
    return send(
      context,
      await deps.learner(context).createSession({
        body: await context.req.json().catch(() => ({})),
      }),
    );
  });
  api.get('/sessions/active', async (context) => {
    return send(context, await deps.learner(context).activeSession());
  });
  api.get('/sessions/:id', async (context) => {
    const sessionId = context.req.param('id');
    if (!z.string().uuid().safeParse(sessionId).success)
      return context.json({ error: 'Session not found' }, 404);
    return send(context, await deps.learner(context).session({ sessionId }));
  });
  api.post('/sessions/:id/activities/:aid/progress', async (context) => {
    const sessionId = context.req.param('id');
    if (!z.string().uuid().safeParse(sessionId).success)
      return context.json({ error: 'Session not found' }, 404);
    return send(
      context,
      await deps.learner(context).activityProgress({
        sessionId,
        activityId: context.req.param('aid'),
        body: await context.req.json().catch(() => ({})),
      }),
    );
  });
  api.post('/sessions/:id/activities/:aid/continue', async (context) => {
    const sessionId = context.req.param('id');
    if (!z.string().uuid().safeParse(sessionId).success)
      return context.json({ error: 'Session not found' }, 404);
    const rawBody = await context.req.text();
    let body: unknown = {};
    if (rawBody) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        body = null;
      }
    }
    return send(
      context,
      await deps.learner(context).continueActivity({
        sessionId,
        activityId: context.req.param('aid'),
        body,
      }),
    );
  });
  api.post('/sessions/:id/replan', async (context) => {
    const sessionId = context.req.param('id');
    if (!z.string().uuid().safeParse(sessionId).success)
      return context.json({ error: 'Session not found' }, 404);
    return send(
      context,
      await deps.learner(context).replanSession({
        sessionId,
        body: (await context.req.json().catch(() => ({}))) as Record<string, unknown>,
      }),
    );
  });
  api.post('/sessions/:id/end', async (context) => {
    const sessionId = context.req.param('id');
    if (!z.string().uuid().safeParse(sessionId).success)
      return context.json({ error: 'Session not found' }, 404);
    return send(context, await deps.learner(context).endSession({ sessionId }));
  });
}
