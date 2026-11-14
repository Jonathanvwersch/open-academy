import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { createApp } from '../../src/app.js';
import { env } from '../../src/config.js';
import { loadContent } from '../../src/content/load.js';
import type { ContentIndex } from '../../src/content/types.js';
import { createDb } from '../../src/db/client.js';
import {
  attempts,
  lessonRuns,
  mastery,
  remediationFlags,
  reviewCards,
  sessionActivities,
  studySessions,
  users,
} from '../../src/db/schema.js';
import { newReviewCard } from '../../src/learning/fsrs.js';

const db = createDb(env.TEST_DATABASE_URL);
const userId = '00000000-0000-4000-8000-000000000096';
const now = new Date('2026-01-07T12:00:00.000Z');
const missingCourseId = 'retired-course';
const missingConceptId = 'retired-concept';
const missingExerciseId = 'retired-exercise';
const missingPrerequisiteId = 'retired-prerequisite';
let app: ReturnType<typeof createApp>;
let content: ContentIndex;
let staleSessionId: string;

beforeAll(async () => {
  content = await loadContent();
  app = createApp({ db, content, tutorProvider: null });
});

beforeEach(async () => {
  await db.delete(users);
  await db.insert(users).values({
    id: userId,
    displayName: 'Pack switching learner',
    timezone: 'UTC',
    startDate: '2026-01-01',
    prefs: { dailyMinutes: { monday: 77 } },
    activeCourseId: missingCourseId,
  });

  await db.insert(mastery).values({
    userId,
    conceptId: missingConceptId,
    dimension: 'conceptual',
    state: 'retained',
    evidence: {},
  });
  await db.insert(reviewCards).values({
    userId,
    conceptId: missingConceptId,
    dimension: 'conceptual',
    fsrs: newReviewCard(now),
    dueAt: new Date('2026-01-06T12:00:00.000Z'),
  });
  await db.insert(lessonRuns).values({
    userId,
    conceptId: missingConceptId,
    status: 'in_progress',
  });
  await db.insert(remediationFlags).values({
    userId,
    conceptId: missingConceptId,
    targetPrereqId: missingPrerequisiteId,
  });
  await db.insert(attempts).values([
    {
      userId,
      exerciseId: missingExerciseId,
      exerciseVersion: 'retired-version',
      conceptId: missingConceptId,
      dimension: 'conceptual',
      mode: 'practice',
      answer: { text: 'old answer' },
      correct: 0,
      credit: 0,
      gradedBy: 'test',
      feedback: {},
      createdAt: new Date('2026-01-06T12:00:00.000Z'),
    },
    {
      userId,
      exerciseId: 'ptb-tensors-basics',
      exerciseVersion: 'current-version',
      conceptId: 'pytorch-basics',
      dimension: 'conceptual',
      mode: 'practice',
      answer: { text: 'an answer' },
      correct: 1,
      credit: 1,
      gradedBy: 'test',
      feedback: {},
      createdAt: new Date('2026-01-07T11:00:00.000Z'),
    },
  ]);
  const [session] = await db
    .insert(studySessions)
    .values({
      userId,
      kind: 'weekday',
      plannedMinutes: 30,
      startedAt: new Date('2026-01-07T11:30:00.000Z'),
      status: 'active',
      plan: {
        courseId: missingCourseId,
        activities: [{ conceptId: missingConceptId, exerciseIds: [missingExerciseId] }],
      },
    })
    .returning();
  if (!session) throw new Error('Could not create the stale session');
  staleSessionId = session.id;
  await db.insert(sessionActivities).values({
    sessionId: session.id,
    idx: 0,
    kind: 'learn',
    conceptId: missingConceptId,
    exerciseIds: [missingExerciseId],
    plannedMinutes: 30,
    status: 'in_progress',
    reason: {},
  });
});

afterAll(async () => {
  await db.delete(users).where(eq(users.id, userId));
  await db.$client.end();
});

test('learner endpoints ignore progress from concepts and courses absent from loaded content', async () => {
  const headers = { 'X-Now': now.toISOString() };
  const endpoints = [
    ['/api/today', await app.request('/api/today', { headers })],
    ['/api/course', await app.request('/api/course', { headers })],
    ['/api/learn', await app.request('/api/learn', { headers })],
    ['/api/reviews', await app.request('/api/reviews', { headers })],
    ['/api/progress', await app.request('/api/progress', { headers })],
    [
      '/api/sessions',
      await app.request('/api/sessions', {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'weekday', budgetMinutes: 60 }),
      }),
    ],
    ['/api/settings', await app.request('/api/settings', { headers })],
  ] as const;

  const failures: string[] = [];
  const responseBodies = new Map<string, string>();
  for (const [path, response] of endpoints) {
    if (response.status !== (path === '/api/sessions' ? 201 : 200)) {
      failures.push(`${path} returned ${response.status}`);
    }
    const body = await response.text();
    responseBodies.set(path, body);
    for (const missingId of [
      missingConceptId,
      missingCourseId,
      missingExerciseId,
      missingPrerequisiteId,
    ]) {
      if (body.includes(missingId)) failures.push(`${path} included ${missingId}`);
    }
  }
  expect(failures).toEqual([]);
  const today = JSON.parse(responseBodies.get('/api/today') ?? '{}');
  expect(today.needsCourseChoice).toBe(true);
  expect(today.activeSessionId).toBeNull();
  const learn = JSON.parse(responseBodies.get('/api/learn') ?? '{}');
  expect(learn.today.needsCourseChoice).toBe(true);
  expect(learn.activeSessionId).toBeNull();

  const sessions = await db.select().from(studySessions).where(eq(studySessions.userId, userId));
  expect(await db.select().from(mastery).where(eq(mastery.userId, userId))).toHaveLength(1);
  expect(await db.select().from(reviewCards).where(eq(reviewCards.userId, userId))).toHaveLength(1);
  expect(await db.select().from(lessonRuns).where(eq(lessonRuns.userId, userId))).toHaveLength(1);
  expect(await db.select().from(attempts).where(eq(attempts.userId, userId))).toHaveLength(2);
  expect(
    await db.select().from(remediationFlags).where(eq(remediationFlags.userId, userId)),
  ).toHaveLength(1);
  expect(sessions.some((session) => session.id === staleSessionId)).toBe(true);
  expect(
    await db
      .select()
      .from(sessionActivities)
      .where(eq(sessionActivities.conceptId, missingConceptId)),
  ).toHaveLength(1);
  expect(await db.select().from(users).where(eq(users.id, userId))).toMatchObject([
    { activeCourseId: missingCourseId },
  ]);
  expect(JSON.parse(responseBodies.get('/api/settings') ?? '{}').dailyMinutes.monday).toBe(77);
  expect(JSON.parse(responseBodies.get('/api/progress') ?? '{}').evidence).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        exerciseId: 'ptb-tensors-basics',
        conceptId: 'pytorch-basics',
      }),
    ]),
  );
});
