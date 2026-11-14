import { and, eq, inArray } from 'drizzle-orm';
import { Rating } from 'ts-fsrs';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { createApp } from '../../src/app.js';
import { env } from '../../src/config.js';
import { loadContent } from '../../src/content/load.js';
import { instantiateExercise, isTemplate } from '../../src/content/templates.js';
import type { ContentIndex } from '../../src/content/types.js';
import { createDb } from '../../src/db/client.js';
import {
  attempts,
  lessonProblems,
  lessonQuizAttempts,
  lessonQuizItems,
  lessonRuns,
  reviewCards,
  reviewLogs,
  sessionActivities,
  studySessions,
  tutorMessages,
  users,
  xpEvents,
} from '../../src/db/schema.js';
import { FakeProvider } from '../../src/features/tutor/provider.js';

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

test('full lesson review carries its rendered checks and the same derived run status', async () => {
  const started = await (await startRun()).json();
  const response = await app.request(`/api/lessons/${conceptId}/review`, { headers });
  expect(response.status).toBe(200);
  const review = await response.json();
  expect(review.runStatus).toBe(started.run.status);
  const ids = Object.keys(review.checks);
  expect(ids).toEqual([review.lesson.final]);
  for (const id of ids) {
    const exercise = await (await app.request(`/api/exercises/${id}`, { headers })).json();
    expect(review.checks[id]).toEqual(exercise);
    expect(review.checks[id]).not.toHaveProperty('solution');
    expect(review.checks[id]).not.toHaveProperty('answer');
  }
});

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
  if ('accept' in exercise) return exercise.accept[0];
  if (exercise.type === 'debug') {
    return {
      line: exercise.buggy_line,
      fixId: exercise.fix_options.find((option) => option.correct)?.id,
    };
  }
  throw new Error(`No test answer for ${exercise.id}`);
}

function wrongAnswer(exerciseId: string, seed: number | null): unknown {
  const exercise = concreteExercise(exerciseId, seed);
  if (exercise.type === 'mc') {
    return exercise.options.find((option) => !option.correct)?.id ?? 'incorrect-option';
  }
  if (exercise.type === 'numeric') return exercise.answer + 1_000_000;
  if (exercise.type === 'debug') {
    return {
      line: exercise.buggy_line + 1,
      fixId: exercise.fix_options.find((option) => option.correct)?.id,
    };
  }
  if ('answer' in exercise) {
    return typeof exercise.answer === 'number' ? exercise.answer + 1_000_000 : 'wrong answer';
  }
  if ('accept' in exercise) return 'wrong answer';
  throw new Error(`No test wrong answer for ${exercise.id}`);
}

async function answerProblem(
  problemId: string,
  answer: unknown,
  activityId?: string,
  requestHeaders = headers,
) {
  return app.request(`/api/lessons/${conceptId}/run/answer`, {
    method: 'POST',
    headers: requestHeaders,
    body: JSON.stringify({ problemId, answer, ...(activityId ? { activityId } : {}) }),
  });
}

async function startQuiz(activityId?: string) {
  return app.request(`/api/lessons/${conceptId}/quiz/start`, {
    method: 'POST',
    headers,
    body: JSON.stringify(activityId ? { activityId } : {}),
  });
}

async function answerQuizItem(itemId: string, answer: unknown, activityId?: string) {
  return app.request(`/api/lessons/${conceptId}/quiz/answer`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ itemId, answer, ...(activityId ? { activityId } : {}) }),
  });
}

async function submitQuiz(activityId?: string) {
  return app.request(`/api/lessons/${conceptId}/quiz/submit`, {
    method: 'POST',
    headers,
    body: JSON.stringify(activityId ? { activityId } : {}),
  });
}

async function finishLessonSteps(activityId?: string) {
  let run = (await (await startRun(activityId)).json()).run;
  let steps = 0;
  while (run.status === 'in_progress' && steps < 100) {
    if (!run.pending) {
      run = (await (await startRun(activityId)).json()).run;
      continue;
    }
    const pending = run.pending;
    const response = await answerProblem(
      pending.id,
      correctAnswer(pending.exerciseId, pending.seed),
      activityId,
    );
    expect(response.status).toBe(200);
    run = (await response.json()).state;
    steps += 1;
  }
  expect(steps).toBeLessThan(100);
  expect(run.status).toMatch(/^(quiz|completed)$/);
  return run;
}

async function answerQuizAttempt(
  quiz: { current: { attemptId: string } },
  correct = true,
  activityId?: string,
) {
  const items = await db
    .select()
    .from(lessonQuizItems)
    .where(eq(lessonQuizItems.quizAttemptId, quiz.current.attemptId))
    .orderBy(lessonQuizItems.position);
  for (const item of items) {
    const answer = correct
      ? correctAnswer(item.exerciseId, item.seed)
      : wrongAnswer(item.exerciseId, item.seed);
    const response = await answerQuizItem(item.id, answer, activityId);
    expect(response.status).toBe(200);
  }
  return items;
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

test('basics counts toward the two-correct streak and the XP award', async () => {
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
    const resultExpectation = {
      yourAnswer: expect.any(String),
      correctAnswer: expect.any(String),
    };
    expect(run.lastAnsweredProblem.result).toMatchObject(resultExpectation);
    if (content.exercisesById.get(pending.exerciseId)?.type === 'mc') {
      expect(run.lastAnsweredProblem.result.answerOptions).toMatchObject({
        selected: expect.any(Array),
        correct: expect.any(Array),
      });
    }
    if (count === 0) expect(run.points[0]).toMatchObject({ answered: 1, streak: 1 });
    if (count < 2) run = (await (await startRun()).json()).run;
  }
  expect(run.points[0]).toMatchObject({ id: 'sl-inputs-targets', status: 'passed', answered: 2 });
  expect(run.xpEarned).toBe(10);
  const events = await db.select().from(xpEvents).where(eq(xpEvents.userId, userId));
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ kind: 'knowledge_point', amount: 10 });
});

test('correct answers with tutor help advance practice while assistance stays question-specific', async () => {
  let run = (await (await startRun()).json()).run;
  let pending = run.pending;
  const firstAnswer = await answerProblem(
    pending.id,
    correctAnswer(pending.exerciseId, pending.seed),
  );
  expect(firstAnswer.status).toBe(200);
  run = (await firstAnswer.json()).state;
  expect(run.points[0]).toMatchObject({ status: 'active', streak: 1 });

  run = (await (await startRun()).json()).run;
  pending = run.pending;
  await db.insert(tutorMessages).values({
    userId,
    lessonProblemId: pending.id,
    role: 'user',
    content: 'Can you explain this question?',
    createdAt: new Date('2026-01-01T12:00:00.001Z'),
  });
  const assistedResponse = await answerProblem(
    pending.id,
    correctAnswer(pending.exerciseId, pending.seed),
    undefined,
    { ...headers, 'X-Now': '2026-01-01T12:00:01.000Z' },
  );
  expect(assistedResponse.status).toBe(200);
  const assistedBody = await assistedResponse.json();
  expect(assistedBody.assisted).toBe(true);
  expect(assistedBody.state.points[0]).toMatchObject({ status: 'passed', streak: 2 });
  expect(assistedBody.state.lastAnsweredProblem.result.assisted).toBe(true);
  const [assistedProblem] = await db
    .select()
    .from(lessonProblems)
    .where(eq(lessonProblems.id, pending.id));
  expect(assistedProblem?.assisted).toBe(true);
  const [assistedAttempt] = await db
    .select()
    .from(attempts)
    .where(eq(attempts.id, assistedProblem?.attemptId ?? ''));
  expect(assistedAttempt).toMatchObject({ hintsUsed: 1, credit: 0.7 });

  run = (await (await startRun()).json()).run;
  pending = run.pending;
  const unassistedResponse = await answerProblem(
    pending.id,
    correctAnswer(pending.exerciseId, pending.seed),
    undefined,
    { ...headers, 'X-Now': '2026-01-01T12:00:02.000Z' },
  );
  expect(unassistedResponse.status).toBe(200);
  const unassistedBody = await unassistedResponse.json();
  expect(unassistedBody.assisted).toBe(false);
  expect(unassistedBody.state.points[0]).toMatchObject({ status: 'passed', streak: 2 });
  expect(unassistedBody.state.points[1]).toMatchObject({ status: 'active', streak: 1 });
  const [unassistedProblem] = await db
    .select()
    .from(lessonProblems)
    .where(eq(lessonProblems.id, pending.id));
  expect(unassistedProblem?.assisted).toBe(false);
  const [unassistedAttempt] = await db
    .select()
    .from(attempts)
    .where(eq(attempts.id, unassistedProblem?.attemptId ?? ''));
  expect(unassistedAttempt).toMatchObject({ hintsUsed: 0 });
});

test('historical correct answers recover a blocked step without duplicate XP or replacing old awards', async () => {
  const initial = (await (await startRun()).json()).run;
  const problem = initial.pending;
  const [first] = await db.select().from(lessonProblems).where(eq(lessonProblems.id, problem.id));
  if (!first) throw new Error('Expected a served problem');
  await db
    .update(lessonProblems)
    .set({ correct: 1, answeredAt: new Date('2026-01-01T12:00:01Z') })
    .where(eq(lessonProblems.id, first.id));
  await db.insert(lessonProblems).values(
    [2, 3, 4].map((position) => ({
      runId: first.runId,
      knowledgePointId: first.knowledgePointId,
      round: first.round,
      position,
      exerciseId: first.exerciseId,
      seed: first.seed,
      assisted: true,
      correct: position < 4 ? 1 : null,
      servedAt: new Date(`2026-01-01T12:00:0${position}Z`),
      answeredAt: position < 4 ? new Date(`2026-01-01T12:00:0${position}Z`) : null,
    })),
  );
  const before = await (await getRun()).json();
  expect(before.run.points[0]).toMatchObject({ status: 'passed', streak: 2 });
  expect(before.run.needsProgressSync).toBe(true);
  expect(await db.select().from(xpEvents).where(eq(xpEvents.userId, userId))).toHaveLength(0);
  const reconcile = () =>
    app.request(`/api/lessons/${conceptId}/run`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ reconcileProgress: true }),
    });
  const recoveredResponse = await reconcile();
  expect(recoveredResponse.status).toBe(200);
  const recovered = (await recoveredResponse.json()).run;
  expect(recovered.needsProgressSync).toBeUndefined();
  expect(recovered.currentPointId).not.toBe(first.knowledgePointId);
  expect(recovered.points[0].xpEarned).toBe(10);
  await reconcile();
  const awards = await db.select().from(xpEvents).where(eq(xpEvents.userId, userId));
  expect(awards).toHaveLength(1);
  expect(awards[0].amount).toBe(10);
  expect(await db.select().from(attempts).where(eq(attempts.userId, userId))).toHaveLength(0);
  await db.update(xpEvents).set({ amount: 7 }).where(eq(xpEvents.id, awards[0].id));
  const preserved = (await (await reconcile()).json()).run;
  expect(preserved.points[0].xpEarned).toBe(7);
  expect(preserved.xpEarned).toBe(7);
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

test('five misses keep the step active and leave the session activity open', async () => {
  const activities = await activityFixture();
  let run = (await (await startRun(activities.learn.id)).json()).run;
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
    run = (await (await startRun(activities.learn.id)).json()).run;
  }
  expect(run.status).toBe('in_progress');
  expect(run.points[0]).toMatchObject({
    id: 'sl-inputs-targets',
    status: 'active',
    round: 1,
    answered: 5,
  });
  expect(run.pending).toBeTruthy();
  const [completedActivity] = await db
    .select()
    .from(sessionActivities)
    .where(eq(sessionActivities.id, activities.learn.id));
  const [startedActivity] = await db
    .select()
    .from(sessionActivities)
    .where(eq(sessionActivities.id, activities.next.id));
  expect(completedActivity?.status).toBe('in_progress');
  expect(startedActivity?.status).not.toBe('in_progress');
  const resumed = (await (await startRun(activities.learn.id)).json()).run;
  expect(resumed.currentPointId).toBe('sl-inputs-targets');
  expect(resumed.points[0]).toMatchObject({ status: 'active', round: 1, answered: 5 });
  expect(resumed.pending.round).toBe(1);
});

test('finishing all points awards the XP sum and GET matches each POST state', async () => {
  let run = (await (await startRun()).json()).run;
  let reload = await getCurrentRun();
  expect(reload).toEqual(run);
  let steps = 0;
  while (run.status === 'in_progress' && steps < 30) {
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
  expect(run.status).toBe('quiz');
  expect(run.points.every((point: { status: string }) => point.status === 'passed')).toBe(true);
  expect(run.xpEarned).toBe(
    run.points.reduce((sum: number, point: { answered: number }) => {
      const xp = { 2: 10, 3: 9, 4: 8, 5: 7 }[point.answered as 2 | 3 | 4 | 5] ?? 0;
      return sum + xp;
    }, 0),
  );
  expect(run.xpEarned).toBeGreaterThan(0);
});

test('practice-only questions resume, record practice, and do not change XP or run status', async () => {
  const completedSteps = await finishLessonSteps();
  const xpBefore = await db.select().from(xpEvents).where(eq(xpEvents.userId, userId));
  const pointId = completedSteps.points[0].id;
  const response = await app.request(`/api/lessons/${conceptId}/run/practice`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ pointId }),
  });
  expect(response.status).toBe(200);
  let run = (await response.json()).run;
  expect(run.status).toBe('quiz');
  expect(run.pendingPracticeProblem).toMatchObject({
    practiceOnly: true,
    answeredAt: null,
  });
  const practiceId = run.pendingPracticeProblem.id;
  const samePointResponse = await app.request(`/api/lessons/${conceptId}/run/practice`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ pointId }),
  });
  expect(samePointResponse.status).toBe(200);
  expect((await samePointResponse.json()).run.pendingPracticeProblem.id).toBe(practiceId);
  const pendingRows = await db
    .select()
    .from(lessonProblems)
    .where(eq(lessonProblems.runId, completedSteps.id));
  expect(pendingRows.filter((row) => row.practiceOnly && row.answeredAt === null)).toHaveLength(1);
  const switched = await app.request(`/api/lessons/${conceptId}/run/practice`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ pointId: completedSteps.points[1].id }),
  });
  expect(switched.status).toBe(200);
  run = (await switched.json()).run;
  expect(run.pendingPracticeProblem.knowledgePointId).toBe(completedSteps.points[1].id);
  const switchedPracticeId = run.pendingPracticeProblem.id;
  expect(switchedPracticeId).not.toBe(practiceId);
  const pendingAfterSwitch = await db
    .select()
    .from(lessonProblems)
    .where(eq(lessonProblems.runId, completedSteps.id));
  expect(
    pendingAfterSwitch.filter((row) => row.practiceOnly && row.answeredAt === null),
  ).toHaveLength(1);
  expect(pendingAfterSwitch.some((row) => row.id === practiceId)).toBe(false);
  const resumed = await getCurrentRun();
  expect(resumed.pendingPracticeProblem.id).toBe(switchedPracticeId);
  const answer = correctAnswer(
    resumed.pendingPracticeProblem.exerciseId,
    resumed.pendingPracticeProblem.seed,
  );
  const answered = await answerProblem(switchedPracticeId, answer);
  expect(answered.status).toBe(200);
  run = (await answered.json()).state;
  expect(run.status).toBe('quiz');
  expect(run.pendingPracticeProblem).toBeUndefined();
  expect(await db.select().from(xpEvents).where(eq(xpEvents.userId, userId))).toEqual(xpBefore);
  const [attempt] = await db
    .select()
    .from(attempts)
    .where(eq(attempts.id, run.lastAnsweredProblem.attemptId));
  expect(attempt?.mode).toBe('practice');
  const [problem] = await db
    .select()
    .from(lessonProblems)
    .where(eq(lessonProblems.id, switchedPracticeId));
  expect(problem?.practiceOnly).toBe(true);
});

test('quiz start is idempotent and unsubmitted answers disclose no correctness', async () => {
  await finishLessonSteps();
  const firstResponse = await startQuiz();
  expect(firstResponse.status).toBe(200);
  const firstRun = (await firstResponse.json()).run;
  expect(firstRun.quiz).toMatchObject({
    status: 'in_progress',
    passMark: 0.8,
    bestPassed: false,
  });
  expect(firstRun.quiz.current.items.length).toBeGreaterThan(0);
  const repeatedStart = await startQuiz();
  const repeatedRun = (await repeatedStart.json()).run;
  expect(repeatedRun.quiz.current.attemptId).toBe(firstRun.quiz.current.attemptId);
  expect(await db.select().from(lessonQuizAttempts)).toHaveLength(1);

  const firstItem = firstRun.quiz.current.items[0];
  const question = JSON.stringify(firstItem);
  for (const secret of ['"answer"', '"answer_expr"', '"correct"', '"feedback"', '"solution"']) {
    expect(question).not.toContain(secret);
  }
  const [firstRow] = await db
    .select()
    .from(lessonQuizItems)
    .where(eq(lessonQuizItems.id, firstItem.id));
  if (!firstRow) throw new Error('Quiz item missing from database');
  const answered = await answerQuizItem(
    firstItem.id,
    correctAnswer(firstRow.exerciseId, firstRow.seed),
  );
  expect(answered.status).toBe(200);
  const answerBody = await answered.json();
  expect(answerBody).not.toHaveProperty('correct');
  expect(answerBody).not.toHaveProperty('feedback');
  expect(answerBody).not.toHaveProperty('solution');
  expect(answerBody.run.quiz.current.items[0]).toMatchObject({ answered: true });
  expect(JSON.stringify(answerBody.run.quiz.current)).not.toMatch(
    /"(?:correct|feedback|solution|answer_expr|answer)"\s*:/,
  );
  expect((await answerQuizItem(firstItem.id, 'second answer')).status).toBe(409);
  expect((await submitQuiz()).status).toBe(409);
  const review = await app.request(
    `/api/lessons/${conceptId}/quiz/${firstRun.quiz.current.attemptId}/review`,
    { headers },
  );
  expect(review.status).toBe(403);
  const remaining = await db
    .select()
    .from(lessonQuizItems)
    .where(eq(lessonQuizItems.quizAttemptId, firstRun.quiz.current.attemptId));
  for (const item of remaining.filter((row) => row.id !== firstItem.id)) {
    const response = await answerQuizItem(item.id, wrongAnswer(item.exerciseId, item.seed));
    expect(response.status).toBe(200);
  }
  const failed = await submitQuiz();
  expect(failed.status).toBe(200);
  const failedRun = (await failed.json()).run;
  expect(failedRun.quiz).toMatchObject({
    status: 'failed',
    bestPassed: false,
    last: { passed: false },
  });
  expect(failedRun.quiz.reviewRequired.length).toBeGreaterThan(0);
  expect(
    failedRun.quiz.reviewRequired.every(
      (step: { answered: number; needed: number }) => step.answered === 0 && step.needed === 3,
    ),
  ).toBe(true);
  const blockedRetake = await startQuiz();
  expect(blockedRetake.status).toBe(409);
  expect(await blockedRetake.json()).toEqual({
    error: 'Review the steps you missed before retaking the quiz',
  });
  let practiceTime = Date.parse(headers['X-Now']);
  for (const step of failedRun.quiz.reviewRequired as Array<{ pointId: string; needed: number }>) {
    for (let count = 0; count < step.needed; count += 1) {
      practiceTime += 1_000;
      const practiceHeaders = {
        ...headers,
        'X-Now': new Date(practiceTime).toISOString(),
      };
      const practiceResponse = await app.request(`/api/lessons/${conceptId}/run/practice`, {
        method: 'POST',
        headers: practiceHeaders,
        body: JSON.stringify({ pointId: step.pointId, warmup: true }),
      });
      expect(practiceResponse.status).toBe(200);
      const practiceRun = (await practiceResponse.json()).run;
      const practiceProblem = practiceRun.pendingPracticeProblem;
      expect(practiceProblem.practiceOnly).toBe(true);
      practiceTime += 1_000;
      const answerHeaders = {
        ...headers,
        'X-Now': new Date(practiceTime).toISOString(),
      };
      const answerResponse = await answerProblem(
        practiceProblem.id,
        correctAnswer(practiceProblem.exerciseId, practiceProblem.seed),
        undefined,
        answerHeaders,
      );
      expect(answerResponse.status).toBe(200);
    }
  }
  const reviewed = await getCurrentRun();
  expect(
    reviewed.quiz.reviewRequired.every((step: { answered: number }) => step.answered === 3),
  ).toBe(true);
  practiceTime += 1_000;
  const extraWarmup = await app.request(`/api/lessons/${conceptId}/run/practice`, {
    method: 'POST',
    headers: { ...headers, 'X-Now': new Date(practiceTime).toISOString() },
    body: JSON.stringify({
      pointId: reviewed.quiz.reviewRequired[0].pointId,
      warmup: true,
    }),
  });
  expect(extraWarmup.status).toBe(409);
  expect(await extraWarmup.json()).toEqual({
    error: 'Quiz practice is complete for this step',
  });
  expect((await getCurrentRun()).pendingPracticeProblem).toBeUndefined();
  expect((await startQuiz()).status).toBe(200);
  const failedReview = await app.request(
    `/api/lessons/${conceptId}/quiz/${firstRun.quiz.current.attemptId}/review`,
    { headers },
  );
  expect(failedReview.status).toBe(403);
});

test('passing and retaking a quiz awards quiz XP only once and enables review', async () => {
  await finishLessonSteps();
  expect(await db.select().from(reviewCards).where(eq(reviewCards.userId, userId))).toHaveLength(0);
  const started = (await (await startQuiz()).json()).run;
  const quizRows = await db
    .select()
    .from(lessonQuizItems)
    .where(eq(lessonQuizItems.quizAttemptId, started.quiz.current.attemptId))
    .orderBy(lessonQuizItems.position);
  const dimensions = new Set(
    quizRows.map((item) => content.exercisesById.get(item.exerciseId)?.dimension),
  );
  expect(dimensions.size).toBeGreaterThan(1);
  expect(quizRows.length).toBeGreaterThanOrEqual(5);
  const hardDimension = [...dimensions][0];
  const hardItem = quizRows.find(
    (item) => content.exercisesById.get(item.exerciseId)?.dimension === hardDimension,
  );
  if (!hardItem) throw new Error('Expected an item for the dimension rated Hard');
  for (const item of quizRows) {
    const answer =
      item.id === hardItem.id
        ? wrongAnswer(item.exerciseId, item.seed)
        : correctAnswer(item.exerciseId, item.seed);
    expect((await answerQuizItem(item.id, answer)).status).toBe(200);
  }
  const firstItems = quizRows;
  const passedResponse = await submitQuiz();
  expect(passedResponse.status).toBe(200);
  let result = await passedResponse.json();
  expect(result.run.quiz).toMatchObject({
    status: 'passed',
    bestPassed: true,
    last: { passed: true, total: firstItems.length },
  });
  expect(result.xpAwarded).toBe(firstItems.length);
  const quizXp = await db
    .select()
    .from(xpEvents)
    .where(and(eq(xpEvents.userId, userId), eq(xpEvents.kind, 'quiz')));
  expect(quizXp).toHaveLength(1);
  expect(quizXp[0]?.amount).toBe(firstItems.length);
  const firstPassCards = await db.select().from(reviewCards).where(eq(reviewCards.userId, userId));
  expect(firstPassCards.map((card) => card.dimension).sort()).toEqual([...dimensions].sort());
  for (const card of firstPassCards) {
    const [log] = await db.select().from(reviewLogs).where(eq(reviewLogs.cardId, card.id));
    expect(log?.rating).toBe(String(card.dimension === hardDimension ? Rating.Hard : Rating.Good));
  }
  const firstPassLogCount = (await db.select().from(reviewLogs)).length;
  const review = await app.request(
    `/api/lessons/${conceptId}/quiz/${result.run.quiz.last.attemptId}/review`,
    { headers },
  );
  expect(review.status).toBe(200);
  const reviewBody = await review.json();
  expect(reviewBody.items).toHaveLength(firstItems.length);
  expect(reviewBody.items[0]).toMatchObject({
    exercise: { prompt: expect.any(String) },
    yourAnswer: expect.any(String),
    correctAnswer: expect.any(String),
    solution: expect.any(String),
  });
  expect(reviewBody.items.some((item: { correct: number }) => item.correct === 0)).toBe(true);
  expect(reviewBody.items.some((item: { correct: number }) => item.correct === 1)).toBe(true);

  const retake = (await (await startQuiz()).json()).run;
  await answerQuizAttempt(retake.quiz);
  const secondPass = await submitQuiz();
  expect(secondPass.status).toBe(200);
  result = await secondPass.json();
  expect(result.xpAwarded).toBe(0);
  expect(result.run.quiz.bestPassed).toBe(true);
  expect(await db.select().from(reviewCards).where(eq(reviewCards.userId, userId))).toHaveLength(
    firstPassCards.length,
  );
  expect(await db.select().from(reviewLogs)).toHaveLength(firstPassLogCount);
  expect(
    await db
      .select()
      .from(xpEvents)
      .where(and(eq(xpEvents.userId, userId), eq(xpEvents.kind, 'quiz'))),
  ).toHaveLength(1);
});

test('quiz submission completes its attached learn activity after pass or fail', async () => {
  const activities = await activityFixture();
  const run = await finishLessonSteps(activities.learn.id);
  const started = (await (await startQuiz(activities.learn.id)).json()).run;
  await answerQuizAttempt(started.quiz, true, activities.learn.id);
  const submitted = await submitQuiz(activities.learn.id);
  expect(submitted.status).toBe(200);
  const [completedActivity] = await db
    .select()
    .from(sessionActivities)
    .where(eq(sessionActivities.id, activities.learn.id));
  const [nextActivity] = await db
    .select()
    .from(sessionActivities)
    .where(eq(sessionActivities.id, activities.next.id));
  expect(completedActivity?.status).toBe('completed');
  expect(nextActivity?.status).toBe('in_progress');
  expect(run.status).toBe('quiz');
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
