import { createDb } from '../src/server/db/client.js';
import { users } from '../src/server/db/schema.js';
import { env } from '../src/server/env.js';

const db = createDb(env.DATABASE_URL);

await db
  .insert(users)
  .values({
    id: '00000000-0000-4000-8000-000000000001',
    displayName: 'Learner',
    timezone: 'Europe/London',
    startDate: new Date().toISOString().slice(0, 10),
    prefs: { scheduleMinutes: 60, goal: 'Build a steady foundation in machine learning.' },
  })
  .onConflictDoUpdate({
    target: users.id,
    set: {
      displayName: 'Learner',
      timezone: 'Europe/London',
    },
  });

await db.$client.end();
