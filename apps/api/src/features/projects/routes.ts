import type { Hono } from 'hono';
import type { ApiEnv, ApiServices } from '../../http/context.js';
import { featureRequest } from '../../http/feature-service.js';
import { getProjects, getProjectsById, postProjectsByIdResults } from './service.js';
export function registerProjectsRoutes(api: Hono<ApiEnv>, deps: ApiServices) {
  api.get('/projects', async (context) => {
    const response = await getProjects(deps, featureRequest(context, deps));
    return context.json(response.body, response.status);
  });
  api.get('/projects/:id', async (context) => {
    const response = await getProjectsById(deps, featureRequest(context, deps));
    return context.json(response.body, response.status);
  });
  api.post('/projects/:id/results', async (context) => {
    const response = await postProjectsByIdResults(
      deps,
      featureRequest(context, deps, await context.req.json().catch(() => ({}))),
    );
    return context.json(response.body, response.status);
  });
}
