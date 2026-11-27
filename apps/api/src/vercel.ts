import { readFileSync } from 'node:fs';
import { deserialize } from 'node:v8';
import type { ContentIndex } from '@open-academy/engine/course/types';
import { createApp } from './app.js';
import { env, productionAuth } from './config.js';
import { createDb } from './db/client.js';

const auth = productionAuth(env.ACADEMY_DEMO, env.ACADEMY_PASSWORD);

const db = createDb(env.DATABASE_URL);
const content = deserialize(
  readFileSync(new URL('./content.bin', import.meta.url)),
) as ContentIndex;
const app = createApp({
  db,
  content,
  auth,
  ...(env.ACADEMY_DEMO
    ? { demo: { ttlHours: env.ACADEMY_DEMO_TTL_HOURS }, tutorProvider: null }
    : {}),
});

export default app;
