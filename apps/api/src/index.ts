import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { env, productionAuth } from './config.js';
import { createDb } from './db/client.js';

const db = createDb(env.DATABASE_URL);
const app = createApp({
  db,
  auth: env.ACADEMY_DEMO
    ? productionAuth(true, env.ACADEMY_PASSWORD)
    : env.ACADEMY_PASSWORD
      ? { password: env.ACADEMY_PASSWORD }
      : null,
  ...(env.ACADEMY_DEMO
    ? { demo: { ttlHours: env.ACADEMY_DEMO_TTL_HOURS }, tutorProvider: null }
    : {}),
});

serve({
  fetch: app.fetch,
  port: env.PORT,
});
