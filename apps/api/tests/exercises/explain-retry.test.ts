import type { ContentIndex } from '@open-academy/engine/course/types';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createApp } from '../../src/app.js';
import { env } from '../../src/config.js';
import { loadContent } from '../../src/content/load.js';
import { createDb } from '../../src/db/client.js';
import { attempts, sessionActivities, studySessions, users } from '../../src/db/schema.js';
import { FakeProvider } from '../../src/features/tutor/provider.js';

const db = createDb(env.TEST_DATABASE_URL);
const userId = '00000000-0000-4000-8000-000000000234';
const now = '2026-01-01T12:00:00.000Z';
let content: ContentIndex;
const userCreatedAt = new Date('1900-01-01T00:00:00.000Z');

beforeAll(async () => {
  content = await loadContent('tests/fixtures/content');
  await db
    .insert(users)
    .values({
      id: userId,
      displayName: 'Explain retry test learner',
      timezone: 'UTC',
      startDate: '2026-01-01',
      prefs: { scheduleMinutes: 60 },
      createdAt: userCreatedAt,
    })
    .onConflictDoUpdate({
      target: users.id,
      set: {
        displayName: 'Explain retry test learner',
        timezone: 'UTC',
        createdAt: userCreatedAt,
      },
    });
});

afterAll(async () => {
  await db.delete(users).where(eq(users.id, userId));
  await db.$client.end();
});

test('a zero-score practice explain retry withholds answers through response and reload', async () => {
  const sourceExercise = content.exercisesById.get('sl-explain-setup');
  if (sourceExercise?.type !== 'explain') throw new Error('Missing explain exercise fixture');
  const exercise = { ...sourceExercise, solution: 'The hidden solution for this exercise.' };
  const exercisesById = new Map(content.exercisesById).set(exercise.id, exercise);
  const exercisesByConcept = new Map(content.exercisesByConcept);
  exercisesByConcept.set(
    exercise.concept,
    (exercisesByConcept.get(exercise.concept) ?? []).map((candidate) =>
      candidate.id === exercise.id ? exercise : candidate,
    ),
  );
  const exercisesByDimension = new Map(content.exercisesByDimension);
  exercisesByDimension.set(
    exercise.dimension,
    (exercisesByDimension.get(exercise.dimension) ?? []).map((candidate) =>
      candidate.id === exercise.id ? exercise : candidate,
    ),
  );
  const testContent = { ...content, exercisesById, exercisesByConcept, exercisesByDimension };
  const app = createApp({
    db,
    content: testContent,
    tutorProvider: new FakeProvider(undefined, {
      criteria: exercise.rubric.map(({ id }) => ({
        id,
        judgement: 'missing' as const,
        evidence: null,
      })),
      feedback_md: 'Identify the relevant ideas in your answer.',
    }),
  });
  const headers = { 'content-type': 'application/json', 'X-Now': now };
  const [session] = await db
    .insert(studySessions)
    .values({ userId, plannedMinutes: 15, status: 'active', kind: 'weekday' })
    .returning();
  if (!session) throw new Error('Could not create a session fixture');
  const [activity] = await db
    .insert(sessionActivities)
    .values({
      sessionId: session.id,
      idx: 0,
      kind: 'practice',
      conceptId: exercise.concept,
      exerciseIds: [exercise.id],
      plannedMinutes: 5,
      status: 'in_progress',
    })
    .returning();
  if (!activity) throw new Error('Could not create an activity fixture');

  const firstResponse = await app.request('/api/attempts', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      exerciseId: exercise.id,
      activityId: activity.id,
      answer: { text: 'I am not sure.' },
      mode: 'practice',
    }),
  });
  expect(firstResponse.status).toBe(200);
  const firstBody = await firstResponse.json();
  expect(firstBody).toMatchObject({
    correct: 0,
    attemptNo: 1,
    retryAllowed: true,
  });
  expect(firstBody).not.toHaveProperty('exemplar');
  expect(firstBody).not.toHaveProperty('solution');
  expect(firstBody.feedback).toContain('Identify the relevant ideas');
  expect(firstBody.rubric).toHaveLength(exercise.rubric.length);

  const [storedAttempt] = await db
    .select()
    .from(attempts)
    .where(eq(attempts.id, firstBody.attemptId))
    .limit(1);
  if (!storedAttempt) throw new Error('Could not load the first explain attempt');
  const storedFeedback = storedAttempt.feedback as Record<string, unknown>;
  expect(storedFeedback).not.toHaveProperty('exemplar');
  expect(storedFeedback).not.toHaveProperty('solution');
  expect(storedFeedback.rubric).toEqual(firstBody.rubric);

  await db
    .update(attempts)
    .set({
      feedback: {
        ...storedFeedback,
        exemplar: exercise.exemplar,
        solution: 'A legacy stored solution that must stay hidden.',
      },
    })
    .where(eq(attempts.id, storedAttempt.id));
  const reloaded = await app.request(`/api/sessions/${session.id}`);
  expect(reloaded.status).toBe(200);
  const reloadedBody = await reloaded.json();
  expect(reloadedBody.activities[0].lastAttempt).toMatchObject({
    attemptNo: 1,
    retryAllowed: true,
    feedback: firstBody.feedback,
  });
  expect(reloadedBody.activities[0].lastAttempt).not.toHaveProperty('exemplar');
  expect(reloadedBody.activities[0].lastAttempt).not.toHaveProperty('solution');

  const secondResponse = await app.request('/api/attempts', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Now': '2026-01-01T12:01:00.000Z' },
    body: JSON.stringify({
      exerciseId: exercise.id,
      activityId: activity.id,
      answer: { text: 'I still do not know.' },
      mode: 'practice',
    }),
  });
  expect(secondResponse.status).toBe(200);
  const secondBody = await secondResponse.json();
  expect(secondBody).toMatchObject({
    correct: 0,
    attemptNo: 2,
    retryAllowed: false,
    exemplar: exercise.exemplar,
    solution: exercise.solution,
  });
});
