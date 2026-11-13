import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { env } from '../src/config.js';
import { createDb } from '../src/db/client.js';
import { repositoryPath } from '../src/paths.js';

export default async function setup() {
  const db = createDb(env.TEST_DATABASE_URL);
  await migrate(db, { migrationsFolder: repositoryPath('apps/api/drizzle') });
  await db.$client.end();
}
