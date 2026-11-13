import type { Hono } from 'hono';
import type { ApiEnv, ApiServices } from '../../http/context.js';
import { featureRequest } from '../../http/feature-service.js';
import { getConceptsById, getMap, getPlanWeek } from './overview-service.js';
export function registerCourseRoutes(api: Hono<ApiEnv>, deps: ApiServices) {
  api.get('/map', async (context) => {
    const response = await getMap(deps, featureRequest(context, deps));
    return context.json(response.body, response.status);
  });
  api.get('/concepts/:id', async (context) => {
    const response = await getConceptsById(deps, featureRequest(context, deps));
    return context.json(response.body, response.status);
  });
  api.get('/plan/week', async (context) => {
    const response = await getPlanWeek(deps, featureRequest(context, deps));
    return context.json(response.body, response.status);
  });
}
