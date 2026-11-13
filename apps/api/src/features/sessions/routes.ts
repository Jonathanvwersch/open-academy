import type { Hono } from 'hono';
import type { ApiEnv, ApiServices } from '../../http/context.js';
import { featureRequest } from '../../http/feature-service.js';
import {
  getSessionsActive,
  getSessionsById,
  getToday,
  postSessions,
  postSessionsByIdActivitiesByAidProgress,
  postSessionsByIdEnd,
  postSessionsByIdReplan,
} from './service.js';
export function registerSessionsRoutes(api: Hono<ApiEnv>, deps: ApiServices) {
  api.get('/today', async (context) => {
    const response = await getToday(deps, featureRequest(context, deps));
    return context.json(response.body, response.status);
  });
  api.post('/sessions', async (context) => {
    const response = await postSessions(
      deps,
      featureRequest(context, deps, await context.req.json().catch(() => ({}))),
    );
    return context.json(response.body, response.status);
  });
  api.get('/sessions/active', async (context) => {
    const response = await getSessionsActive(deps, featureRequest(context, deps));
    return context.json(response.body, response.status);
  });
  api.get('/sessions/:id', async (context) => {
    const response = await getSessionsById(deps, featureRequest(context, deps));
    return context.json(response.body, response.status);
  });
  api.post('/sessions/:id/activities/:aid/progress', async (context) => {
    const response = await postSessionsByIdActivitiesByAidProgress(
      deps,
      featureRequest(context, deps, await context.req.json().catch(() => ({}))),
    );
    return context.json(response.body, response.status);
  });
  api.post('/sessions/:id/replan', async (context) => {
    const response = await postSessionsByIdReplan(
      deps,
      featureRequest(context, deps, await context.req.json().catch(() => ({}))),
    );
    return context.json(response.body, response.status);
  });
  api.post('/sessions/:id/end', async (context) => {
    const response = await postSessionsByIdEnd(deps, featureRequest(context, deps));
    return context.json(response.body, response.status);
  });
}
