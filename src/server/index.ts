import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { createDb } from './db/client.js';
import { env } from './env.js';

const db = createDb(env.DATABASE_URL);
const app = createApp({ db });

serve({
  fetch: app.fetch,
  port: env.PORT,
});
