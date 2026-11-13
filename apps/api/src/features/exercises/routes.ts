import type { Hono } from 'hono';
import type { ApiEnv, ApiServices } from '../../http/context.js';
import { featureRequest } from '../../http/feature-service.js';
import { getExercisesById, postAttempts, postHints } from './service.js';
export function registerExercisesRoutes(api: Hono<ApiEnv>, deps: ApiServices) {
  api.get('/exercises/:id', async (context) => {
    const response = await getExercisesById(deps, featureRequest(context, deps));
    return context.json(response.body, response.status);
  });
  api.post('/hints', async (context) => {
    const response = await postHints(
      deps,
      featureRequest(context, deps, await context.req.json().catch(() => ({}))),
    );
    return context.json(response.body, response.status);
  });
  api.post('/attempts', async (context) => {
    const response = await postAttempts(
      deps,
      featureRequest(context, deps, await context.req.json().catch(() => ({}))),
    );
    return context.json(response.body, response.status);
  });
}
