import { HealthResponseSchema } from '@academy/contracts/health';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import type { ContentIndex } from './content/types.js';
import type { Database } from './db/client.js';
import { type AuthOptions, createAuth } from './features/auth/routes.js';
import type { PaperFetcher } from './features/papers/fetcher.js';
import type { TutorProvider } from './features/tutor/provider.js';
import { createApiRoutes } from './http/routes.js';

export function createApp(deps: {
  db: Database;
  content?: ContentIndex;
  tutorProvider?: TutorProvider | null;
  paperFetcher?: PaperFetcher;
  auth?: AuthOptions | null;
  authClock?: () => Date;
}) {
  const app = new Hono();
  const auth = createAuth({ db: deps.db, auth: deps.auth, now: deps.authClock });

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
