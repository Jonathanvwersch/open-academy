import { and, eq } from 'drizzle-orm';
import { afterAll, beforeEach, expect, test } from 'vitest';
import { createDb } from '../src/server/db/client.js';
import {
  attempts,
  sessionActivities,
  studySessions,
  users,
  xpEvents,
} from '../src/server/db/schema.js';
import { env } from '../src/server/env.js';
import { updateActivityAndAdvance } from '../src/server/learning/activity-completion.js';

const db = createDb(env.TEST_DATABASE_URL);
const userId = '00000000-0000-4000-8000-000000000091';

beforeEach(async () => {
  await db.delete(users).where(eq(users.id, userId));
  await db.insert(users).values({
    id: userId,
    displayName: 'Activity XP learner',
    timezone: 'UTC',
    startDate: '2026-01-01',
  });
});

afterAll(async () => {
  await db.delete(users).where(eq(users.id, userId));
  await db.$client.end();
});

async function createActivity() {
  const [session] = await db
    .insert(studySessions)
    .values({ userId, plannedMinutes: 20, status: 'active', startedAt: new Date('2026-01-01') })
    .returning();
  if (!session) throw new Error('Could not create activity XP session');
  const [activity] = await db
    .insert(sessionActivities)
    .values({
      sessionId: session.id,
      idx: 0,
      kind: 'practice',
      conceptId: 'vectors',
      exerciseIds: ['vectors-magnitude'],
      plannedMinutes: 20,
      status: 'in_progress',
    })
    .returning();
  if (!activity) throw new Error('Could not create activity XP activity');
  return activity;
}

test('awards mean correctness XP once when an activity is completed repeatedly', async () => {
  const activity = await createActivity();
  await db.insert(attempts).values([
    {
      userId,
      sessionId: activity.sessionId,
      activityId: activity.id,
      exerciseId: 'vectors-magnitude',
      exerciseVersion: '1',
      conceptId: 'vectors',
      dimension: 'math',
      mode: 'practice',
      answer: 0,
      correct: 0.5,
      credit: 0.5,
      attemptNo: 1,
      gradedBy: 'deterministic',
    },
    {
      userId,
      sessionId: activity.sessionId,
      activityId: activity.id,
      exerciseId: 'vectors-magnitude',
      exerciseVersion: '1',
      conceptId: 'vectors',
      dimension: 'math',
      mode: 'practice',
      answer: 5,
      correct: 1,
      credit: 1,
      attemptNo: 2,
      gradedBy: 'deterministic',
    },
  ]);

  const completion = {
    activityId: activity.id,
    completed: true,
    now: new Date('2026-11-09T00:17:00.000Z'),
    userId,
    timeZone: 'America/Los_Angeles',
  };
  await updateActivityAndAdvance(db, completion);
  await updateActivityAndAdvance(db, completion);

  const events = await db
    .select()
    .from(xpEvents)
    .where(and(eq(xpEvents.userId, userId), eq(xpEvents.sourceKey, `activity:${activity.id}`)));
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    kind: 'activity',
    conceptId: 'vectors',
    amount: 15,
    localDate: '2026-11-08',
  });
});

test('skips XP for activities with no attempts and for knowledge-point lessons', async () => {
  const activity = await createActivity();
  await updateActivityAndAdvance(db, {
    activityId: activity.id,
    completed: true,
    now: new Date('2026-01-02T12:00:00.000Z'),
    userId,
    timeZone: 'UTC',
  });
  const lessonActivity = await createActivity();
  await updateActivityAndAdvance(db, {
    activityId: lessonActivity.id,
    completed: true,
    now: new Date('2026-01-02T12:00:00.000Z'),
    userId,
    timeZone: 'UTC',
    knowledgePointActivity: true,
  });
  expect(await db.select().from(xpEvents).where(eq(xpEvents.userId, userId))).toHaveLength(0);
});

test('does not award activity XP for completed lab activities', async () => {
  const activity = await createActivity();
  await db
    .update(sessionActivities)
    .set({ kind: 'lab', projectId: 'linreg-numpy' })
    .where(eq(sessionActivities.id, activity.id));
  await db.insert(attempts).values({
    userId,
    sessionId: activity.sessionId,
    activityId: activity.id,
    exerciseId: 'vectors-magnitude',
    exerciseVersion: '1',
    conceptId: 'vectors',
    dimension: 'math',
    mode: 'practice',
    answer: 5,
    correct: 1,
    credit: 1,
    attemptNo: 1,
    gradedBy: 'deterministic',
  });

  await updateActivityAndAdvance(db, {
    activityId: activity.id,
    completed: true,
    now: new Date('2026-01-02T12:00:00.000Z'),
    userId,
    timeZone: 'UTC',
  });

  expect(await db.select().from(xpEvents).where(eq(xpEvents.userId, userId))).toHaveLength(0);
});

test('advancing an abandoned session activity does not reactivate its parent session', async () => {
  const activity = await createActivity();
  const [nextActivity] = await db
    .insert(sessionActivities)
    .values({
      sessionId: activity.sessionId,
      idx: 1,
      kind: 'practice',
      conceptId: 'vectors',
      exerciseIds: ['vectors-component-sum'],
      plannedMinutes: 5,
      status: 'planned',
    })
    .returning();
  if (!nextActivity) throw new Error('Could not create the next activity');
  await db
    .update(studySessions)
    .set({ status: 'abandoned' })
    .where(eq(studySessions.id, activity.sessionId));

  await updateActivityAndAdvance(db, {
    activityId: activity.id,
    completed: true,
    now: new Date('2026-01-02T12:00:00.000Z'),
    session: {
      activities: [
        { id: activity.id, idx: 0, status: 'in_progress' },
        { id: nextActivity.id, idx: 1, status: 'planned' },
      ],
    },
  });

  const [parent] = await db
    .select()
    .from(studySessions)
    .where(eq(studySessions.id, activity.sessionId));
  const [advanced] = await db
    .select()
    .from(sessionActivities)
    .where(eq(sessionActivities.id, nextActivity.id));
  expect(parent?.status).toBe('abandoned');
  expect(advanced?.status).toBe('in_progress');
});
