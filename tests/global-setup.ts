import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDb } from '../src/server/db/client.js';
import { env } from '../src/server/env.js';

export default async function setup() {
  const db = createDb(env.TEST_DATABASE_URL);
  await migrate(db, { migrationsFolder: './drizzle' });
  await db.$client.end();
}
