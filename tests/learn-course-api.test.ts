import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { createApp } from '../src/server/app.js';
import { loadContent } from '../src/server/content/load.js';
import type { ContentIndex } from '../src/server/content/types.js';
import { createDb } from '../src/server/db/client.js';
import {
  attempts,
  lessonProblems,
  lessonRuns,
  mastery,
  sessionActivities,
  studySessions,
  users,
  xpEvents,
} from '../src/server/db/schema.js';
import { env } from '../src/server/env.js';
import { prerequisiteMet } from '../src/server/learning/prerequisites.js';
import type { MasteryRecord } from '../src/server/learning/types.js';

const db = createDb(env.TEST_DATABASE_URL);
const userId = '00000000-0000-4000-8000-000000000092';
let app: ReturnType<typeof createApp>;
let content: ContentIndex;

beforeAll(async () => {
  content = await loadContent();
  app = createApp({ db, content, tutorProvider: null });
});

beforeEach(async () => {
  await db.delete(users);
  await db.insert(users).values({
    id: userId,
    displayName: 'Learn course API learner',
    timezone: 'UTC',
    startDate: '2026-01-01',
    prefs: { scheduleMinutes: 60 },
  });
});

afterAll(async () => {
  await db.delete(users).where(eq(users.id, userId));
  await db.$client.end();
});

async function rowCounts() {
  const sessions = await db.select().from(studySessions).where(eq(studySessions.userId, userId));
  const [activityRows, attemptRows, runRows, masteryRows, xpRows] = await Promise.all([
    sessions.length
      ? db
          .select()
          .from(sessionActivities)
          .where(eq(sessionActivities.sessionId, sessions[0]?.id ?? ''))
      : Promise.resolve([]),
    db.select().from(attempts).where(eq(attempts.userId, userId)),
    db.select().from(lessonRuns).where(eq(lessonRuns.userId, userId)),
    db.select().from(mastery).where(eq(mastery.userId, userId)),
    db.select().from(xpEvents).where(eq(xpEvents.userId, userId)),
  ]);
  const problems = runRows.length
    ? await db
        .select()
        .from(lessonProblems)
        .where(eq(lessonProblems.runId, runRows[0]?.id ?? ''))
    : [];
  return {
    sessions: sessions.length,
    activities: activityRows.length,
    attempts: attemptRows.length,
    runs: runRows.length,
    problems: problems.length,
    mastery: masteryRows.length,
    xp: xpRows.length,
  };
}

async function get(path: string) {
  return app.request(`/api${path}`, {
    headers: { 'X-Now': '2026-01-07T12:00:00.000Z' },
  });
}

test('planned Learn tasks and Course numbering are read-only', async () => {
  const before = await rowCounts();
  const learnResponse = await get('/learn');
  expect(learnResponse.status).toBe(200);
  const learn = await learnResponse.json();
  expect(learn.activeSessionId).toBeNull();
  expect(learn.tasks.length).toBeGreaterThan(0);
  expect(learn.tasks[0]).toMatchObject({
    label: expect.stringMatching(/^(Lesson|Review|Practice|Project|Quiz)$/),
    title: expect.any(String),
    xp: expect.any(Number),
    prerequisites: expect.any(Array),
  });
  expect(learn.course).toMatchObject({
    percentComplete: expect.any(Number),
    topicsDone: expect.any(Number),
    topicsTotal: expect.any(Number),
    estimatedFinish: expect.any(String),
  });

  const courseResponse = await get('/course');
  expect(courseResponse.status).toBe(200);
  const course: {
    weeks: Array<{
      intro: string;
      project: { id: string; title: string } | null;
      topics: Array<{
        number: string;
        conceptId: string;
        title: string;
        hasLesson: boolean;
        status: string;
        mastery: string;
        needs?: Array<{ id: string; title: string }>;
        buildsOn: Array<{ id: string; title: string }>;
        leadsTo: Array<{ id: string; title: string }>;
        leadsToMore: number;
      }>;
    }>;
  } = await courseResponse.json();
  expect(course.weeks[0].topics[0]).toMatchObject({
    number: '1.1',
    conceptId: 'what-is-ml',
    title: 'What machine learning is, and how this course fits together',
    status: expect.stringMatching(/^(locked|not_started|in_progress|complete)$/),
    mastery: 'Not started',
  });
  expect(course.weeks[0]).toMatchObject({
    intro:
      "You'll build the simplest model that learns: predicting a house's price from its measurements, trained on past sales. The maths topics are the tools this model needs, taught in the order it needs them.",
    project: { id: 'linreg-numpy', title: expect.any(String) },
  });
  expect(
    course.weeks[0].topics.find((topic) => topic.conceptId === 'supervised-learning'),
  ).toMatchObject({
    buildsOn: [
      {
        id: 'what-is-ml',
        title: 'What machine learning is, and how this course fits together',
      },
    ],
    leadsTo: expect.arrayContaining([expect.objectContaining({ id: 'linear-regression' })]),
    leadsToMore: expect.any(Number),
  });
  const dotProduct = course.weeks
    .flatMap((week) => week.topics)
    .find((topic) => topic.conceptId === 'dot-product');
  expect(dotProduct).toMatchObject({
    needs: [{ id: 'vectors', title: 'Vectors and vector operations' }],
  });
  const masteryByKey = new Map<string, Pick<MasteryRecord, 'state' | 'inferred'>>();
  const lessonRuns: Array<{
    conceptId: string;
    status: 'in_progress' | 'needs_retry' | 'completed';
  }> = [];
  for (const topic of course.weeks.flatMap((week) => week.topics)) {
    const concept = content.conceptsById.get(topic.conceptId);
    const locked = Boolean(
      concept?.prereqs.some(
        (prerequisite) =>
          prerequisite.strength === 'hard' &&
          !prerequisiteMet(prerequisite.id, masteryByKey, lessonRuns, content),
      ),
    );
    expect(topic.status === 'locked').toBe(locked);
  }
  expect(await rowCounts()).toEqual(before);
});

test('active-session tasks, done-today activity, and local-date KP XP are returned read-only', async () => {
  const [session] = await db
    .insert(studySessions)
    .values({
      userId,
      kind: 'weekday',
      plannedMinutes: 30,
      status: 'active',
      startedAt: new Date('2026-01-07T11:00:00.000Z'),
    })
    .returning();
  if (!session) throw new Error('Could not create Learn fixture session');
  const [completed, remaining] = await db
    .insert(sessionActivities)
    .values([
      {
        sessionId: session.id,
        idx: 0,
        kind: 'practice',
        conceptId: 'vectors',
        exerciseIds: ['vectors-magnitude'],
        plannedMinutes: 12,
        status: 'completed',
        completedAt: new Date('2026-01-07T11:30:00.000Z'),
      },
      {
        sessionId: session.id,
        idx: 1,
        kind: 'learn',
        conceptId: 'supervised-learning',
        plannedMinutes: 18,
        status: 'in_progress',
      },
    ])
    .returning();
  if (!completed || !remaining) throw new Error('Could not create Learn fixture activities');
  await db.insert(xpEvents).values([
    {
      userId,
      kind: 'knowledge_point',
      sourceKey: 'kp:fixture:point',
      conceptId: 'supervised-learning',
      amount: 10,
      earnedAt: new Date('2026-01-07T11:15:00.000Z'),
      localDate: '2026-01-07',
    },
    {
      userId,
      kind: 'activity',
      sourceKey: `activity:${completed.id}`,
      conceptId: 'vectors',
      amount: 12,
      earnedAt: new Date('2026-01-05T12:00:00.000Z'),
      localDate: '2026-01-05',
    },
  ]);
  const before = await rowCounts();

  const response = await get('/learn');
  expect(response.status).toBe(200);
  const learn = await response.json();
  expect(learn).toMatchObject({
    activeSessionId: session.id,
    xp: {
      total: 22,
      today: 10,
      goal: 60,
      week: expect.arrayContaining([
        { date: '2026-01-05', xp: 12, goal: 60 },
        { date: '2026-01-07', xp: 10, goal: 60 },
      ]),
    },
  });
  expect(learn.tasks).toHaveLength(1);
  expect(learn.tasks[0]).toMatchObject({
    activityKind: 'learn',
    label: 'Lesson',
    conceptId: 'supervised-learning',
    title: 'Supervised learning setup',
    xp: expect.any(Number),
  });
  expect(learn.doneToday).toEqual([
    {
      label: 'Practice',
      title: 'Vectors and vector operations',
      xp: 12,
      completedAt: '2026-01-07T11:30:00.000Z',
    },
  ]);
  expect(await rowCounts()).toEqual(before);
});
