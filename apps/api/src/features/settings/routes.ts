import type { EngineResult } from '@open-academy/engine/engine/create-engine';
import type { Context, Hono } from 'hono';
import type { ApiEnv, ApiServices } from '../../http/context.js';

const send = (context: Context<ApiEnv>, result: EngineResult) =>
  context.json(result.body, result.status);

export function registerSettingsRoutes(api: Hono<ApiEnv>, deps: ApiServices) {
  api.get('/settings', async (context) => {
    return send(context, await deps.learner(context).settings());
  });
  api.put('/settings', async (context) => {
    const body = await context.req.json().catch(() => ({}));
    return send(context, await deps.learner(context).saveSettings({ body }));
  });
}
