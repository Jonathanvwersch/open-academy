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
  projectProgress,
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

test('lesson response includes ordered authored prerequisites', async () => {
  const response = await get('/lessons/gradient-descent');
  expect(response.status).toBe(200);
  expect((await response.json()).prerequisites).toEqual([
    { id: 'gradients', title: 'Gradient vectors' },
    { id: 'loss-functions', title: 'Loss functions (MSE, MAE)' },
    { id: 'linear-regression', title: 'Linear regression' },
  ]);
});

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
    estimatedFinishAtGoal: expect.any(String),
  });

  const courseResponse = await get('/course');
  expect(courseResponse.status).toBe(200);
  const course: {
    weeks: Array<{
      intro: string;
      project: {
        id: string;
        title: string;
        available: boolean;
        status: 'not_started' | 'in_progress' | 'completed';
      } | null;
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
    project: {
      id: 'linreg-numpy',
      title: expect.any(String),
      available: true,
      status: 'not_started',
    },
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

test('lesson choices exclude locked, completed and stub concepts and retain the recommended lesson past five', async () => {
  const outlineIds = Array.from(
    new Set(
      (content.curriculum?.weeks ?? [])
        .slice()
        .sort((left, right) => left.week - right.week)
        .flatMap((week) => week.concepts),
    ),
  );
  const initial = await (await get('/learn')).json();
  expect(initial.choices.map((choice: { conceptId: string }) => choice.conceptId)).not.toContain(
    'dot-product',
  );
  const stubConceptId = outlineIds.find(
    (conceptId) => content.conceptsById.get(conceptId)?.status === 'stub',
  );
  if (!stubConceptId) throw new Error('Expected a stub concept in the course outline');
  expect(initial.choices.map((choice: { conceptId: string }) => choice.conceptId)).not.toContain(
    stubConceptId,
  );

  const targets: typeof content.concepts = [];
  for (const conceptId of outlineIds) {
    const concept = content.conceptsById.get(conceptId);
    const lesson = content.lessonsByConcept.get(conceptId);
    if (
      concept?.status !== 'authored' ||
      !lesson?.knowledge_points?.length ||
      concept.prereqs.some((prerequisite) =>
        targets.some((target) => target.id === prerequisite.id),
      ) ||
      targets.some((target) => target.prereqs.some((prerequisite) => prerequisite.id === conceptId))
    ) {
      continue;
    }
    targets.push(concept);
    if (targets.length === 6) break;
  }
  if (targets.length !== 6) throw new Error('Expected six independent authored lessons');
  const targetIds = new Set(targets.map((concept) => concept.id));
  await db
    .update(users)
    .set({ prefs: { scheduleMinutes: 600 } })
    .where(eq(users.id, userId));
  await db.insert(lessonRuns).values(
    content.concepts
      .filter((concept) => !targetIds.has(concept.id))
      .map((concept) => ({
        userId,
        conceptId: concept.id,
        status: 'completed' as const,
        completedAt: new Date('2026-01-07T11:00:00.000Z'),
      })),
  );
  const recommendedConcept = targets[5];
  if (!recommendedConcept) throw new Error('Expected a sixth lesson target');
  await db.insert(lessonRuns).values({
    userId,
    conceptId: recommendedConcept.id,
    status: 'in_progress',
  });

  const learn = await (await get('/learn')).json();
  const recommendedConceptId = learn.tasks.find(
    (task: { activityKind: string; conceptId?: string }) => task.activityKind === 'learn',
  )?.conceptId;
  expect(recommendedConceptId).toBe(recommendedConcept.id);
  expect(learn.choices.map((choice: { conceptId: string }) => choice.conceptId)).toEqual([
    ...targets.slice(0, 5).map((concept) => concept.id),
    recommendedConcept.id,
  ]);
  expect(learn.choices).toHaveLength(6);
  expect(learn.choices[5]).toMatchObject({
    conceptId: recommendedConcept.id,
    recommended: true,
  });
  expect(
    learn.choices.slice(0, 5).every((choice: { recommended: boolean }) => !choice.recommended),
  ).toBe(true);
  expect(learn.choices.map((choice: { conceptId: string }) => choice.conceptId)).not.toContain(
    'dot-product',
  );
  expect(learn.choices[0]?.xp).toBe(
    (content.lessonsByConcept.get(targets[0]?.id ?? '')?.knowledge_points?.length ?? 0) * 10,
  );
});

test('lesson choices are empty while a session is active', async () => {
  const started = await app.request('/api/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Now': '2026-01-07T12:00:00.000Z' },
    body: JSON.stringify({ budgetMinutes: 60 }),
  });
  expect(started.status).toBe(201);
  const response = await get('/learn');
  expect((await response.json()).choices).toEqual([]);
});

test('a focused session replaces the default new lesson and rejects locked concepts', async () => {
  const learnResponse = await get('/learn');
  const learn = await learnResponse.json();
  const focusedChoice = learn.choices.find(
    (choice: { recommended: boolean }) => !choice.recommended,
  );
  if (!focusedChoice) throw new Error('Expected a non-recommended lesson choice');
  const response = await app.request('/api/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Now': '2026-01-07T12:00:00.000Z' },
    body: JSON.stringify({ budgetMinutes: 60, focusConceptId: focusedChoice.conceptId }),
  });
  expect(response.status).toBe(201);
  const session = await response.json();
  const learnActivities = session.activities.filter(
    (activity: { kind: string }) => activity.kind === 'learn',
  );
  expect(learnActivities.map((activity: { conceptId: string }) => activity.conceptId)).toEqual([
    focusedChoice.conceptId,
  ]);
  const recommendedConceptId = learn.tasks.find(
    (task: { activityKind: string; conceptId?: string }) => task.activityKind === 'learn',
  )?.conceptId;
  expect(
    learnActivities.map((activity: { conceptId: string }) => activity.conceptId),
  ).not.toContain(recommendedConceptId);

  const locked = await app.request('/api/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Now': '2026-01-07T12:00:00.000Z' },
    body: JSON.stringify({ focusConceptId: 'dot-product' }),
  });
  expect(locked.status).toBe(409);
  expect(await locked.json()).toEqual({ error: 'Finish Vectors and vector operations first' });
});

test('Course project status reflects the learner project-progress row', async () => {
  await db.insert(projectProgress).values({
    userId,
    projectId: 'linreg-numpy',
    status: 'in_progress',
  });

  const response = await get('/course');
  expect(response.status).toBe(200);
  const course = await response.json();
  expect(course.weeks[0].project).toMatchObject({
    id: 'linreg-numpy',
    available: true,
    status: 'in_progress',
  });
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

test('learn XP goal follows the learner daily study time', async () => {
  await db
    .update(users)
    .set({ prefs: { scheduleMinutes: 30, saturdayMinutes: 45, sundayMinutes: 75 } })
    .where(eq(users.id, userId));
  const response = await get('/learn');
  expect(response.status).toBe(200);
  const learn = await response.json();
  expect(learn.xp.goal).toBe(30);
  expect(learn.xp.week.map((day: { goal: number }) => day.goal)).toEqual([
    30, 30, 30, 30, 30, 45, 75,
  ]);
});

test('session XP counts events during the session and all events from the local day', async () => {
  const [session] = await db
    .insert(studySessions)
    .values({
      userId,
      kind: 'weekday',
      plannedMinutes: 60,
      status: 'completed',
      startedAt: new Date('2026-01-07T10:00:00.000Z'),
      endedAt: new Date('2026-01-07T11:00:00.000Z'),
    })
    .returning();
  if (!session) throw new Error('Could not create XP session');
  await db.insert(xpEvents).values([
    {
      userId,
      kind: 'activity',
      sourceKey: 'xp-session-before',
      amount: 20,
      earnedAt: new Date('2026-01-07T09:59:00.000Z'),
      localDate: '2026-01-07',
    },
    {
      userId,
      kind: 'activity',
      sourceKey: 'xp-session-inside',
      amount: 15,
      earnedAt: new Date('2026-01-07T10:30:00.000Z'),
      localDate: '2026-01-07',
    },
    {
      userId,
      kind: 'activity',
      sourceKey: 'xp-session-after',
      amount: 50,
      earnedAt: new Date('2026-01-07T11:01:00.000Z'),
      localDate: '2026-01-07',
    },
    {
      userId,
      kind: 'activity',
      sourceKey: 'xp-today-only',
      amount: 10,
      earnedAt: new Date('2026-01-07T12:00:00.000Z'),
      localDate: '2026-01-07',
    },
  ]);
  const response = await get(`/sessions/${session.id}`);
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.xp).toEqual({ session: 15, today: 95, goal: 60 });
});

test('request timezone updates the learner, rebuckets XP, and drives the local week', async () => {
  const earnedAt = new Date('2026-11-09T00:17:00.000Z');
  await db.insert(xpEvents).values({
    userId,
    kind: 'activity',
    sourceKey: 'timezone-rebucket',
    conceptId: 'vectors',
    amount: 10,
    earnedAt,
    localDate: '2026-11-09',
  });
  const headers = {
    'X-Now': earnedAt.toISOString(),
    'X-Time-Zone': 'America/Los_Angeles',
  };

  const learnResponse = await app.request('/api/learn', { headers });
  expect(learnResponse.status).toBe(200);
  const learn = await learnResponse.json();
  expect(learn.xp.today).toBe(10);
  expect(learn.xp.week).toContainEqual({ date: '2026-11-08', xp: 10, goal: 60 });

  const [user] = await db.select().from(users).where(eq(users.id, userId));
  const [event] = await db.select().from(xpEvents).where(eq(xpEvents.userId, userId));
  expect(user?.timezone).toBe('America/Los_Angeles');
  expect(event?.localDate).toBe('2026-11-08');
  const todayResponse = await app.request('/api/today', { headers });
  expect((await todayResponse.json()).sessionKind).toBe('sunday');
});

test('invalid timezone is ignored and a missing header uses the stored timezone', async () => {
  const invalid = await app.request('/api/learn', {
    headers: { 'X-Now': '2026-11-09T00:17:00.000Z', 'X-Time-Zone': 'Not/AZone' },
  });
  expect(invalid.status).toBe(200);
  expect((await db.select().from(users).where(eq(users.id, userId)))[0]?.timezone).toBe('UTC');

  await db.update(users).set({ timezone: 'America/Los_Angeles' }).where(eq(users.id, userId));
  const missing = await app.request('/api/today', {
    headers: { 'X-Now': '2026-11-09T00:17:00.000Z' },
  });
  expect((await missing.json()).sessionKind).toBe('sunday');
});
