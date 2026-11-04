import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { HealthResponseSchema } from '../shared/health.js';
import type { Database } from './db/client.js';

export function createApp(deps: { db: Database }) {
  const app = new Hono();

  app.get('/api/health', async (context) => {
    await deps.db.execute(sql`select 1`);
    return context.json(HealthResponseSchema.parse({ ok: true, db: true }));
  });

  return app;
}
