import type { EngineResult } from '@open-academy/engine';
import type { Context, Hono } from 'hono';
import type { ApiEnv, ApiServices } from '../../http/context.js';

type RouteContext = Context<ApiEnv>;
const send = (context: RouteContext, result: EngineResult) =>
  context.json(result.body, result.status);

export function registerLearnCourseRoutes(api: Hono<ApiEnv>, deps: ApiServices) {
  api.get('/learn', async (context) => {
    return send(context, await deps.learner(context).learn());
  });

  api.get('/courses', async (context) => {
    return send(context, await deps.learner(context).courseCatalog());
  });

  api.put('/focus', async (context) => {
    const body = await context.req.json().catch(() => null);
    return send(context, await deps.learner(context).setFocus({ body }));
  });

  api.get('/courses/:id', async (context) => {
    return send(context, await deps.learner(context).course({ courseId: context.req.param('id') }));
  });

  api.get('/course', async (context) => {
    return send(
      context,
      await deps.learner(context).course({ course: context.req.query('course') }),
    );
  });

  api.put('/course/active', async (context) => {
    return send(
      context,
      await deps.learner(context).setActiveCourse({
        body: await context.req.json().catch(() => null),
      }),
    );
  });

  api.post('/concepts/:id/restart', async (context) => {
    return send(
      context,
      await deps.learner(context).restartTopic({ conceptId: context.req.param('id') }),
    );
  });

  api.put('/courses/:id/enrollment', async (context) => {
    return send(
      context,
      await deps.learner(context).setEnrollment({
        courseId: context.req.param('id'),
        body: await context.req.json().catch(() => null),
      }),
    );
  });

  api.post('/courses/:id/start', async (context) => {
    return send(
      context,
      await deps.learner(context).startCourse({
        courseId: context.req.param('id'),
        body: await context.req.json().catch(() => null),
      }),
    );
  });

  api.post('/course/start', async (context) => {
    return send(
      context,
      await deps.learner(context).startCourse({
        body: await context.req.json().catch(() => null),
      }),
    );
  });
}
