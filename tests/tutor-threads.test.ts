import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { createApp } from '../src/server/app.js';
import { loadContent } from '../src/server/content/load.js';
import type { ContentIndex } from '../src/server/content/types.js';
import { createDb } from '../src/server/db/client.js';
import {
  attempts,
  lessonProblems,
  lessonRuns,
  llmCalls,
  sessionActivities,
  studySessions,
  tutorMessages,
  tutorThreads,
  users,
} from '../src/server/db/schema.js';
import { env } from '../src/server/env.js';
import type { TutorProvider, TutorResult } from '../src/server/tutor/provider.js';
import type { ExplanationContext, TutorContext, TutorReply } from '../src/server/tutor/schemas.js';

const db = createDb(env.TEST_DATABASE_URL);
const userId = '00000000-0000-4000-8000-000000000093';
const headers = { 'content-type': 'application/json', 'X-Now': '2026-01-04T12:00:00.000Z' };
let content: ContentIndex;
let captured: TutorContext[] = [];
let failing = false;

const provider: TutorProvider = {
  model: 'thread-test',
  async respond(ctx): Promise<TutorResult<TutorReply>> {
    captured.push(ctx);
    if (failing) throw new Error('provider offline');
    return {
      value: {
        message_md: `Tutor reply to: ${ctx.question}`,
        misconception: null,
        suggests_review_of: [],
      },
      usage: null,
    };
  },
  async gradeExplanation(_ctx: ExplanationContext) {
    return { value: { criteria: [], feedback_md: '' }, usage: null };
  },
};
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  content = await loadContent('content');
  app = createApp({ db, content, tutorProvider: provider });
});
beforeEach(async () => {
  captured = [];
  failing = false;
  await db.delete(users);
  await db.insert(users).values({
    id: userId,
    displayName: 'Thread test learner',
    timezone: 'Europe/London',
    startDate: '2026-01-01',
  });
});
afterAll(async () => {
  await db.delete(users).where(eq(users.id, userId));
  await db.$client.end();
});

async function send(question: string, threadId?: string, extra: Record<string, unknown> = {}) {
  return app.request(threadId ? `/api/tutor/threads/${threadId}/messages` : '/api/tutor/threads', {
    method: 'POST',
    headers,
    body: JSON.stringify({ question, ...extra }),
  });
}

test('create-on-first-send persists messages and list/detail preserve newest-first and chronological ordering', async () => {
  const first = await send('first', undefined, { conceptId: 'supervised-learning' });
  expect(first.status).toBe(200);
  const firstPayload = await first.json();
  expect(firstPayload.messages).toHaveLength(2);
  const second = await send('second', firstPayload.thread.id);
  expect(second.status).toBe(200);
  const third = await send('third', firstPayload.thread.id);
  expect(third.status).toBe(200);
  expect(captured.at(-1)?.history.map((message) => message.content)).toEqual([
    'first',
    'Tutor reply to: first',
    'second',
    'Tutor reply to: second',
  ]);
  const listed = await (await app.request('/api/tutor/threads', { headers })).json();
  expect(listed).toHaveLength(1);
  expect(listed[0]).toMatchObject({
    conceptId: 'supervised-learning',
    conceptTitle: 'Supervised learning setup',
    messageCount: 6,
    lastMessagePreview: 'first',
  });
  const detail = await (
    await app.request(`/api/tutor/threads/${firstPayload.thread.id}`, { headers })
  ).json();
  expect(detail.messages.map((message: { role: string }) => message.role)).toEqual([
    'user',
    'assistant',
    'user',
    'assistant',
    'user',
    'assistant',
  ]);
  expect(detail.messages.map((message: { content: string }) => message.content)).toEqual([
    'first',
    'Tutor reply to: first',
    'second',
    'Tutor reply to: second',
    'third',
    'Tutor reply to: third',
  ]);
  expect(detail.thread.title).toBe('Supervised learning setup · 4 Jan');
  const general = await (await send('general question')).json();
  const newestFirst = await (await app.request('/api/tutor/threads', { headers })).json();
  expect(newestFirst).toHaveLength(2);
  expect(newestFirst[0]).toMatchObject({
    id: general.thread.id,
    conceptId: null,
    title: 'General · 4 Jan',
  });
});

test('history is oldest-first and capped at the latest twelve messages', async () => {
  const initial = await send('question 1');
  const { thread } = await initial.json();
  for (let index = 2; index <= 8; index += 1) {
    const response = await send(`question ${index}`, thread.id);
    expect(response.status).toBe(200);
  }
  expect(captured.at(-1)?.history).toHaveLength(12);
  expect(captured.at(-1)?.history.map((message) => message.content)).toEqual(
    Array.from({ length: 6 }, (_, index) => [
      `question ${index + 2}`,
      `Tutor reply to: question ${index + 2}`,
    ]).flat(),
  );
});

test('unanswered and answered lesson problems pass the right solution privacy context', async () => {
  const start = await app.request('/api/lessons/supervised-learning/run', {
    method: 'POST',
    headers,
    body: JSON.stringify({}),
  });
  const run = (await start.json()).run;
  const pending = run.pending.id;
  expect((await send('help', undefined, { lessonProblemId: pending })).status).toBe(200);
  expect(captured.at(-1)).toMatchObject({
    solution: '',
    authoredHints: expect.any(Array),
    problem_status: 'unanswered',
  });
  await db
    .update(lessonProblems)
    .set({ answeredAt: new Date(headers['X-Now']) })
    .where(eq(lessonProblems.id, pending));
  expect((await send('explain', undefined, { lessonProblemId: pending })).status).toBe(200);
  expect(captured.at(-1)?.problem_status).toBe('answered');
  expect(captured.at(-1)?.solution).not.toBe('');
});

test('lesson problems owned by another learner are not available to the tutor', async () => {
  const start = await app.request('/api/lessons/supervised-learning/run', {
    method: 'POST',
    headers,
    body: JSON.stringify({}),
  });
  const run = (await start.json()).run;
  const secondUserId = '00000000-0000-4000-8000-000000000095';
  await db.insert(users).values({
    id: secondUserId,
    displayName: 'Other lesson learner',
    timezone: 'UTC',
    startDate: '2026-01-01',
  });
  const [authenticatedUser] = await db.select().from(users).limit(1);
  if (!authenticatedUser) throw new Error('Expected an authenticated learner');
  const otherUserId = authenticatedUser.id === userId ? secondUserId : userId;
  await db.update(lessonRuns).set({ userId: otherUserId }).where(eq(lessonRuns.id, run.id));
  expect((await send('help', undefined, { lessonProblemId: run.pending.id })).status).toBe(404);
  await db.delete(users).where(eq(users.id, secondUserId));
});

test('legacy exercise context is unanswered until an attempt exists for that activity', async () => {
  const exercise = content.exercisesById.get('sl-check-target');
  if (!exercise) throw new Error('Missing supervised-learning legacy exercise');
  const [session] = await db
    .insert(studySessions)
    .values({
      userId,
      plannedMinutes: 10,
      startedAt: new Date(headers['X-Now']),
      status: 'active',
    })
    .returning();
  if (!session) throw new Error('Expected a study session');
  const [activity] = await db
    .insert(sessionActivities)
    .values({
      sessionId: session.id,
      idx: 0,
      kind: 'practice',
      conceptId: exercise.concept,
      plannedMinutes: 5,
      status: 'in_progress',
    })
    .returning();
  if (!activity) throw new Error('Expected an activity');

  expect(
    (
      await send('help before answering', undefined, {
        exerciseId: exercise.id,
        activityId: activity.id,
      })
    ).status,
  ).toBe(200);
  expect(captured.at(-1)).toMatchObject({ solution: '', problem_status: 'unanswered' });

  await db.insert(attempts).values({
    userId,
    sessionId: session.id,
    activityId: activity.id,
    exerciseId: exercise.id,
    exerciseVersion: exercise.contentVersion,
    conceptId: exercise.concept,
    dimension: exercise.dimension,
    mode: 'practice',
    answer: 'a',
    correct: 0,
    credit: 0,
    gradedBy: 'deterministic',
  });
  expect(
    (
      await send('help after answering', undefined, {
        exerciseId: exercise.id,
        activityId: activity.id,
      })
    ).status,
  ).toBe(200);
  expect(captured.at(-1)?.problem_status).toBe('answered');
  expect(captured.at(-1)?.solution).toBe(exercise.solution);
});

test('explain tutor context accepts an omitted solution', async () => {
  const exercise = content.exercisesById.get('sl-explain-setup');
  if (exercise?.type !== 'explain' || exercise.solution) {
    throw new Error('Expected explain exercise without a separate solution');
  }
  const [session] = await db
    .insert(studySessions)
    .values({
      userId,
      plannedMinutes: 10,
      startedAt: new Date(headers['X-Now']),
      status: 'active',
    })
    .returning();
  if (!session) throw new Error('Expected a study session');
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
  if (!activity) throw new Error('Expected an activity');
  expect(
    (
      await send('help before answering', undefined, {
        exerciseId: exercise.id,
        activityId: activity.id,
      })
    ).status,
  ).toBe(200);
  expect(captured.at(-1)).toMatchObject({ solution: '', problem_status: 'unanswered' });
});

test('provider failure stores no thread or messages; another user cannot read a thread', async () => {
  const llmCallsBefore = await db.select().from(llmCalls);
  failing = true;
  expect((await send('fail')).status).toBe(503);
  expect(await db.select().from(tutorThreads)).toHaveLength(0);
  expect(await db.select().from(tutorMessages)).toHaveLength(0);
  expect(await db.select().from(llmCalls)).toHaveLength(llmCallsBefore.length);
  failing = false;
  const response = await send('private');
  const thread = (await response.json()).thread;
  const secondUserId = '00000000-0000-4000-8000-000000000094';
  await db.insert(users).values({
    id: secondUserId,
    displayName: 'Other learner',
    timezone: 'UTC',
    startDate: '2026-01-01',
  });
  await db.update(tutorThreads).set({ userId: secondUserId }).where(eq(tutorThreads.id, thread.id));
  expect((await app.request(`/api/tutor/threads/${thread.id}`, { headers })).status).toBe(404);
  await db.delete(users).where(eq(users.id, secondUserId));
});

test('diagnostic exercises and review activities are forbidden', async () => {
  const diagnostic = content.exercises.find((item) => item.role === 'diagnostic');
  const regular = content.exercisesById.get('sl-check-target');
  if (!diagnostic || !regular) throw new Error('Missing guard test exercises');
  const [session] = await db
    .insert(studySessions)
    .values({
      userId,
      plannedMinutes: 10,
      startedAt: new Date(headers['X-Now']),
      status: 'active',
    })
    .returning();
  if (!session) throw new Error('Expected a study session');
  const [reviewActivity, practiceActivity] = await db
    .insert(sessionActivities)
    .values([
      {
        sessionId: session.id,
        idx: 0,
        kind: 'review',
        conceptId: regular.concept,
        plannedMinutes: 5,
        status: 'in_progress',
      },
      {
        sessionId: session.id,
        idx: 1,
        kind: 'practice',
        conceptId: diagnostic.concept,
        plannedMinutes: 5,
        status: 'in_progress',
      },
    ])
    .returning();
  if (!reviewActivity || !practiceActivity) throw new Error('Expected guard test activities');
  expect(
    (
      await send('review help', undefined, {
        exerciseId: regular.id,
        activityId: reviewActivity.id,
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await send('diagnostic help', undefined, {
        exerciseId: diagnostic.id,
        activityId: practiceActivity.id,
      })
    ).status,
  ).toBe(403);
  const template = content.exercises.find(
    (exercise) => exercise.type === 'numeric' && 'params' in exercise,
  );
  if (!template) throw new Error('Missing template exercise');
  expect(
    (
      await send('template help', undefined, {
        exerciseId: template.id,
        activityId: reviewActivity.id,
      })
    ).status,
  ).toBe(403);
  const allowedActivity = practiceActivity;
  expect(
    (
      await send('template help', undefined, {
        exerciseId: template.id,
        activityId: allowedActivity.id,
      })
    ).status,
  ).toBe(400);
  const [count] = await db
    .select({ value: tutorMessages.id })
    .from(tutorMessages)
    .where(and(eq(tutorMessages.userId, userId), eq(tutorMessages.activityId, reviewActivity.id)));
  expect(count).toBeUndefined();
});
