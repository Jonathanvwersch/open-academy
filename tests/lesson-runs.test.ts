import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { createApp } from '../src/server/app.js';
import { loadContent } from '../src/server/content/load.js';
import { instantiateExercise, isTemplate } from '../src/server/content/templates.js';
import type { ContentIndex } from '../src/server/content/types.js';
import { createDb } from '../src/server/db/client.js';
import {
  attempts,
  lessonProblems,
  lessonRuns,
  sessionActivities,
  studySessions,
  users,
  xpEvents,
} from '../src/server/db/schema.js';
import { env } from '../src/server/env.js';
import { FakeProvider } from '../src/server/tutor/provider.js';

const db = createDb(env.TEST_DATABASE_URL);
const userId = '00000000-0000-4000-8000-000000000087';
const conceptId = 'supervised-learning';
const headers = { 'content-type': 'application/json', 'X-Now': '2026-01-01T12:00:00.000Z' };
let app: ReturnType<typeof createApp>;
let content: ContentIndex;

beforeAll(async () => {
  content = await loadContent('content');
  app = createApp({ db, content, tutorProvider: new FakeProvider() });
});

beforeEach(async () => {
  await db.delete(users);
  await db.insert(users).values({
    id: userId,
    displayName: 'Lesson runner test learner',
    timezone: 'Europe/London',
    startDate: '2026-01-01',
  });
});

afterAll(async () => {
  await db.delete(users).where(eq(users.id, userId));
  await db.$client.end();
});

async function startRun(activityId?: string) {
  return app.request(`/api/lessons/${conceptId}/run`, {
    method: 'POST',
    headers,
    body: JSON.stringify(activityId ? { activityId } : {}),
  });
}

async function getRun() {
  return app.request(`/api/lessons/${conceptId}/run`, { headers });
}

function concreteExercise(exerciseId: string, seed: number | null) {
  const exercise = content.exercisesById.get(exerciseId);
  if (!exercise) throw new Error(`Missing exercise ${exerciseId}`);
  return isTemplate(exercise) ? instantiateExercise(exercise, seed ?? 0).exercise : exercise;
}

function correctAnswer(exerciseId: string, seed: number | null): unknown {
  const exercise = concreteExercise(exerciseId, seed);
  if (exercise.type === 'mc') {
    const correct = exercise.options.filter((option) => option.correct).map((option) => option.id);
    return exercise.multi ? correct : correct[0];
  }
  if (exercise.type === 'numeric') return exercise.answer;
  if ('answer' in exercise) return exercise.answer;
  throw new Error(`No test answer for ${exercise.id}`);
}

function wrongAnswer(exerciseId: string, seed: number | null): unknown {
  const exercise = concreteExercise(exerciseId, seed);
  if (exercise.type === 'mc') {
    return exercise.options.find((option) => !option.correct)?.id ?? 'incorrect-option';
  }
  if (exercise.type === 'numeric') return exercise.answer + 1_000_000;
  throw new Error(`No test wrong answer for ${exercise.id}`);
}

async function answerProblem(problemId: string, answer: unknown, activityId?: string) {
  return app.request(`/api/lessons/${conceptId}/run/answer`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ problemId, answer, ...(activityId ? { activityId } : {}) }),
  });
}

async function activityFixture() {
  const [session] = await db
    .insert(studySessions)
    .values({
      userId,
      plannedMinutes: 30,
      startedAt: new Date(headers['X-Now']),
      status: 'active',
    })
    .returning();
  if (!session) throw new Error('Could not create the session fixture');
  const rows = await db
    .insert(sessionActivities)
    .values([
      {
        sessionId: session.id,
        idx: 0,
        kind: 'learn',
        conceptId,
        plannedMinutes: 15,
        status: 'in_progress',
      },
      {
        sessionId: session.id,
        idx: 1,
        kind: 'practice',
        conceptId: 'linear-regression',
        plannedMinutes: 15,
        status: 'planned',
      },
    ])
    .returning();
  const [learn, next] = rows;
  if (!learn || !next) throw new Error('Could not create the activity fixtures');
  return { session, learn, next };
}

async function getCurrentRun() {
  const response = await getRun();
  expect(response.status).toBe(200);
  return (await response.json()).run;
}

async function rowCounts() {
  const runRows = await db
    .select({ id: lessonRuns.id })
    .from(lessonRuns)
    .where(eq(lessonRuns.userId, userId));
  const problemRows = runRows.length
    ? await db
        .select()
        .from(lessonProblems)
        .where(
          inArray(
            lessonProblems.runId,
            runRows.map((run) => run.id),
          ),
        )
    : [];
  return {
    runs: runRows.length,
    problems: problemRows.length,
    attempts: (await db.select().from(attempts).where(eq(attempts.userId, userId))).length,
    xp: (await db.select().from(xpEvents).where(eq(xpEvents.userId, userId))).length,
  };
}

test('GET run is read-only and POST creates exactly one pending problem', async () => {
  const before = await rowCounts();
  const read = await getRun();
  expect(await read.json()).toEqual({ run: null });
  expect(await rowCounts()).toEqual(before);

  const first = await startRun();
  const firstBody = await first.json();
  expect(first.status).toBe(200);
  expect(firstBody.run.pendingProblem).toMatchObject({
    id: expect.any(String),
    exercise: { prompt: expect.any(String) },
  });
  const second = await startRun();
  expect((await second.json()).run.pendingProblem.id).toBe(firstBody.run.pendingProblem.id);
  expect(await db.select().from(lessonProblems)).toHaveLength(1);
});

test('basics does not count toward the two correct answers or the XP award', async () => {
  let run = (await (await startRun()).json()).run;
  expect(run.currentPointId).toBe('sl-inputs-targets');
  expect(content.exercisesById.get(run.pending.exerciseId)?.role).toBe('basics');
  for (let count = 0; count < 3; count += 1) {
    const pending = run.pending;
    const response = await answerProblem(
      pending.id,
      correctAnswer(pending.exerciseId, pending.seed),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    run = body.state;
    expect(run.lastAnsweredProblem.id).toBe(pending.id);
    expect(run.lastAnsweredProblem.result).toMatchObject({
      yourAnswer: expect.any(String),
      correctAnswer: expect.any(String),
    });
    if (count === 0) expect(run.points[0]).toMatchObject({ answered: 0, streak: 0 });
    if (count < 2) run = (await (await startRun()).json()).run;
  }
  expect(run.points[0]).toMatchObject({ id: 'sl-inputs-targets', status: 'passed', answered: 2 });
  expect(run.xpEarned).toBe(10);
  const events = await db.select().from(xpEvents).where(eq(xpEvents.userId, userId));
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ kind: 'knowledge_point', amount: 10 });
});

test('double-submit returns 409 and records just one attempt', async () => {
  const run = (await (await startRun()).json()).run;
  const pending = run.pending;
  const answer = correctAnswer(pending.exerciseId, pending.seed);
  const firstResponse = await answerProblem(pending.id, answer);
  expect(firstResponse.status).toBe(200);
  expect((await firstResponse.json()).state.lastAnsweredProblem.id).toBe(pending.id);
  expect((await answerProblem(pending.id, answer)).status).toBe(409);
  expect(await db.select().from(attempts).where(eq(attempts.userId, userId))).toHaveLength(1);
});

async function pendingTemplate() {
  let run = (await (await startRun()).json()).run;
  for (let count = 0; count < 5; count += 1) {
    const pending = run.pending;
    const exercise = content.exercisesById.get(pending.exerciseId);
    if (exercise && isTemplate(exercise)) return { run, pending, exercise };
    const result = await answerProblem(pending.id, wrongAnswer(pending.exerciseId, pending.seed));
    run = (await result.json()).state;
    if (run.status === 'needs_retry')
      throw new Error('Template was not served before the point failed');
    if (!run.pending && count < 4) run = (await (await startRun()).json()).run;
  }
  throw new Error('No template was served in the first knowledge point');
}

test('a template is graded with its stored seed and rejects another seed answer', async () => {
  const own = await pendingTemplate();
  const accepted = await answerProblem(
    own.pending.id,
    correctAnswer(own.pending.exerciseId, own.pending.seed),
  );
  expect((await accepted.json()).correct).toBe(1);

  await db.delete(users).where(eq(users.id, userId));
  await db.insert(users).values({
    id: userId,
    displayName: 'Lesson runner test learner',
    timezone: 'Europe/London',
    startDate: '2026-01-01',
  });
  const otherSeedCase = await pendingTemplate();
  let alternateSeed = (otherSeedCase.pending.seed ?? 0) + 1;
  let alternateAnswer = instantiateExercise(otherSeedCase.exercise, alternateSeed).exercise.answer;
  const ownAnswer = correctAnswer(otherSeedCase.pending.exerciseId, otherSeedCase.pending.seed);
  while (alternateAnswer === ownAnswer) {
    alternateSeed += 1;
    alternateAnswer = instantiateExercise(otherSeedCase.exercise, alternateSeed).exercise.answer;
  }
  const rejected = await answerProblem(otherSeedCase.pending.id, alternateAnswer);
  expect(rejected.status).toBe(200);
  expect((await rejected.json()).correct).toBe(0);
});

test('failed round completes its activity, starts the next, and resumes at round two', async () => {
  const activities = await activityFixture();
  let run = (await (await startRun(activities.learn.id)).json()).run;
  const firstProblemId = run.pending.id;
  for (let count = 0; count < 5; count += 1) {
    const pending = run.pending;
    const result = await answerProblem(
      pending.id,
      wrongAnswer(pending.exerciseId, pending.seed),
      activities.learn.id,
    );
    expect(result.status).toBe(200);
    const body = await result.json();
    run = body.state;
    expect(run.lastAnsweredProblem.id).toBe(pending.id);
    if (count < 4) run = (await (await startRun(activities.learn.id)).json()).run;
  }
  expect(run.status).toBe('needs_retry');
  expect(run.points[0]).toMatchObject({ id: 'sl-inputs-targets', status: 'failed', round: 1 });
  const [completedActivity] = await db
    .select()
    .from(sessionActivities)
    .where(eq(sessionActivities.id, activities.learn.id));
  const [startedActivity] = await db
    .select()
    .from(sessionActivities)
    .where(eq(sessionActivities.id, activities.next.id));
  expect(completedActivity?.status).toBe('completed');
  expect(startedActivity?.status).toBe('in_progress');
  const resumed = (await (await startRun(activities.learn.id)).json()).run;
  expect(resumed.currentPointId).toBe('sl-inputs-targets');
  expect(resumed.points[0]).toMatchObject({ status: 'active', round: 2, answered: 0 });
  expect(resumed.pending.round).toBe(2);
  expect(resumed.pending.id).not.toBe(firstProblemId);
});

test('finishing all points awards the XP sum and GET matches each POST state', async () => {
  let run = (await (await startRun()).json()).run;
  let reload = await getCurrentRun();
  expect(reload).toEqual(run);
  let steps = 0;
  while (run.status !== 'completed' && steps < 30) {
    if (!run.pending) {
      run = (await (await startRun()).json()).run;
    } else {
      const pending = run.pending;
      const response = await answerProblem(
        pending.id,
        correctAnswer(pending.exerciseId, pending.seed),
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      run = body.state;
      expect(run.lastAnsweredProblem.id).toBe(pending.id);
    }
    reload = await getCurrentRun();
    expect(reload).toEqual(run);
    steps += 1;
  }
  expect(run.status).toBe('completed');
  expect(run.points.every((point: { status: string }) => point.status === 'passed')).toBe(true);
  expect(run.xpEarned).toBe(
    run.points.reduce((sum: number, point: { answered: number }) => {
      const xp = { 2: 10, 3: 9, 4: 8, 5: 7 }[point.answered as 2 | 3 | 4 | 5] ?? 0;
      return sum + xp;
    }, 0),
  );
  expect(run.xpEarned).toBeGreaterThan(0);
});

test('template guards and tutor threads safely support unanswered lesson problems', async () => {
  const template = content.exercises.find((exercise) => isTemplate(exercise));
  if (!template) throw new Error('Expected a template exercise');
  const getTemplate = await app.request(`/api/exercises/${template.id}`, { headers });
  expect(getTemplate.status).toBe(400);
  const attemptTemplate = await app.request('/api/attempts', {
    method: 'POST',
    headers,
    body: JSON.stringify({ exerciseId: template.id, answer: 1, mode: 'practice' }),
  });
  expect(attemptTemplate.status).toBe(400);
  const run = (await (await startRun()).json()).run;
  const chat = await app.request('/api/tutor/threads', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      question: 'Can you help?',
      lessonProblemId: run.pending.id,
    }),
  });
  expect(chat.status).toBe(200);
});

test('test answer endpoint is absent unless ACADEMY_E2E is enabled', async () => {
  const previous = process.env.ACADEMY_E2E;
  delete process.env.ACADEMY_E2E;
  try {
    const withoutHook = createApp({ db, content, tutorProvider: new FakeProvider() });
    const response = await withoutHook.request(
      '/api/test/lesson-problems/00000000-0000-4000-8000-000000000001/answer',
      { headers },
    );
    expect(response.status).toBe(404);
  } finally {
    if (previous === undefined) delete process.env.ACADEMY_E2E;
    else process.env.ACADEMY_E2E = previous;
  }
});
