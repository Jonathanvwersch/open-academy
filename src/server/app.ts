import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { HealthResponseSchema } from '../shared/health.js';
import { type AuthOptions, createAuth } from './auth.js';
import type { ContentIndex } from './content/types.js';
import type { Database } from './db/client.js';
import type { PaperFetcher } from './papers/fetcher.js';
import { createApiRoutes } from './routes/api.js';
import type { TutorProvider } from './tutor/provider.js';

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

  app.use('/api/*', auth.middleware);

  app.get('/api/health', async (context) => {
    await deps.db.execute(sql`select 1`);
    return context.json(HealthResponseSchema.parse({ ok: true, db: true }));
  });

  app.route('/api/auth', auth.routes);
  app.route('/api', createApiRoutes(deps));

  return app;
}
