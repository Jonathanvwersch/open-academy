import type { Hono } from 'hono';
import type { ApiEnv, ApiServices } from '../../http/context.js';

export function registerProjectsRoutes(api: Hono<ApiEnv>, deps: ApiServices) {
  api.get('/projects', async (c) => {
    const response = await deps.learner(c).projects();
    return c.json(response.body, response.status);
  });
  api.get('/projects/:id', async (c) => {
    const response = await deps.learner(c).project({ id: c.req.param('id') });
    return c.json(response.body, response.status);
  });
  api.post('/projects/:id/results', async (c) => {
    const response = await deps.learner(c).submitProjectResults({
      id: c.req.param('id'),
      body: await c.req.json().catch(() => ({})),
    });
    return c.json(response.body, response.status);
  });
}
