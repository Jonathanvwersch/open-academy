import type { Hono } from 'hono';
import type { ApiEnv, ApiServices } from '../../http/context.js';
import { featureRequest } from '../../http/feature-service.js';
import { getSettings, putSettings } from './service.js';
export function registerSettingsRoutes(api: Hono<ApiEnv>, deps: ApiServices) {
  api.get('/settings', async (context) => {
    const response = await getSettings(deps, featureRequest(context, deps));
    return context.json(response.body, response.status);
  });
  api.put('/settings', async (context) => {
    const response = await putSettings(
      deps,
      featureRequest(context, deps, await context.req.json().catch(() => ({}))),
    );
    return context.json(response.body, response.status);
  });
}
