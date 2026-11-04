import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createApp } from '../src/server/app.js';
import { loadContent } from '../src/server/content/load.js';
import type { ContentIndex } from '../src/server/content/types.js';
import { createDb } from '../src/server/db/client.js';
import { hintEvents, users } from '../src/server/db/schema.js';
import { env } from '../src/server/env.js';
import { FakeProvider } from '../src/server/tutor/provider.js';

const db = createDb(env.TEST_DATABASE_URL);
const userId = '00000000-0000-4000-8000-000000000001';
const now = '2026-01-01T12:00:00.000Z';
let app: ReturnType<typeof createApp>;
let noTutorApp: ReturnType<typeof createApp>;
let content: ContentIndex;

beforeAll(async () => {
  content = await loadContent('tests/fixtures/content');
  app = createApp({ db, content, tutorProvider: new FakeProvider() });
  noTutorApp = createApp({ db, content, tutorProvider: null });
  await db.delete(users);
  await db
    .insert(users)
    .values({
      id: userId,
      displayName: 'Test learner',
      timezone: 'UTC',
      startDate: '2026-01-01',
      prefs: { scheduleMinutes: 60 },
    })
    .onConflictDoUpdate({
      target: users.id,
      set: { displayName: 'Test learner', startDate: '2026-01-01', prefs: { scheduleMinutes: 60 } },
    });
});

afterAll(async () => {
  await db.delete(users).where(eq(users.id, userId));
  await db.$client.end();
});

test('attempts update mastery and create a review card used by Today', async () => {
  const headers = { 'content-type': 'application/json', 'X-Now': now };
  const sessionResponse = await app.request('/api/sessions', {
    method: 'POST',
    headers,
    body: JSON.stringify({ budgetMinutes: 60 }),
  });
  expect(sessionResponse.status).toBe(201);
  const session = await sessionResponse.json();
  const activity = session.activities.find((item: { kind: string }) => item.kind === 'learn');
  expect(activity).toBeDefined();
  const exerciseId = activity.exerciseIds[0] as string;

  const first = await app.request('/api/attempts', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      exerciseId,
      activityId: activity.id,
      answer: 0,
      mode: 'practice',
    }),
  });
  expect(first.status).toBe(200);
  expect((await first.json()).retryAllowed).toBe(true);

  const second = await app.request('/api/attempts', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      exerciseId,
      activityId: activity.id,
      answer: 5,
      mode: 'practice',
    }),
  });
  expect(second.status).toBe(200);
  const result = await second.json();
  expect(result.credit, `${exerciseId}: ${JSON.stringify(result)}`).toBeGreaterThanOrEqual(0.3);

  const today = await app.request('/api/today', {
    headers: { 'X-Now': '2026-01-15T12:00:00.000Z' },
  });
  expect(today.status).toBe(200);
  const payload = await today.json();
  expect(payload.plan.activities.some((item: { kind: string }) => item.kind === 'review')).toBe(
    true,
  );
});

test('unscoped hints lower credit and restart after the previous attempt', async () => {
  const exerciseId = 'linear-algebra-code-complete';
  const hint = await app.request('/api/hints', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Now': '2026-01-02T12:00:00.000Z' },
    body: JSON.stringify({ exerciseId }),
  });
  expect(hint.status).toBe(200);
  expect((await hint.json()).text).toContain('operation that sums pairwise products');

  const firstAttempt = await app.request('/api/attempts', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Now': '2026-01-02T12:01:00.000Z' },
    body: JSON.stringify({ exerciseId, answer: '@', mode: 'practice' }),
  });
  expect(firstAttempt.status).toBe(200);
  expect(await firstAttempt.json()).toMatchObject({ hintsUsed: 1, credit: 0.7 });

  const nextHint = await app.request('/api/hints', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Now': '2026-01-02T12:02:00.000Z' },
    body: JSON.stringify({ exerciseId }),
  });
  expect(nextHint.status).toBe(200);
  expect(await nextHint.json()).toMatchObject({ level: 1 });
});

test('tutor hints without authored hints reduce credit; explicit solution reveal is final', async () => {
  const fixture = await loadContent('tests/fixtures/content');
  const exercise = fixture.exercisesById.get('vectors-magnitude');
  if (exercise?.type !== 'numeric') throw new Error('Missing hint-free numeric item');
  const appExercise = content.exercisesById.get(exercise.id);
  if (appExercise?.type !== 'numeric') throw new Error('Missing app numeric item');
  content.exercisesById.set(exercise.id, { ...appExercise, hints: [] });

  const unavailable = await app.request('/api/hints', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Now': '2026-01-03T12:00:00.000Z' },
    body: JSON.stringify({ exerciseId: exercise.id }),
  });
  expect(await unavailable.json()).toMatchObject({ level: 1 });

  const unassisted = await app.request('/api/attempts', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Now': '2026-01-03T12:01:00.000Z' },
    body: JSON.stringify({ exerciseId: exercise.id, answer: exercise.answer, mode: 'practice' }),
  });
  expect(await unassisted.json()).toMatchObject({ hintsUsed: 1, credit: 0.7 });

  const solution = await app.request('/api/hints', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Now': '2026-01-04T12:00:00.000Z' },
    body: JSON.stringify({ exerciseId: exercise.id, revealSolution: true }),
  });
  expect(await solution.json()).toMatchObject({ level: 5, revealedSolution: true });
  const assisted = await app.request('/api/attempts', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Now': '2026-01-04T12:01:00.000Z' },
    body: JSON.stringify({ exerciseId: exercise.id, answer: exercise.answer, mode: 'practice' }),
  });
  expect(await assisted.json()).toMatchObject({ hintsUsed: 5, credit: 0.1 });
});

test('null tutor keeps authored hints, disables chat, and reports tutor availability', async () => {
  await db.delete(hintEvents).where(eq(hintEvents.userId, userId));
  const today = await noTutorApp.request('/api/today');
  expect(await today.json()).toMatchObject({ tutorEnabled: false });

  const exercise = content.exercisesById.get('linear-algebra-code-complete');
  if (!exercise) throw new Error('Missing authored-hint exercise');
  const hint = await noTutorApp.request('/api/hints', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Now': '2026-02-01T12:00:00.000Z' },
    body: JSON.stringify({ exerciseId: exercise.id }),
  });
  const hintBody = await hint.json();
  expect(hintBody).toMatchObject({
    level: 1,
    text: exercise.hints[0],
    hasMore: exercise.hints.length > 1,
  });

  const chat = await noTutorApp.request('/api/tutor/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  expect(chat.status).toBe(503);
});
