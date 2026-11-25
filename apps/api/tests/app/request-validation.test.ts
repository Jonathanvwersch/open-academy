import type { ContentIndex } from '@academy/aesop/course/types';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { createApp } from '../../src/app.js';
import { env } from '../../src/config.js';
import { loadContent } from '../../src/content/load.js';
import { createDb } from '../../src/db/client.js';
import {
  attempts,
  courseEnrollments,
  sessionActivities,
  studySessions,
  users,
} from '../../src/db/schema.js';

const db = createDb(env.TEST_DATABASE_URL);
const userId = '00000000-0000-4000-8000-000000000001';
const headers = { 'content-type': 'application/json', 'X-Now': '2026-01-01T12:00:00Z' };
let app: ReturnType<typeof createApp>;
let content: ContentIndex;

beforeAll(async () => {
  content = await loadContent('tests/fixtures/content');
  app = createApp({ db, content, tutorProvider: null });
});
beforeEach(async () => {
  await db.delete(users);
  await db.insert(users).values({
    id: userId,
    displayName: 'Validation test',
    timezone: 'UTC',
    startDate: '2026-01-01',
    activeCourseId: 'fixture-course',
    prefs: { scheduleMinutes: 60 },
  });
  await db
    .insert(courseEnrollments)
    .values({ userId, courseId: 'fixture-course', status: 'active', startMethod: 'beginning' });
});
afterAll(async () => {
  await db.delete(users).where(eq(users.id, userId));
  await db.$client.end();
});

test.each([
  '/api/sessions/invalid',
  '/api/placement/invalid/next',
  '/api/placement/invalid/results',
  '/api/tutor/threads/invalid',
  '/api/lessons/vectors/quiz/invalid/review',
])('unknown ids return a client error instead of a PostgreSQL failure: %s', async (path) => {
  expect((await app.request(path)).status).toBe(404);
});

test('unknown activity ids are rejected before recording an attempt', async () => {
  const response = await app.request('/api/attempts', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      exerciseId: 'vectors-magnitude',
      activityId: crypto.randomUUID(),
      answer: '5',
    }),
  });
  expect(response.status).toBe(404);
  expect(await db.select().from(attempts).where(eq(attempts.userId, userId))).toHaveLength(0);
});

test('settings reject impossible dates before changing learner preferences', async () => {
  for (const startDate of ['garbage', '2026-02-30']) {
    const response = await app.request('/api/settings', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ scheduleMinutes: 60, startDate }),
    });
    expect(response.status).toBe(400);
  }
});

test('replanning preserves sparse activity positions without unique-index failures', async () => {
  const [session] = await db
    .insert(studySessions)
    .values({
      userId,
      plannedMinutes: 60,
      startedAt: new Date(headers['X-Now']),
      status: 'active',
    })
    .returning();
  if (!session) throw new Error('Missing session');
  await db.insert(sessionActivities).values([
    { sessionId: session.id, idx: 0, kind: 'practice', plannedMinutes: 5, status: 'planned' },
    { sessionId: session.id, idx: 1, kind: 'practice', plannedMinutes: 5, status: 'in_progress' },
  ]);
  const response = await app.request(`/api/sessions/${session.id}/replan`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ remainingBudgetMinutes: 60 }),
  });
  expect(response.status).toBe(200);
  const result = await response.json();
  expect(result.activities.length).toBeGreaterThan(1);
  const positions = result.activities.map((activity: { idx: number }) => activity.idx);
  expect(new Set(positions).size).toBe(positions.length);
  expect(Math.min(...positions)).toBe(1);
});

test('invalid replan budgets do not replace the existing plan', async () => {
  const [session] = await db
    .insert(studySessions)
    .values({ userId, plannedMinutes: 60, status: 'active' })
    .returning();
  if (!session) throw new Error('Missing session');
  await db
    .insert(sessionActivities)
    .values({ sessionId: session.id, idx: 0, kind: 'practice', plannedMinutes: 5 });
  for (const remainingBudgetMinutes of [-1, 601, 'invalid']) {
    const response = await app.request(`/api/sessions/${session.id}/replan`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ remainingBudgetMinutes }),
    });
    expect(response.status).toBe(400);
  }
  expect(
    await db.select().from(sessionActivities).where(eq(sessionActivities.sessionId, session.id)),
  ).toHaveLength(1);
});

test('replanning cannot delete an activity after a successful progress write', async () => {
  const [
    { LearnerRepository },
    { postSessionsByIdReplan, postSessionsByIdActivitiesByAidProgress },
  ] = await Promise.all([
    import('../../src/db/repository.js'),
    import('../../src/features/sessions/service.js'),
  ]);
  const [session] = await db
    .insert(studySessions)
    .values({ userId, plannedMinutes: 60, status: 'active' })
    .returning();
  if (!session) throw new Error('Missing session');
  const [activity] = await db
    .insert(sessionActivities)
    .values({ sessionId: session.id, idx: 0, kind: 'practice', plannedMinutes: 5 })
    .returning();
  if (!activity) throw new Error('Missing activity');
  let snapshotRead: () => void = () => {};
  let release: () => void = () => {};
  const read = new Promise<void>((resolve) => {
    snapshotRead = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const request = {
    userId,
    timeZone: 'UTC',
    params: { id: session.id, aid: activity.id },
    query: {},
    body: {},
    repo: new LearnerRepository(db, userId),
    tutor: null,
    now: () => new Date(headers['X-Now']),
  };
  const replanning = postSessionsByIdReplan(
    {
      db,
      tutorProvider: null,
      content: async () => {
        snapshotRead();
        await blocked;
        return content;
      },
    },
    request,
  );
  await read;
  let finished = false;
  const progressing = postSessionsByIdActivitiesByAidProgress(
    { db, tutorProvider: null, content: async () => content },
    {
      ...request,
      body: { answerDraft: 'keep my work' },
    },
  ).finally(() => {
    finished = true;
  });
  try {
    const deadline = Date.now() + 5000;
    while (!finished) {
      const waiting = await db.$client<{ waiting: number }[]>`
        select count(*)::int as waiting from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'
        and query like '%study_sessions%'
      `;
      if ((waiting[0]?.waiting ?? 0) > 0) break;
      if (Date.now() > deadline)
        throw new Error('Progress neither completed nor waited for the session lock');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  } finally {
    release();
  }
  const [replanned, progressed] = await Promise.all([replanning, progressing]);
  expect(replanned.status).toBe(200);
  const [saved] = await db
    .select()
    .from(sessionActivities)
    .where(eq(sessionActivities.id, activity.id));
  if (progressed.status === 200) {
    expect(saved?.progress).toMatchObject({ answerDraft: 'keep my work' });
    expect(saved?.status).toBe('in_progress');
  } else {
    expect(progressed.status).toBe(404);
  }
});
