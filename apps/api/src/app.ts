import { HealthResponseSchema } from '@academy/contracts/health';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import type { ContentIndex } from './content/types.js';
import type { Database } from './db/client.js';
import {
  type AuthOptions,
  createAuth,
  isSecureRequest,
  requestIp,
} from './features/auth/routes.js';
import { createDemoLearnerResolver } from './features/demo/learner.js';
import type { PaperFetcher } from './features/papers/fetcher.js';
import type { TutorProvider } from './features/tutor/provider.js';
import type { ApiEnv } from './http/context.js';
import { isValidTimeZone } from './http/request-context.js';
import { createApiRoutes } from './http/routes.js';

export function createApp(deps: {
  db: Database;
  content?: ContentIndex;
  tutorProvider?: TutorProvider | null;
  paperFetcher?: PaperFetcher;
  auth?: AuthOptions | null;
  authClock?: () => Date;
  demo?: { ttlHours: number } | null;
}) {
  const app = new Hono<ApiEnv>();
  const demo = deps.demo ?? null;
  const auth = createAuth({ db: deps.db, auth: deps.auth, now: deps.authClock, demo });
  if (demo) {
    const resolve = createDemoLearnerResolver(deps.db, demo.ttlHours);
    app.use('/api/*', async (context, next) => {
      const path = context.req.path;
      if (path === '/api/health' || (path.startsWith('/api/auth/') && path !== '/api/auth/me'))
        return next();
      const requestedTimeZone = context.req.header('X-Time-Zone');
      const result = await resolve({
        cookie: getCookie(context, 'academy_demo'),
        ip: requestIp(context),
        timeZone: isValidTimeZone(requestedTimeZone) ? requestedTimeZone : 'Europe/London',
        now: deps.authClock?.() ?? new Date(),
      });
      if (!result)
        return context.json({ error: 'Too many new demo learners, try again later' }, 429);
      context.set('user', result.user);
      if (result.created)
        setCookie(context, 'academy_demo', result.user.id, {
          httpOnly: true,
          sameSite: 'Lax',
          path: '/',
          secure: isSecureRequest(context),
          maxAge: demo.ttlHours * 3600,
        });
      await next();
    });
  }

  // Expose server work separately from network latency in production browser timings.
  app.use('/api/*', async (context, next) => {
    const started = performance.now();
    await next();
    context.header('Server-Timing', `api;dur=${(performance.now() - started).toFixed(1)}`);
  });
  app.use('/api/*', auth.middleware);

  app.get('/api/health', async (context) => {
    await deps.db.execute(sql`select 1`);
    return context.json(HealthResponseSchema.parse({ ok: true, db: true }));
  });

  app.route('/api/auth', auth.routes);
  app.route('/api', createApiRoutes(deps));

  return app;
}
