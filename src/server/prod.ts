import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createApp } from './app.js';
import { createDb } from './db/client.js';
import { users } from './db/schema.js';
import { env } from './env.js';

const academyPassword = env.ACADEMY_PASSWORD;
if (!academyPassword || academyPassword.length < 12) {
  throw new Error(
    'ACADEMY_PASSWORD must be set to at least 12 characters before starting production.',
  );
}

const webRoot = resolve('dist/web');
const db = createDb(env.DATABASE_URL);

await migrate(db, { migrationsFolder: resolve('drizzle') });
await db
  .insert(users)
  .values({
    id: '00000000-0000-4000-8000-000000000001',
    displayName: 'Learner',
    timezone: 'Europe/London',
    startDate: new Date().toISOString().slice(0, 10),
    prefs: { scheduleMinutes: 60, goal: 'Build a steady foundation in machine learning.' },
  })
  .onConflictDoNothing();

const indexHtml = await readFile(resolve(webRoot, 'index.html'), 'utf8');
const app = createApp({ db, auth: { password: academyPassword } });
app.use('/*', serveStatic({ root: 'dist/web' }));
app.get('*', (context) =>
  context.req.path.startsWith('/api/') ? context.notFound() : context.html(indexHtml),
);

serve({ fetch: app.fetch, port: env.PORT, hostname: '0.0.0.0' });
console.log(`Academy listening on ${env.PORT}`);
