import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { env } from './config.js';
import { createDb } from './db/client.js';

const db = createDb(env.DATABASE_URL);
const app = createApp({
  db,
  auth: env.ACADEMY_PASSWORD ? { password: env.ACADEMY_PASSWORD } : null,
});

serve({
  fetch: app.fetch,
  port: env.PORT,
});
