import type { Hono } from 'hono';
import type { ApiEnv, ApiServices } from '../../http/context.js';
import { featureRequest } from '../../http/feature-service.js';
import { getProgress } from './service.js';
export function registerProgressRoutes(api: Hono<ApiEnv>, deps: ApiServices) {
  api.get('/progress', async (context) => {
    const response = await getProgress(deps, featureRequest(context, deps));
    return context.json(response.body, response.status);
  });
}
