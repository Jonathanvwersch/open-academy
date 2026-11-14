import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createApp } from '../../src/app.js';
import { env } from '../../src/config.js';
import { loadContent } from '../../src/content/load.js';
import * as schema from '../../src/db/schema.js';

// Match the single-connection production pool: redundant reads cannot hide behind concurrency.
const client = postgres(env.TEST_DATABASE_URL, { max: 1, prepare: false });
let statements: string[] = [];
const db = drizzle(client, { schema, logger: { logQuery: (query) => statements.push(query) } });
let app: ReturnType<typeof createApp>;
let userId: string;

beforeAll(async () => {
  await db.delete(schema.users);
  const [user] = await db
    .insert(schema.users)
    .values({ displayName: 'Query budget learner', timezone: 'UTC' })
    .returning();
  if (!user) throw new Error('Expected a learner');
  userId = user.id;
  app = createApp({ db, content: await loadContent(), tutorProvider: null });
});
afterAll(async () => {
  await db.delete(schema.users);
  await client.end();
});

test('Course reads progress without loading review scheduling or attempt history', async () => {
  statements = [];
  const response = await app.request('/api/course');
  expect(response.status).toBe(200);
  expect((await response.json()).units.length).toBeGreaterThan(0);
  expect(statements.length).toBeLessThanOrEqual(14); // Study-course membership and recent-learn estimates.
  expect(statements.join('\n')).not.toMatch(/"review_cards"|"attempts"|"remediation_flags"/);
});

test('tutor availability does not read any learning state', async () => {
  statements = [];
  const response = await app.request('/api/tutor/status');
  expect(await response.json()).toEqual({ tutorEnabled: false });
  expect(response.headers.get('server-timing')).toMatch(/^api;dur=\d+(?:\.\d+)?$/);
  expect(statements).toHaveLength(1); // The request's learner lookup only.
});

test('full lesson review avoids building quiz history and XP summaries', async () => {
  await db.insert(schema.lessonRuns).values({ userId, conceptId: 'supervised-learning' });
  statements = [];
  const response = await app.request('/api/lessons/supervised-learning/review');
  expect(response.status).toBe(200);
  expect((await response.json()).runStatus).toBe('in_progress');
  expect(statements.length).toBeLessThanOrEqual(3);
  expect(statements.join('\n')).not.toMatch(
    /"lesson_quiz_attempts"|"lesson_quiz_items"|"xp_events"/,
  );
  await db.delete(schema.lessonRuns).where(eq(schema.lessonRuns.userId, userId));
});

test('resuming Home uses the existing session instead of rebuilding the schedule', async () => {
  const now = '2026-01-01T12:00:00.000Z';
  const [session] = await db
    .insert(schema.studySessions)
    .values({
      userId,
      kind: 'weekday',
      plannedMinutes: 30,
      status: 'active',
      startedAt: new Date(now),
    })
    .returning();
  if (!session) throw new Error('Expected a session');
  statements = [];
  const response = await app.request('/api/learn', { headers: { 'X-Now': now } });
  expect(response.status).toBe(200);
  expect((await response.json()).activeSessionId).toBe(session.id);
  expect(statements.length).toBeLessThanOrEqual(19); // Study-course membership and recent-learn estimates.
  expect(statements.join('\n')).not.toMatch(/"review_cards"|"attempts"|"remediation_flags"/);
});
