import { and, eq } from 'drizzle-orm';
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
  llmCalls,
  sessionActivities,
  studySessions,
  tutorMessages,
  tutorThreads,
  users,
} from '../src/server/db/schema.js';
import { env } from '../src/server/env.js';
import { answerDisplay } from '../src/server/learning/answer-display.js';
import { tutorThreadBodySchema } from '../src/server/routes/tutor-threads.js';
import { sanitizePageContent } from '../src/server/tutor/page-context.js';
import type { TutorProvider, TutorResult } from '../src/server/tutor/provider.js';
import type { ExplanationContext, TutorContext, TutorReply } from '../src/server/tutor/schemas.js';
import { TUTOR_QUESTION_MAX_LENGTH, tutorQuestionTooLongMessage } from '../src/shared/tutor.js';

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

test('tutor request body normalizes null optional context fields', () => {
  const parsed = tutorThreadBodySchema.parse({
    question: 'Help me understand this practice question.',
    conceptId: null,
    activityId: null,
    exerciseId: null,
    lessonProblemId: null,
    page: null,
    knowledgePointId: null,
    paperId: null,
    pageNumber: null,
    selection: null,
  });

  expect(parsed.question).toBe('Help me understand this practice question.');
  for (const key of [
    'conceptId',
    'activityId',
    'exerciseId',
    'lessonProblemId',
    'page',
    'knowledgePointId',
    'paperId',
    'pageNumber',
    'selection',
  ] as const) {
    expect(parsed[key]).toBeUndefined();
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
  throw new Error(`No test answer for ${exercise.id}`);
}

async function startLessonRun(conceptId: string) {
  return app.request(`/api/lessons/${conceptId}/run`, {
    method: 'POST',
    headers,
    body: JSON.stringify({}),
  });
}

async function answerLessonProblem(conceptId: string, problemId: string, answer: unknown) {
  return app.request(`/api/lessons/${conceptId}/run/answer`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ problemId, answer }),
  });
}

test('create-on-first-send persists messages and list/detail preserve newest-first and chronological ordering', async () => {
  const first = await send('first', undefined, { conceptId: 'supervised-learning' });
  expect(first.status).toBe(200);
  const firstPayload = await first.json();
  expect(firstPayload.messages).toHaveLength(2);
  expect(firstPayload.thread.title).toBe('first');
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
    title: 'first',
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
  expect(detail.thread.title).toBe('first');
  const general = await (await send('general question')).json();
  const newestFirst = await (await app.request('/api/tutor/threads', { headers })).json();
  expect(newestFirst).toHaveLength(2);
  expect(newestFirst[0]).toMatchObject({
    id: general.thread.id,
    conceptId: null,
    title: 'general question',
  });
});

test('thread titles collapse whitespace and truncate the first user message to 80 characters', async () => {
  const question = `  ${'first   question\t'.repeat(10)}  `;
  const normalized = question.trim().replace(/\s+/g, ' ');
  const expectedTitle = `${normalized.slice(0, 79)}…`;
  expect(normalized.length).toBeGreaterThan(80);

  const created = await (await send(question)).json();
  expect(created.thread.title).toBe(expectedTitle);

  const listed = await (await app.request('/api/tutor/threads', { headers })).json();
  expect(listed[0].title).toBe(expectedTitle);
  const detail = await (
    await app.request(`/api/tutor/threads/${created.thread.id}`, { headers })
  ).json();
  expect(detail.thread.title).toBe(expectedTitle);
});

test('threads without user messages use the New chat title', async () => {
  const [thread] = await db
    .insert(tutorThreads)
    .values({ userId, conceptId: null, title: 'unused stored title' })
    .returning();
  if (!thread) throw new Error('Expected a tutor thread');

  const listed = await (await app.request('/api/tutor/threads', { headers })).json();
  expect(listed[0].title).toBe('New chat');
  const detail = await (await app.request(`/api/tutor/threads/${thread.id}`, { headers })).json();
  expect(detail.thread.title).toBe('New chat');
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

test('unanswered multiple-choice lesson problems pass only lettered option text to the tutor', async () => {
  const start = await app.request('/api/lessons/chain-rule/run', {
    method: 'POST',
    headers,
    body: JSON.stringify({}),
  });
  const run = (await start.json()).run;
  const pending = run.pending;
  if (!pending) throw new Error('Expected a pending Chain rule lesson problem');
  const exercise = concreteExercise(pending.exerciseId, pending.seed);
  if (exercise.type !== 'mc') throw new Error('Expected a multiple-choice Chain rule problem');

  const response = await send('Help with this question', undefined, {
    lessonProblemId: pending.id,
  });
  expect(response.status).toBe(200);

  const tutorInput = captured.at(-1);
  const optionInput = tutorInput?.exerciseOptions ?? [];
  expect(tutorInput).toMatchObject({
    problem_status: 'unanswered',
    exerciseOptions: exercise.options.map(
      ({ text }, index) => `${String.fromCharCode(65 + index)}. ${text}`,
    ),
  });
  expect(tutorInput).not.toHaveProperty('options');
  expect(tutorInput).not.toHaveProperty('correct');
  expect(tutorInput).not.toHaveProperty('feedback');
  expect(JSON.stringify(optionInput)).not.toContain('correct');
  for (const option of exercise.options) {
    if (option.feedback) expect(JSON.stringify(tutorInput)).not.toContain(option.feedback);
  }
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
  const displayedAnswer =
    exercise.type === 'mc'
      ? (exercise.options.find((option) => option.id === 'a')?.text ?? 'a')
      : 'a';
  expect(captured.at(-1)?.learnerAnswer).toBe(displayedAnswer);
  expect(captured.at(-1)?.graderVerdict).toBe('incorrect');
});

test('null-concept practice activity uses its exercise concept in new and existing threads', async () => {
  const exercise = content.exercisesById.get('slp-input-target');
  if (!exercise) throw new Error('Missing supervised-learning practice exercise');
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
      conceptId: null,
      exerciseIds: [exercise.id],
      plannedMinutes: 5,
      status: 'in_progress',
    })
    .returning();
  if (!activity) throw new Error('Expected a practice activity');
  const context = { conceptId: null, activityId: activity.id, exerciseId: exercise.id };

  const created = await send('Help with this exercise', undefined, context);
  expect(created.status).toBe(200);
  const createdPayload = await created.json();
  expect(createdPayload.thread.conceptId).toBe(exercise.concept);
  const expectedConceptTitle = content.conceptsById.get(exercise.concept)?.title;
  expect(expectedConceptTitle).toBeDefined();
  expect(captured.at(-1)).toMatchObject({
    conceptTitle: expectedConceptTitle,
    exercisePrompt: exercise.prompt,
  });

  const replied = await send('Can you explain the target?', createdPayload.thread.id, context);
  expect(replied.status).toBe(200);
  expect(captured.at(-1)).toMatchObject({
    conceptTitle: expectedConceptTitle,
    exercisePrompt: exercise.prompt,
  });
});

test('session page context uses the answered lesson problem KP and sanitized authored text', async () => {
  const lesson = content.lessonsByConcept.get('derivatives');
  const points = lesson?.knowledge_points ?? [];
  const firstPoint = points[0];
  const otherPoint = points[1];
  if (!lesson || !firstPoint || !otherPoint) {
    throw new Error('Expected the Derivatives knowledge-point lesson');
  }

  const started = await startLessonRun('derivatives');
  expect(started.status).toBe(200);
  const runPayload = await started.json();
  const problem = runPayload.run.pending;
  if (!problem) throw new Error('Expected a pending Derivatives lesson problem');
  const exercise = concreteExercise(problem.exerciseId, problem.seed);

  const beforeAnswer = await send('Explain this step', undefined, {
    lessonProblemId: problem.id,
    page: 'session',
    knowledgePointId: otherPoint.id,
  });
  expect(beforeAnswer.status).toBe(200);
  const initialContext = captured.at(-1);
  const pageContent = initialContext?.page_content ?? '';
  expect(initialContext?.page).toBe('session');
  expect(pageContent).toContain(lesson.where_this_fits);
  expect(pageContent).toContain(`Current step (1 of ${points.length}): ${firstPoint.title}`);
  expect(pageContent).toContain(sanitizePageContent(firstPoint.explain));
  expect(pageContent).toContain(firstPoint.worked);
  expect(pageContent).not.toContain(otherPoint.explain);
  expect(pageContent).toContain('[diagram]');
  expect(pageContent).not.toContain('```svg');
  if ('solution' in exercise && exercise.solution) {
    expect(pageContent).not.toContain(exercise.solution);
  }
  expect(initialContext?.learnerAnswer).toBe('');
  expect(initialContext?.graderVerdict).toBe('');

  const answer = correctAnswer(problem.exerciseId, problem.seed);
  expect((await answerLessonProblem('derivatives', problem.id, answer)).status).toBe(200);
  const afterAnswer = await send('Why was my answer right?', undefined, {
    lessonProblemId: problem.id,
    page: 'session',
  });
  expect(afterAnswer.status).toBe(200);
  const answeredContext = captured.at(-1);
  expect(answeredContext?.learnerAnswer).toBe(
    answerDisplay(exercise as Parameters<typeof answerDisplay>[0], answer),
  );
  expect(answeredContext?.graderVerdict).toBe('correct');
});

test('full lesson page includes every knowledge point and the summary', async () => {
  const lesson = content.lessonsByConcept.get('derivatives');
  if (!lesson?.knowledge_points?.length) throw new Error('Missing Derivatives lesson');
  expect(
    (
      await send('Explain this lesson', undefined, {
        conceptId: 'derivatives',
        page: 'lesson',
      })
    ).status,
  ).toBe(200);
  const pageContent = captured.at(-1)?.page_content ?? '';
  for (const point of lesson.knowledge_points) {
    expect(pageContent).toContain(`## ${point.title}`);
  }
  const summary = lesson.blocks.find((block) => block.kind === 'summary')?.md;
  expect(summary).toBeTruthy();
  expect(pageContent).toContain(summary ?? '');
});

test('map page context uses the current concept instead of the thread concept', async () => {
  const first = await send('Start with supervised learning', undefined, {
    conceptId: 'supervised-learning',
  });
  const threadId = (await first.json()).thread.id as string;
  expect(
    (
      await send('What is this topic?', threadId, {
        conceptId: 'derivatives',
        page: 'map',
      })
    ).status,
  ).toBe(200);
  const pageContent = captured.at(-1)?.page_content ?? '';
  expect(captured.at(-1)?.conceptTitle).toBe(content.conceptsById.get('derivatives')?.title);
  expect(pageContent).toContain('# Derivatives');
  const objective = content.conceptsById.get('derivatives')?.objectives[0]?.text;
  expect(objective).toBeTruthy();
  expect(pageContent).toContain(objective ?? '');

  expect((await send('Show the map', threadId, { page: 'map' })).status).toBe(200);
  expect(captured.at(-1)?.page_content).toBe('');
});

test('course page context includes outline topics and statuses', async () => {
  expect((await send('What should I study next?', undefined, { page: 'course' })).status).toBe(200);
  const pageContent = captured.at(-1)?.page_content ?? '';
  expect(pageContent).toMatch(/^## Week \d+ · .+$/m);
  expect(pageContent).toContain(
    "You'll build the simplest model that learns: predicting a house's price from its measurements, trained on past sales. The maths topics are the tools this model needs, taught in the order it needs them.",
  );
  expect(pageContent).toMatch(/^- .+ — .+$/m);
});

test('invalid knowledge-point IDs are ignored and client page text is never accepted', async () => {
  expect(
    (
      await send('Help me with this session', undefined, {
        conceptId: 'derivatives',
        page: 'session',
        knowledgePointId: 'not-a-real-point',
        page_content: 'client supplied text',
      })
    ).status,
  ).toBe(200);
  const pageContent = captured.at(-1)?.page_content ?? '';
  expect(pageContent).toContain('# Derivatives');
  expect(pageContent).toContain('## Summary');
  expect(pageContent).not.toContain('Current step');
  expect(pageContent).not.toContain('client supplied text');
});

test('requests without a page have empty page context', async () => {
  expect(
    (await send('A general question', undefined, { page_content: 'not trusted' })).status,
  ).toBe(200);
  expect(captured.at(-1)?.page).toBe('none');
  expect(captured.at(-1)?.page_content).toBe('');
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

test('tutor request body accepts long questions up to the limit', () => {
  expect(
    tutorThreadBodySchema.safeParse({ question: 'a'.repeat(TUTOR_QUESTION_MAX_LENGTH) }).success,
  ).toBe(true);
  expect(
    tutorThreadBodySchema.safeParse({ question: 'a'.repeat(TUTOR_QUESTION_MAX_LENGTH + 1) })
      .success,
  ).toBe(false);
});

test('a too-long tutor question says it is too long', async () => {
  const response = await send('a'.repeat(TUTOR_QUESTION_MAX_LENGTH + 1));
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: tutorQuestionTooLongMessage() });
});
