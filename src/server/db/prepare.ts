import { resolve } from 'node:path';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import type { Database } from './client.js';
import { users } from './schema.js';

export async function prepareDatabase(db: Database): Promise<void> {
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
}
