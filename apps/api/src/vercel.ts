import { createApp } from './app.js';
import { env } from './config.js';
import { createDb } from './db/client.js';

const academyPassword = env.ACADEMY_PASSWORD;
if (!academyPassword || academyPassword.length < 12) {
  throw new Error(
    'ACADEMY_PASSWORD must be set to at least 12 characters before starting production.',
  );
}

const db = createDb(env.DATABASE_URL);
const app = createApp({ db, auth: { password: academyPassword } });

export default app;
