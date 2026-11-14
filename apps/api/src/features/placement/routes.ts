import type { Hono } from 'hono';
import type { ApiEnv, ApiServices } from '../../http/context.js';
import { featureRequest } from '../../http/feature-service.js';
import {
  getPlacementNext,
  getPlacementResults,
  postPlacement,
  postPlacementAnswer,
} from './service.js';

export function registerPlacementRoutes(api: Hono<ApiEnv>, deps: ApiServices) {
  api.post('/placement', async (context) => {
    const response = await postPlacement(
      deps,
      featureRequest(context, deps, await context.req.json().catch(() => null)),
    );
    return context.json(response.body, response.status);
  });
  api.get('/placement/:id/next', async (context) => {
    const response = await getPlacementNext(deps, featureRequest(context, deps));
    return context.json(response.body, response.status);
  });
  api.post('/placement/:id/answer', async (context) => {
    const response = await postPlacementAnswer(
      deps,
      featureRequest(context, deps, await context.req.json().catch(() => null)),
    );
    return context.json(response.body, response.status);
  });
  api.get('/placement/:id/results', async (context) => {
    const response = await getPlacementResults(deps, featureRequest(context, deps));
    return context.json(response.body, response.status);
  });
}
