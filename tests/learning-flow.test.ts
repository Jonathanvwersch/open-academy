import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createApp } from '../src/server/app.js';
import { loadContent } from '../src/server/content/load.js';
import { instantiateExercise, isTemplate } from '../src/server/content/templates.js';
import type { ContentIndex } from '../src/server/content/types.js';
import { createDb } from '../src/server/db/client.js';
import {
  attempts,
  hintEvents,
  lessonRuns,
  masteryEvents,
  reviewCards,
  reviewLogs,
  sessionActivities,
  studySessions,
  users,
  xpEvents,
} from '../src/server/db/schema.js';
import { env } from '../src/server/env.js';
import { answerOptionsFor } from '../src/server/learning/answer-options.js';
import { newReviewCard, scheduleInitialReview } from '../src/server/learning/fsrs.js';
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

async function resetLearner(timezone = 'UTC') {
  await db.delete(users).where(eq(users.id, userId));
  await db.insert(users).values({
    id: userId,
    displayName: 'Test learner',
    timezone,
    startDate: '2026-01-01',
    prefs: { scheduleMinutes: 60 },
  });
}

function headersAt(now: string) {
  return { 'content-type': 'application/json', 'X-Now': now };
}

function correctAnswer(exerciseId: string, seed: number | null): unknown {
  const indexed = content.exercisesById.get(exerciseId);
  if (!indexed) throw new Error(`Missing fixture exercise ${exerciseId}`);
  const exercise = isTemplate(indexed) ? instantiateExercise(indexed, seed ?? 0).exercise : indexed;
  if (exercise.type === 'mc') {
    const correct = exercise.options.filter((option) => option.correct).map((option) => option.id);
    return exercise.multi ? correct : correct[0];
  }
  if ('answer' in exercise) return exercise.answer;
  if ('accept' in exercise) return exercise.accept[0];
  throw new Error(`No test answer for ${exercise.id}`);
}

async function startLessonRun(conceptId: string, activityId: string, now: string) {
  const response = await app.request(`/api/lessons/${conceptId}/run`, {
    method: 'POST',
    headers: headersAt(now),
    body: JSON.stringify({ activityId }),
  });
  expect(response.status).toBe(200);
  return (await response.json()).run;
}

async function answerLessonProblem(
  conceptId: string,
  activityId: string,
  pending: { id: string; exerciseId: string; seed: number | null },
  now: string,
) {
  return app.request(`/api/lessons/${conceptId}/run/answer`, {
    method: 'POST',
    headers: headersAt(now),
    body: JSON.stringify({
      problemId: pending.id,
      activityId,
      answer: correctAnswer(pending.exerciseId, pending.seed),
    }),
  });
}

async function passLessonRun(conceptId: string, activityId: string, now: string) {
  let run = await startLessonRun(conceptId, activityId, now);
  for (let count = 0; count < 20 && run.status !== 'completed'; count += 1) {
    if (!run.pending) run = await startLessonRun(conceptId, activityId, now);
    const pending = run.pending as
      | { id: string; exerciseId: string; seed: number | null }
      | undefined;
    if (!pending) throw new Error('Lesson runner did not provide a pending problem');
    const response = await answerLessonProblem(conceptId, activityId, pending, now);
    expect(response.status).toBe(200);
    run = (await response.json()).state;
  }
  expect(run.status).toBe('completed');
}

async function createLearnActivity(now: string) {
  const [session] = await db
    .insert(studySessions)
    .values({
      userId,
      kind: 'weekday',
      plannedMinutes: 30,
      startedAt: new Date(now),
      status: 'active',
    })
    .returning();
  if (!session) throw new Error('Could not create a lesson-run session');
  const [activity] = await db
    .insert(sessionActivities)
    .values({
      sessionId: session.id,
      idx: 0,
      kind: 'learn',
      conceptId: 'vectors',
      exerciseIds: ['vectors-fixture-final'],
      plannedMinutes: 15,
      status: 'in_progress',
    })
    .returning();
  if (!activity) throw new Error('Could not create a lesson-run activity');
  return { session, activity };
}

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
  expect(exerciseId).toBe('vectors-fixture-final');

  const first = await app.request('/api/attempts', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      exerciseId,
      activityId: activity.id,
      answer: { text: 'I am not sure yet.' },
      mode: 'practice',
    }),
  });
  expect(first.status).toBe(200);
  expect(await first.json()).toMatchObject({ retryAllowed: true });

  const gradedApp = createApp({
    db,
    content,
    tutorProvider: new FakeProvider(undefined, {
      criteria: [{ id: 'length', judgement: 'met', evidence: 'magnitude is length' }],
      feedback_md: 'Good explanation.',
    }),
  });
  const second = await gradedApp.request('/api/attempts', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      exerciseId,
      activityId: activity.id,
      answer: { text: 'A vector magnitude is its length.' },
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

test('practice answers expose selected options and reveal correct ids only after retries end', async () => {
  await resetLearner();
  const [session] = await db
    .insert(studySessions)
    .values({
      userId,
      kind: 'weekday',
      plannedMinutes: 10,
      startedAt: new Date(now),
      status: 'active',
    })
    .returning();
  if (!session) throw new Error('Could not create a practice session');
  const exerciseId = 'linear-algebra-fixture-1-basics';
  const [activity] = await db
    .insert(sessionActivities)
    .values({
      sessionId: session.id,
      idx: 0,
      kind: 'practice',
      conceptId: 'linear-algebra',
      exerciseIds: [exerciseId],
      plannedMinutes: 5,
      status: 'in_progress',
    })
    .returning();
  if (!activity) throw new Error('Could not create a practice activity');
  const exercise = content.exercisesById.get(exerciseId);
  if (exercise?.type !== 'mc') throw new Error('Expected an MC fixture');
  const correctId = exercise.options.find((option) => option.correct)?.id;
  const wrongIds = exercise.options.filter((option) => !option.correct).map((option) => option.id);
  if (!correctId || wrongIds.length < 2) throw new Error('Expected multiple MC options');
  const submit = (answer: string) =>
    app.request('/api/attempts', {
      method: 'POST',
      headers: headersAt(now),
      body: JSON.stringify({ exerciseId, activityId: activity.id, answer, mode: 'practice' }),
    });

  const first = await submit(wrongIds[0] ?? '');
  const firstResult = await first.json();
  expect(firstResult).toMatchObject({
    retryAllowed: true,
    answerOptions: { selected: [wrongIds[0]] },
  });
  expect(firstResult.answerOptions).not.toHaveProperty('correct');

  const final = await submit(wrongIds[1] ?? '');
  const finalResult = await final.json();
  expect(finalResult).toMatchObject({
    retryAllowed: false,
    answerOptions: { selected: [wrongIds[1]], correct: [correctId] },
  });

  const sessionResponse = await app.request(`/api/sessions/${session.id}`, {
    headers: headersAt(now),
  });
  const payload = await sessionResponse.json();
  expect(payload.activities[0].lastAttempt.answerOptions).toEqual(finalResult.answerOptions);
});

test('debug answer option ids identify the selected and correct line and fix', () => {
  const exercise = content.exercisesById.get('linear-algebra-debug');
  if (exercise?.type !== 'debug') throw new Error('Expected a debug fixture');
  expect(answerOptionsFor(exercise, { line: 1, fixId: 'concatenate' }, false)).toEqual({
    selected: ['line:1', 'fix:concatenate'],
  });
  expect(answerOptionsFor(exercise, { line: 3, fixId: 'dot-product' }, true)).toEqual({
    selected: ['line:3', 'fix:dot-product'],
    correct: ['line:3', 'fix:dot-product'],
  });
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
  if (exercise?.type !== 'numeric' || !('answer' in exercise)) {
    throw new Error('Missing hint-free numeric item');
  }
  const appExercise = content.exercisesById.get(exercise.id);
  if (appExercise?.type !== 'numeric' || !('answer' in appExercise)) {
    throw new Error('Missing app numeric item');
  }
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

  const chat = await noTutorApp.request('/api/tutor/threads', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question: 'Can you explain this?' }),
  });
  expect(chat.status).toBe(503);
});

test('explain attempts return and persist tutor rubric judgements and the exemplar', async () => {
  const exercise = content.exercisesById.get('sl-explain-setup');
  if (exercise?.type !== 'explain') throw new Error('Missing explain exercise');
  const judgement = {
    criteria: [
      { id: 'r1', judgement: 'met' as const, evidence: 'inputs and target' },
      { id: 'r2', judgement: 'partial' as const, evidence: 'loss' },
      { id: 'r3', judgement: 'missing' as const, evidence: null },
    ],
    feedback_md: 'Good start.',
  };
  const gradedApp = createApp({
    db,
    content,
    tutorProvider: new FakeProvider(undefined, judgement),
  });
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

  const response = await gradedApp.request('/api/attempts', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Now': now },
    body: JSON.stringify({
      exerciseId: exercise.id,
      activityId: activity.id,
      answer: { text: 'Inputs, target, model, loss and data.' },
      mode: 'practice',
    }),
  });
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body).toMatchObject({
    graded_by: 'llm',
    feedback: 'Good start.',
    rubric: [
      { id: 'r1', judgement: 'met' },
      { id: 'r2', judgement: 'partial' },
      { id: 'r3', judgement: 'missing' },
    ],
    exemplar: exercise.exemplar,
  });
  expect(body).not.toHaveProperty('solution');
  const reloaded = await gradedApp.request(`/api/sessions/${session.id}`);
  const sessionBody = await reloaded.json();
  expect(sessionBody.activities[0].lastAttempt).toMatchObject({
    exerciseId: exercise.id,
    rubric: body.rubric,
    exemplar: exercise.exemplar,
  });
  expect(sessionBody.activities[0].lastAttempt).not.toHaveProperty('solution');
});

test('no-tutor explain flow returns model answer before the capped self-check result', async () => {
  const exercise = content.exercisesById.get('sl-explain-setup');
  if (exercise?.type !== 'explain') throw new Error('Missing explain exercise');
  const headers = { 'content-type': 'application/json', 'X-Now': now };
  const first = await noTutorApp.request('/api/attempts', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      exerciseId: exercise.id,
      answer: { text: 'A model maps inputs to a target.' },
      mode: 'practice',
    }),
  });
  expect(first.status).toBe(200);
  const firstBody = await first.json();
  expect(firstBody).toMatchObject({
    status: 'self_check_required',
    exemplar: exercise.exemplar,
    yourAnswer: 'A model maps inputs to a target.',
  });
  expect(firstBody).not.toHaveProperty('solution');

  const second = await noTutorApp.request('/api/attempts', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      exerciseId: exercise.id,
      answer: { text: 'A model maps inputs to a target.', metCriteria: ['r1', 'r2', 'r3'] },
      mode: 'practice',
    }),
  });
  expect(second.status).toBe(200);
  const body = await second.json();
  expect(body).toMatchObject({
    status: 'graded',
    graded_by: 'self',
    exemplar: exercise.exemplar,
  });
  expect(body).not.toHaveProperty('solution');
  expect(body.credit).toBeLessThanOrEqual(0.5);
});

test('opening a lesson review does not create session or attempt rows', async () => {
  const expectedLesson = content.lessonsByConcept.get('vectors');
  if (!expectedLesson) throw new Error('Missing vectors lesson');
  const beforeAttempts = await db.select().from(attempts).where(eq(attempts.userId, userId));
  const beforeSessions = await db
    .select()
    .from(studySessions)
    .where(eq(studySessions.userId, userId));
  const beforeActivities = await db.select().from(sessionActivities);
  const beforeRuns = await db.select().from(lessonRuns).where(eq(lessonRuns.userId, userId));
  const beforeXp = await db.select().from(xpEvents).where(eq(xpEvents.userId, userId));
  const beforeMasteryEvents = await db
    .select()
    .from(masteryEvents)
    .where(eq(masteryEvents.userId, userId));
  const response = await app.request('/api/lessons/vectors/review');
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body).toMatchObject({
    conceptTitle: 'Vectors',
    lesson: { blocks: expect.any(Array) },
  });
  expect(body.lesson.blocks).toHaveLength(expectedLesson.blocks.length);
  const afterAttempts = await db.select().from(attempts).where(eq(attempts.userId, userId));
  const afterSessions = await db
    .select()
    .from(studySessions)
    .where(eq(studySessions.userId, userId));
  const afterActivities = await db.select().from(sessionActivities);
  const afterRuns = await db.select().from(lessonRuns).where(eq(lessonRuns.userId, userId));
  const afterXp = await db.select().from(xpEvents).where(eq(xpEvents.userId, userId));
  const afterMasteryEvents = await db
    .select()
    .from(masteryEvents)
    .where(eq(masteryEvents.userId, userId));
  expect(afterAttempts).toHaveLength(beforeAttempts.length);
  expect(afterSessions).toHaveLength(beforeSessions.length);
  expect(afterActivities).toHaveLength(beforeActivities.length);
  expect(afterRuns).toHaveLength(beforeRuns.length);
  expect(afterXp).toHaveLength(beforeXp.length);
  expect(afterMasteryEvents).toHaveLength(beforeMasteryEvents.length);
});

test('lesson-runner schedules one due review per concept, then reschedules it', async () => {
  await resetLearner('America/Los_Angeles');
  const dayOne = '2026-01-01T12:00:00.000Z';
  const { activity } = await createLearnActivity(dayOne);
  await passLessonRun('vectors', activity.id, dayOne);

  const cards = await db.select().from(reviewCards).where(eq(reviewCards.userId, userId));
  expect(cards.length).toBeGreaterThan(0);
  const latestDueAt = Math.max(...cards.map((card) => card.dueAt.getTime()));
  const reviewNow = new Date(
    Math.max(new Date('2026-01-12T12:00:00.000Z').getTime(), latestDueAt + 60_000),
  );
  const todayResponse = await app.request('/api/today', {
    headers: headersAt(reviewNow.toISOString()),
  });
  expect(todayResponse.status).toBe(200);
  const today = await todayResponse.json();
  const dueCards = cards.filter((card) => card.dueAt <= reviewNow);
  const reviewActivities = today.plan.activities.filter(
    (activity: { kind: string }) => activity.kind === 'review',
  );
  const plannedCardKeys = reviewActivities.map(
    (activity: { conceptId: string; exerciseIds: string[] }) => {
      const exercise = content.exercisesById.get(activity.exerciseIds[0] ?? '');
      return `${activity.conceptId}/${exercise?.dimension}`;
    },
  );
  expect(reviewActivities).toHaveLength(1);
  expect(
    dueCards.some((card) => plannedCardKeys.includes(`${card.conceptId}/${card.dimension}`)),
  ).toBe(true);

  const reviewActivity = reviewActivities[0];
  if (!reviewActivity) throw new Error('No due review activity was planned');
  const exerciseId = reviewActivity.exerciseIds[0] as string;
  const exercise = content.exercisesById.get(exerciseId);
  if (!exercise) throw new Error(`Missing review exercise ${exerciseId}`);
  const card = dueCards.find(
    (item) => item.conceptId === exercise.concept && item.dimension === exercise.dimension,
  );
  if (!card) throw new Error('Planned review did not match a due card');
  const answerResponse = await app.request('/api/attempts', {
    method: 'POST',
    headers: headersAt(reviewNow.toISOString()),
    body: JSON.stringify({
      exerciseId,
      answer: correctAnswer(exerciseId, null),
      mode: 'review',
    }),
  });
  expect(answerResponse.status).toBe(200);
  expect((await answerResponse.json()).correct).toBeGreaterThan(0);

  const [rescheduled] = await db.select().from(reviewCards).where(eq(reviewCards.id, card.id));
  expect(rescheduled?.dueAt.getTime()).toBeGreaterThanOrEqual(reviewNow.getTime() + 86_400_000);
  const logs = await db.select().from(reviewLogs).where(eq(reviewLogs.cardId, card.id));
  expect(logs).toHaveLength(1);

  const laterToday = new Date(reviewNow.getTime() + 2 * 60 * 60_000);
  const laterResponse = await app.request('/api/today', {
    headers: headersAt(laterToday.toISOString()),
  });
  const later = await laterResponse.json();
  expect(
    later.plan.activities.some(
      (activity: { kind: string; conceptId?: string; exerciseIds: string[] }) => {
        if (activity.kind !== 'review' || activity.conceptId !== card.conceptId) return false;
        return activity.exerciseIds.some(
          (id) => content.exercisesById.get(id)?.dimension === card.dimension,
        );
      },
    ),
  ).toBe(false);
});

test('stale sessions are hidden for today, abandoned by new sessions, and keep lesson progress', async () => {
  await resetLearner('America/Los_Angeles');
  const dayOne = '2026-01-02T07:30:00.000Z';
  const sessionResponse = await app.request('/api/sessions', {
    method: 'POST',
    headers: headersAt(dayOne),
    body: JSON.stringify({ budgetMinutes: 60, focusConceptId: 'vectors' }),
  });
  expect(sessionResponse.status).toBe(201);
  const oldSession = await sessionResponse.json();
  const sameDayToday = await app.request('/api/today', {
    headers: headersAt(dayOne),
  });
  expect((await sameDayToday.json()).activeSessionId).toBe(oldSession.id);
  const learnActivity = oldSession.activities.find(
    (activity: { kind: string; conceptId?: string }) =>
      activity.kind === 'learn' && activity.conceptId === 'vectors',
  );
  expect(learnActivity).toBeDefined();

  let run = await startLessonRun('vectors', learnActivity.id, dayOne);
  const pending = run.pending as
    | { id: string; exerciseId: string; seed: number | null }
    | undefined;
  if (!pending) throw new Error('Expected a pending lesson problem');
  const firstAnswer = await answerLessonProblem('vectors', learnActivity.id, pending, dayOne);
  expect(firstAnswer.status).toBe(200);
  run = (await firstAnswer.json()).state;
  expect(run.status).toBe('in_progress');
  const [lessonRun] = await db
    .select()
    .from(lessonRuns)
    .where(and(eq(lessonRuns.userId, userId), eq(lessonRuns.conceptId, 'vectors')));
  expect(lessonRun?.status).toBe('in_progress');

  const dueAt = new Date('2026-01-02T08:00:00.000Z');
  const [existingCard] = await db
    .select()
    .from(reviewCards)
    .where(
      and(
        eq(reviewCards.userId, userId),
        eq(reviewCards.conceptId, 'vectors'),
        eq(reviewCards.dimension, 'math'),
      ),
    );
  if (existingCard) {
    await db.update(reviewCards).set({ dueAt }).where(eq(reviewCards.id, existingCard.id));
  } else {
    const scheduled = scheduleInitialReview(
      newReviewCard(new Date(dayOne)),
      new Date(dayOne),
      'again',
      'America/Los_Angeles',
      false,
    );
    await db.insert(reviewCards).values({
      userId,
      conceptId: 'vectors',
      dimension: 'math',
      fsrs: scheduled.card,
      dueAt,
      lastReviewAt: new Date(dayOne),
      reps: scheduled.card.reps,
      lapses: scheduled.card.lapses,
    });
  }

  const dayTwo = '2026-01-02T08:30:00.000Z';
  const todayResponse = await app.request('/api/today', { headers: headersAt(dayTwo) });
  const today = await todayResponse.json();
  expect(today.activeSessionId).toBeNull();
  expect(
    today.plan.activities.some(
      (activity: { kind: string; conceptId?: string }) =>
        activity.kind === 'review' && activity.conceptId === 'vectors',
    ),
  ).toBe(true);
  expect(
    today.plan.activities.some(
      (activity: { kind: string; conceptId?: string }) =>
        activity.kind === 'learn' && activity.conceptId === 'vectors',
    ),
  ).toBe(true);

  const learnResponse = await app.request('/api/learn', { headers: headersAt(dayTwo) });
  const learn = await learnResponse.json();
  expect(learn.activeSessionId).toBeNull();
  expect(
    learn.tasks.some(
      (task: { activityKind: string; conceptId?: string }) =>
        task.activityKind === 'review' && task.conceptId === 'vectors',
    ),
  ).toBe(true);
  expect(
    learn.tasks.some(
      (task: { activityKind: string; conceptId?: string }) =>
        task.activityKind === 'learn' && task.conceptId === 'vectors',
    ),
  ).toBe(true);
  const progressResponse = await app.request('/api/progress', {
    headers: headersAt(dayTwo),
  });
  expect((await progressResponse.json()).hours).toBe(0);

  const activeResponse = await app.request('/api/sessions/active', {
    headers: headersAt(dayTwo),
  });
  expect(await activeResponse.json()).toBeNull();
  const oldSessionResponse = await app.request(`/api/sessions/${oldSession.id}`, {
    headers: headersAt(dayTwo),
  });
  expect(oldSessionResponse.status).toBe(200);
  expect((await oldSessionResponse.json()).status).toBe('active');

  const newSessionResponse = await app.request('/api/sessions', {
    method: 'POST',
    headers: headersAt(dayTwo),
    body: JSON.stringify({ budgetMinutes: 60 }),
  });
  expect(newSessionResponse.status).toBe(201);
  const newSession = await newSessionResponse.json();
  expect(
    newSession.activities.some(
      (activity: { kind: string; conceptId?: string }) =>
        activity.kind === 'learn' && activity.conceptId === 'vectors',
    ),
  ).toBe(true);
  expect(
    newSession.activities.some(
      (activity: { kind: string; conceptId?: string }) =>
        activity.kind === 'review' && activity.conceptId === 'vectors',
    ),
  ).toBe(true);
  const [abandoned] = await db
    .select()
    .from(studySessions)
    .where(eq(studySessions.id, oldSession.id));
  expect(abandoned?.status).toBe('abandoned');
  expect(abandoned?.endedAt?.toISOString()).toBe(dayTwo);
  const oldUrlAfterAbandon = await app.request(`/api/sessions/${oldSession.id}`, {
    headers: headersAt(dayTwo),
  });
  expect(oldUrlAfterAbandon.status).toBe(200);
  expect((await oldUrlAfterAbandon.json()).status).toBe('abandoned');

  const activeAfterStart = await app.request('/api/sessions/active', {
    headers: headersAt(dayTwo),
  });
  expect((await activeAfterStart.json()).id).toBe(newSession.id);
});
