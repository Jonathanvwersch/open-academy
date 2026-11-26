import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createApp } from '../../src/app.js';
import { env } from '../../src/config.js';
import { loadContent } from '../../src/content/load.js';
import { drizzleLearnerStore } from '../../src/db/learner-store.js';
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
  const initialization = await app.request('/api/course');
  expect(initialization.status).toBe(200);
  statements = [];
  const response = await app.request('/api/course');
  expect(response.status).toBe(200);
  expect((await response.json()).units.length).toBeGreaterThan(0);
  expect(statements.length).toBeLessThanOrEqual(8); // Steady-state membership uses no extra reads.
  expect(statements.join('\n')).not.toMatch(/"review_cards"|"attempts"|"remediation_flags"/);
});

test('tutor availability does not read any learning state', async () => {
  statements = [];
  const response = await app.request('/api/tutor/status');
  expect(await response.json()).toEqual({ tutorEnabled: false });
  expect(response.headers.get('server-timing')).toMatch(/^api;dur=\d+(?:\.\d+)?$/);
  expect(statements).toHaveLength(1); // The request's learner lookup only.
});

test('study map reads shared progress once for multiple courses', async () => {
  const content = await loadContent();
  await db
    .update(schema.users)
    .set({ studySetInitializedAt: new Date() })
    .where(eq(schema.users.id, userId));
  await db
    .insert(schema.courseEnrollments)
    .values(
      content.courses
        .slice(0, 2)
        .map((course) => ({ userId, courseId: course.id, startMethod: 'beginning' as const })),
    )
    .onConflictDoNothing();
  statements = [];
  const response = await app.request('/api/study-map');
  expect(response.status).toBe(200);
  expect((await response.json()).nodes.length).toBeGreaterThan(0);
  expect(statements.length).toBe(5);
  expect(statements.join('\n')).not.toMatch(/"review_cards"|"attempts"|"remediation_flags"/);
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

test('loading an intact lesson run does not take a write lock', async () => {
  const [run] = await db
    .insert(schema.lessonRuns)
    .values({ userId, conceptId: 'supervised-learning' })
    .returning();
  const [quiz] = await db
    .insert(schema.lessonQuizAttempts)
    .values({ runId: run.id, attemptNo: 1 })
    .returning();
  await db.insert(schema.lessonQuizItems).values({
    quizAttemptId: quiz.id,
    position: 1,
    knowledgePointId: 'sl-inputs-targets',
    exerciseId: 'sl-inputs-targets-basics',
  });
  statements = [];
  const response = await app.request('/api/lessons/supervised-learning/run');
  expect(response.status).toBe(200);
  expect((await response.json()).run.status).toBe('in_progress');
  expect(statements.join('\n')).not.toMatch(/for update/i);
  const quizReads = statements.filter((sql) => /"lesson_quiz_(attempts|items)"/.test(sql));
  expect(quizReads).toHaveLength(1);
  expect(quizReads[0]).toMatch(/from "lesson_quiz_attempts" left join "lesson_quiz_items"/);
  await db.delete(schema.lessonRuns).where(eq(schema.lessonRuns.userId, userId));
});

test('resuming Home uses the existing session instead of rebuilding the schedule', async () => {
  const initialization = await app.request('/api/course');
  expect(initialization.status).toBe(200);
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
  expect(statements.length).toBeLessThanOrEqual(12); // Membership and recent-learn data stay within baseline.
  expect(statements.join('\n')).not.toMatch(/"review_cards"|"attempts"|"remediation_flags"/);
});

test('planner facts read full exercise recency in one grouped query', async () => {
  const store = drizzleLearnerStore(db, { schedulerTimezone: 'UTC' });
  statements = [];
  await store.readSchedulerFacts(userId, { now: new Date('2026-01-01'), recallExerciseIds: [] });
  expect(statements).toHaveLength(12);
  const attemptReads = statements.filter((query) => query.includes('from "attempts"'));
  expect(attemptReads).toHaveLength(2);
  expect(attemptReads[0]).toMatch(/limit/);
  expect(attemptReads[1]).toMatch(/max\("created_at"\).*group by "attempts"\."exercise_id"/);
});
