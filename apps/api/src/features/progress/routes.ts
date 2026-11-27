import type { EngineResult } from '@open-academy/engine';
import type { Context, Hono } from 'hono';
import type { ApiEnv, ApiServices } from '../../http/context.js';

const send = (context: Context<ApiEnv>, result: EngineResult) =>
  context.json(result.body, result.status);

export function registerProgressRoutes(api: Hono<ApiEnv>, deps: ApiServices) {
  api.get('/progress', async (context) => {
    return send(context, await deps.learner(context).progress());
  });
}
