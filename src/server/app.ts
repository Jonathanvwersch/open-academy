import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { HealthResponseSchema } from '../shared/health.js';
import type { ContentIndex } from './content/types.js';
import type { Database } from './db/client.js';
import { createApiRoutes } from './routes/api.js';

export function createApp(deps: { db: Database; content?: ContentIndex }) {
  const app = new Hono();

  app.get('/api/health', async (context) => {
    await deps.db.execute(sql`select 1`);
    return context.json(HealthResponseSchema.parse({ ok: true, db: true }));
  });

  app.route('/api', createApiRoutes(deps));

  return app;
}
