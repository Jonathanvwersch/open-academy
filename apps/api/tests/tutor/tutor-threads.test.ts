import { serializedOptionOrder } from '@academy/aesop/course/serialize';
import { instantiateExercise, isTemplate } from '@academy/aesop/course/templates';
import type { ContentIndex } from '@academy/aesop/course/types';
import { answerDisplay } from '@academy/aesop/lessons/answer-display';
import { onScreenOptions } from '@academy/shared/shuffle';
import { TUTOR_QUESTION_MAX_LENGTH, tutorQuestionTooLongMessage } from '@academy/shared/tutor';
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { createApp } from '../../src/app.js';
import { env } from '../../src/config.js';
import { loadContent } from '../../src/content/load.js';
import { createDb } from '../../src/db/client.js';
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
} from '../../src/db/schema.js';
import { sanitizePageContent } from '../../src/features/tutor/page-context.js';
import type { TutorProvider, TutorResult } from '../../src/features/tutor/provider.js';
import { tutorThreadBodySchema } from '../../src/features/tutor/routes.js';
import type {
  ExplanationContext,
  RubricJudgement,
  TutorContext,
  TutorReply,
} from '../../src/features/tutor/schemas.js';

const db = createDb(env.TEST_DATABASE_URL);
const userId = '00000000-0000-4000-8000-000000000093';
const headers = { 'content-type': 'application/json', 'X-Now': '2026-01-04T12:00:00.000Z' };
let content: ContentIndex;
let captured: TutorContext[] = [];
let failing = false;
let respondWith: TutorProvider['respond'] | undefined;
let explanationGrade: RubricJudgement = { criteria: [], feedback_md: '' };

const provider: TutorProvider = {
  model: 'thread-test',
  async respond(ctx, level, providerContent, signal): Promise<TutorResult<TutorReply>> {
    captured.push(ctx);
    if (respondWith) return respondWith(ctx, level, providerContent, signal);
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
    return { value: explanationGrade, usage: null };
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
  respondWith = undefined;
  explanationGrade = { criteria: [], feedback_md: '' };
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

async function send(
  question: string,
  threadId?: string,
  extra: Record<string, unknown> = {},
  signal?: AbortSignal,
) {
  return app.request(threadId ? `/api/tutor/threads/${threadId}/messages` : '/api/tutor/threads', {
    method: 'POST',
    headers,
    body: JSON.stringify({ question, ...extra }),
    signal,
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function tutorReply(message: string): TutorResult<TutorReply> {
  return {
    value: { message_md: message, misconception: null, suggests_review_of: [] },
    usage: null,
  };
}

test('tutor availability needs neither curriculum loading nor a provider call', async () => {
  const target = createApp({ db, tutorProvider: provider });
  const response = await target.request('/api/tutor/status');
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ tutorEnabled: true });
  expect(captured).toEqual([]);
  const disabled = await createApp({ db, tutorProvider: null }).request('/api/tutor/status');
  expect(await disabled.json()).toEqual({ tutorEnabled: false });
});

test('tutor request body normalizes null optional context fields', () => {
  const parsed = tutorThreadBodySchema.parse({
    question: 'Help me understand this practice question.',
    threadId: null,
    conceptId: null,
    activityId: null,
    exerciseId: null,
    lessonProblemId: null,
    page: null,
    knowledgePointId: null,
    lessonStage: null,
    paperId: null,
    pageNumber: null,
    selection: null,
  });

  expect(parsed.question).toBe('Help me understand this practice question.');
  for (const key of [
    'conceptId',
    'threadId',
    'activityId',
    'exerciseId',
    'lessonProblemId',
    'page',
    'knowledgePointId',
    'lessonStage',
    'paperId',
    'pageNumber',
    'selection',
  ] as const) {
    expect(parsed[key]).toBeUndefined();
  }
  expect(
    tutorThreadBodySchema.parse({
      question: 'Help me with this question.',
      questionLabel: '  Question 4  ',
    }).questionLabel,
  ).toBe('Question 4');
  expect(
    tutorThreadBodySchema.safeParse({
      question: 'Help me with this question.',
      questionLabel: 'q'.repeat(61),
    }).success,
  ).toBe(false);
  expect(
    tutorThreadBodySchema.safeParse({
      question: 'Help me with this question.',
      questionLabel: null,
    }).success,
  ).toBe(false);
  expect(
    tutorThreadBodySchema.parse({
      question: 'Help me with this question.',
      lessonStage: 'explain',
    }).lessonStage,
  ).toBe('explain');
  expect(
    tutorThreadBodySchema.safeParse({
      question: 'Help me with this question.',
      lessonStage: 'summary',
    }).success,
  ).toBe(false);
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

async function createExerciseActivity(exerciseId: string) {
  const exercise = content.exercisesById.get(exerciseId);
  if (!exercise) throw new Error(`Missing exercise ${exerciseId}`);
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
      kind: 'learn',
      conceptId: exercise.concept,
      exerciseIds: [exercise.id],
      plannedMinutes: 5,
      status: 'in_progress',
    })
    .returning();
  if (!activity) throw new Error('Expected an activity');
  return { exercise, activity, session };
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

test('saves earlier and main client messages in order and returns their client IDs', async () => {
  const threadId = '00000000-0000-4000-8000-000000000111';
  const earlierId = '00000000-0000-4000-8000-000000000112';
  const mainId = '00000000-0000-4000-8000-000000000113';

  const response = await send('second question', undefined, {
    threadId,
    clientMessageId: mainId,
    earlier: [{ clientMessageId: earlierId, question: 'first question' }],
  });
  expect(response.status).toBe(200);
  const payload = await response.json();
  expect(payload.messages.map((message: { clientId: string | null }) => message.clientId)).toEqual([
    earlierId,
    mainId,
    null,
  ]);
  expect(captured.at(-1)?.history).toEqual([{ role: 'learner', content: 'first question' }]);

  const detail = await (await app.request(`/api/tutor/threads/${threadId}`, { headers })).json();
  expect(
    detail.messages.map((message: { content: string; clientId: string | null }) => [
      message.content,
      message.clientId,
    ]),
  ).toEqual([
    ['first question', earlierId],
    ['second question', mainId],
    ['Tutor reply to: second question', null],
  ]);
  expect(
    detail.messages
      .map((message: { createdAt: string }) => Date.parse(message.createdAt))
      .every((createdAt: number, index: number, values: number[]) => {
        const previous = values[index - 1];
        return index === 0 || (previous !== undefined && createdAt > previous);
      }),
  ).toBe(true);
});

test('adopting an earlier question links it to the exercise for assistance tracking', async () => {
  const earlierClientMessageId = '00000000-0000-4000-8000-000000000124';
  const mainClientMessageId = '00000000-0000-4000-8000-000000000125';
  const { activity } = await createExerciseActivity('slp-input-target');
  const start = await app.request('/api/lessons/supervised-learning/run', {
    method: 'POST',
    headers,
    body: JSON.stringify({ activityId: activity.id }),
  });
  expect(start.status).toBe(200);
  const run = (await start.json()).run;
  const pending = run.pending;
  if (!pending?.id) throw new Error('Expected a pending supervised-learning problem');

  const firstResponse = await send('follow-up question', undefined, {
    clientMessageId: mainClientMessageId,
    earlier: [{ clientMessageId: earlierClientMessageId, question: 'earlier question' }],
  });
  expect(firstResponse.status).toBe(200);
  const threadId = (await firstResponse.json()).thread.id as string;
  const [earlierBeforeRetry] = await db
    .select({
      activityId: tutorMessages.activityId,
      exerciseId: tutorMessages.exerciseId,
      lessonProblemId: tutorMessages.lessonProblemId,
    })
    .from(tutorMessages)
    .where(
      and(eq(tutorMessages.threadId, threadId), eq(tutorMessages.clientId, earlierClientMessageId)),
    );
  expect(earlierBeforeRetry).toEqual({
    activityId: null,
    exerciseId: null,
    lessonProblemId: null,
  });

  const retry = await send('earlier question', threadId, {
    clientMessageId: earlierClientMessageId,
    activityId: activity.id,
    exerciseId: pending.exerciseId,
    lessonProblemId: pending.id,
  });
  expect(retry.status).toBe(200);
  expect(await retry.json()).toMatchObject({ superseded: true });
  const [earlierAfterRetry] = await db
    .select({
      activityId: tutorMessages.activityId,
      exerciseId: tutorMessages.exerciseId,
      lessonProblemId: tutorMessages.lessonProblemId,
    })
    .from(tutorMessages)
    .where(
      and(eq(tutorMessages.threadId, threadId), eq(tutorMessages.clientId, earlierClientMessageId)),
    );
  expect(earlierAfterRetry).toEqual({
    activityId: activity.id,
    exerciseId: pending.exerciseId,
    lessonProblemId: pending.id,
  });

  const answerResponse = await app.request('/api/lessons/supervised-learning/run/answer', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      problemId: pending.id,
      activityId: activity.id,
      answer: correctAnswer(pending.exerciseId, pending.seed),
    }),
  });
  expect(answerResponse.status).toBe(200);
  const answerBody = await answerResponse.json();
  expect(answerBody).not.toHaveProperty('assisted');
  const [answeredProblem] = await db
    .select()
    .from(lessonProblems)
    .where(eq(lessonProblems.id, pending.id));
  const [answeredAttempt] = await db
    .select()
    .from(attempts)
    .where(eq(attempts.id, answeredProblem?.attemptId ?? ''));
  expect(answeredAttempt).toMatchObject({ hintsUsed: 0, credit: 1 });
});

test('does not save a stale reply after a newer learner message and keeps unanswered history', async () => {
  const firstStarted = deferred<boolean>();
  const lateReply = deferred<TutorResult<TutorReply>>();
  respondWith = async (ctx) => {
    if (ctx.question === 'first') {
      firstStarted.resolve(true);
      return lateReply.promise;
    }
    return tutorReply(`Tutor reply to: ${ctx.question}`);
  };

  const firstRequest = send('first');
  await firstStarted.promise;
  const [thread] = await (await app.request('/api/tutor/threads', { headers })).json();
  const secondResponse = await send('second', thread.id);
  expect(secondResponse.status).toBe(200);
  expect(captured.at(-1)?.history).toEqual([{ role: 'learner', content: 'first' }]);

  lateReply.resolve(tutorReply('Late first reply'));
  const firstResponse = await firstRequest;
  expect(firstResponse.status).toBe(200);
  expect(await firstResponse.json()).toMatchObject({ superseded: true });

  const detail = await (await app.request(`/api/tutor/threads/${thread.id}`, { headers })).json();
  expect(
    detail.messages.map((message: { role: string; content: string }) => [
      message.role,
      message.content,
    ]),
  ).toEqual([
    ['user', 'first'],
    ['user', 'second'],
    ['assistant', 'Tutor reply to: second'],
  ]);
});

test('saves a learner message when an already-aborted request reaches the server', async () => {
  const controller = new AbortController();
  controller.abort();
  const clientMessageId = '00000000-0000-4000-8000-000000000114';

  const response = await send(
    'save this stopped question',
    undefined,
    { clientMessageId },
    controller.signal,
  );

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ superseded: true });
  expect(await db.select().from(tutorThreads)).toHaveLength(1);
  expect(await db.select().from(tutorMessages)).toMatchObject([
    { content: 'save this stopped question', clientId: clientMessageId },
  ]);
  expect(captured).toHaveLength(0);
});

test('keeps an aborted learner message and includes it in the next request history', async () => {
  const controller = new AbortController();
  const providerStarted = deferred<boolean>();
  respondWith = async (_ctx, _level, _content, signal) => {
    providerStarted.resolve(true);
    await new Promise<void>((resolve) => {
      if (signal?.aborted) resolve();
      else signal?.addEventListener('abort', () => resolve(), { once: true });
    });
    throw new DOMException('The operation was aborted.', 'AbortError');
  };

  const abortedRequest = send('show me the derivation', undefined, {}, controller.signal);
  await providerStarted.promise;
  const [thread] = await (await app.request('/api/tutor/threads', { headers })).json();
  controller.abort();
  const response = await abortedRequest;
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ superseded: true });

  const detail = await (await app.request(`/api/tutor/threads/${thread.id}`, { headers })).json();
  expect(
    detail.messages.map((message: { role: string; content: string }) => [
      message.role,
      message.content,
    ]),
  ).toEqual([['user', 'show me the derivation']]);

  respondWith = undefined;
  expect((await send('show every line', thread.id)).status).toBe(200);
  expect(captured.at(-1)?.history).toEqual([
    { role: 'learner', content: 'show me the derivation' },
  ]);
});

test('a late request for an earlier client message keeps one copy and does not replace the newer reply', async () => {
  const threadId = '00000000-0000-4000-8000-000000000115';
  const earlierId = '00000000-0000-4000-8000-000000000116';
  const mainId = '00000000-0000-4000-8000-000000000117';
  const mainStarted = deferred<boolean>();
  const releaseMain = deferred<TutorResult<TutorReply>>();
  respondWith = async (ctx) => {
    if (ctx.question === 'second') {
      mainStarted.resolve(true);
      return releaseMain.promise;
    }
    return tutorReply('Late first reply');
  };

  const mainRequest = send('second', undefined, {
    threadId,
    clientMessageId: mainId,
    earlier: [{ clientMessageId: earlierId, question: 'first' }],
  });
  await mainStarted.promise;
  const lateRequest = await send('first', threadId, { clientMessageId: earlierId });
  expect(await lateRequest.json()).toMatchObject({ superseded: true });
  releaseMain.resolve(tutorReply('Second reply'));
  expect((await mainRequest).status).toBe(200);

  const detail = await (await app.request(`/api/tutor/threads/${threadId}`, { headers })).json();
  expect(
    detail.messages.map((message: { role: string; content: string; clientId: string | null }) => [
      message.role,
      message.content,
      message.clientId,
    ]),
  ).toEqual([
    ['user', 'first', earlierId],
    ['user', 'second', mainId],
    ['assistant', 'Second reply', null],
  ]);
  expect(captured.find((ctx) => ctx.question === 'second')?.history).toEqual([
    { role: 'learner', content: 'first' },
  ]);
});

test('skips saving a reply when the request signal aborts before the provider returns', async () => {
  const controller = new AbortController();
  const providerStarted = deferred<boolean>();
  const releaseProvider = deferred<TutorResult<TutorReply>>();
  respondWith = async () => {
    providerStarted.resolve(true);
    return releaseProvider.promise;
  };

  const pendingRequest = send('explain the page', undefined, {}, controller.signal);
  await providerStarted.promise;
  const [thread] = await (await app.request('/api/tutor/threads', { headers })).json();
  controller.abort();
  releaseProvider.resolve(tutorReply('This reply must not be saved'));

  const response = await pendingRequest;
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ superseded: true });
  const detail = await (await app.request(`/api/tutor/threads/${thread.id}`, { headers })).json();
  expect(
    detail.messages.map((message: { role: string; content: string }) => [
      message.role,
      message.content,
    ]),
  ).toEqual([['user', 'explain the page']]);
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
  const problem = run.pending;
  const pending = problem.id;
  const exercise = concreteExercise(problem.exerciseId, problem.seed);
  expect(
    (
      await send('help', undefined, {
        lessonProblemId: pending,
        questionLabel: 'Question 4',
      })
    ).status,
  ).toBe(200);
  expect(captured.at(-1)).toMatchObject({
    solution: '',
    authoredHints: expect.any(Array),
    problem_status: 'unanswered',
    exerciseLabel: 'Question 4',
    exercisePrompt: exercise.prompt,
  });
  await db
    .update(lessonProblems)
    .set({ answeredAt: new Date(headers['X-Now']) })
    .where(eq(lessonProblems.id, pending));
  expect((await send('explain', undefined, { lessonProblemId: pending })).status).toBe(200);
  expect(captured.at(-1)?.problem_status).toBe('answered');
  expect(captured.at(-1)?.solution).not.toBe('');
});

test('unanswered multiple-choice lesson problems pass screen-ordered options to the tutor', async () => {
  const start = await app.request('/api/lessons/chain-rule/run', {
    method: 'POST',
    headers,
    body: JSON.stringify({}),
  });
  const run = (await start.json()).run;
  const pending = run.pendingProblem;
  if (!pending?.exercise) throw new Error('Expected a pending Chain rule lesson problem');
  const exercise = concreteExercise(pending.exerciseId, pending.seed);
  if (exercise.type !== 'mc') throw new Error('Expected a multiple-choice Chain rule problem');
  const serializedOptions = pending.exercise.options as Array<{ id: string; text: string }>;
  const displayedOptions = onScreenOptions(serializedOptions, pending.exercise.id);
  expect(displayedOptions.map(({ id }: { id: string }) => id)).not.toEqual(
    exercise.options.map((option) => option.id),
  );

  const response = await send('Help with this question', undefined, {
    lessonProblemId: pending.id,
  });
  expect(response.status).toBe(200);

  const tutorInput = captured.at(-1);
  const optionInput = tutorInput?.exerciseOptions ?? [];
  const optionsOnScreen = onScreenOptions(
    serializedOptionOrder(exercise.options, userId, exercise.id),
    exercise.id,
  );
  const answerKey = optionsOnScreen
    .flatMap((option, index) =>
      option.correct ? [`${String.fromCharCode(65 + index)}. ${option.text}`] : [],
    )
    .join('; ');
  expect(tutorInput).toMatchObject({
    problem_status: 'unanswered',
    exerciseOptions: displayedOptions.map(
      ({ text }, index) => `${String.fromCharCode(65 + index)}. ${text}`,
    ),
    answerKey,
  });
  expect(tutorInput).not.toHaveProperty('options');
  expect(tutorInput).not.toHaveProperty('correct');
  expect(tutorInput).not.toHaveProperty('feedback');
  expect(JSON.stringify(optionInput)).not.toContain('correct');
  for (const option of exercise.options) {
    if (option.feedback) expect(JSON.stringify(tutorInput)).not.toContain(option.feedback);
  }
});

test('seeded numeric lesson problems give the tutor the resolved answer key', async () => {
  const template = content.exercisesById.get('it-surprise-template');
  if (!template || !isTemplate(template)) throw new Error('Missing information theory template');
  const defaultAnswer = instantiateExercise(template, 0).exercise.answer;
  const seed = Array.from({ length: 100 }, (_, index) => index + 1).find(
    (candidate) => instantiateExercise(template, candidate).exercise.answer !== defaultAnswer,
  );
  if (seed === undefined) throw new Error('Expected a seed with a different template answer');

  const start = await startLessonRun('information-theory');
  const run = (await start.json()).run;
  const pending = run.pendingProblem ?? run.pending;
  if (!pending?.id) throw new Error('Expected a pending information theory lesson problem');
  await db
    .update(lessonProblems)
    .set({ exerciseId: template.id, seed })
    .where(eq(lessonProblems.id, pending.id));

  const exercise = concreteExercise(template.id, seed);
  if (exercise.type !== 'numeric') throw new Error('Expected a concrete numeric exercise');
  const response = await send('Help with this question', undefined, {
    lessonProblemId: pending.id,
    questionLabel: 'Question 3',
  });
  expect(response.status).toBe(200);
  expect(captured.at(-1)).toMatchObject({
    problem_status: 'unanswered',
    exercisePrompt: exercise.prompt,
    answerKey: String(exercise.answer),
  });
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
  // Match the API's default learner selection; an unordered scan can pick the other learner.
  const [authenticatedUser] = await db
    .select()
    .from(users)
    .orderBy(asc(users.createdAt), asc(users.id))
    .limit(1);
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
  expect(captured.at(-1)?.exerciseLabel).toBe('Current question');

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
  expect(captured.at(-1)?.problem_status).toBe('retrying');
  expect(captured.at(-1)?.solution).toBe('');
  expect(captured.at(-1)?.graderFeedback).toContain('The learner has one more try.');
  const displayedAnswer =
    exercise.type === 'mc'
      ? (exercise.options.find((option) => option.id === 'a')?.text ?? 'a')
      : 'a';
  expect(captured.at(-1)?.learnerAnswer).toBe(displayedAnswer);
  expect(captured.at(-1)?.graderVerdict).toBe('incorrect');
});

test('session explain context exposes partial grader feedback until the retry is used', async () => {
  const { exercise, activity } = await createExerciseActivity('mlp-explain');
  if (exercise.type !== 'explain') throw new Error('Expected an explanation exercise');
  explanationGrade = {
    criteria: exercise.rubric.map((criterion, index) => ({
      id: criterion.id,
      judgement: criterion.required ? (index === 0 ? 'met' : 'partial') : 'missing',
      evidence: criterion.required ? 'Describes part of the forward pass.' : null,
    })),
    feedback_md: 'Almost: clarify the batch shapes.',
  };
  const answer = 'The layers transform each input and then combine the batch.';
  const submit = (text: string) =>
    app.request('/api/attempts', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        exerciseId: exercise.id,
        activityId: activity.id,
        answer: { text },
        mode: 'practice',
      }),
    });

  expect(
    (
      await send('help before answering', undefined, {
        exerciseId: exercise.id,
        activityId: activity.id,
      })
    ).status,
  ).toBe(200);
  expect(captured.at(-1)).toMatchObject({ problem_status: 'unanswered', answerKey: '' });

  expect((await submit(answer)).status).toBe(200);
  expect(
    (
      await send('Can you see the almost statement?', undefined, {
        exerciseId: exercise.id,
        activityId: activity.id,
      })
    ).status,
  ).toBe(200);
  const retrying = captured.at(-1);
  const judgements = new Map(explanationGrade.criteria.map((item) => [item.id, item.judgement]));
  const criteria = exercise.rubric.map((criterion) => {
    const judgement = judgements.get(criterion.id);
    const marker = judgement === 'met' ? '✓' : judgement === 'partial' ? '½' : '✗';
    return `${marker} ${criterion.criterion}`;
  });
  expect(retrying).toMatchObject({
    problem_status: 'retrying',
    answerKey: '',
    learnerAnswer: answer,
    graderVerdict: 'partly correct',
    solution: '',
    authoredHints: exercise.hints ?? [],
    graderFeedback: [
      'Almost: clarify the batch shapes.',
      ...criteria,
      'The learner has one more try.',
    ].join('\n'),
  });

  explanationGrade = {
    criteria: exercise.rubric.map((criterion) => ({
      id: criterion.id,
      judgement: 'met',
      evidence: 'covered',
    })),
    feedback_md: 'Complete explanation.',
  };
  const secondAnswer = 'Each layer preserves the batch rows and transforms the feature width.';
  expect((await submit(secondAnswer)).status).toBe(200);
  expect(
    (
      await send('What did I miss?', undefined, {
        exerciseId: exercise.id,
        activityId: activity.id,
      })
    ).status,
  ).toBe(200);
  expect(captured.at(-1)).toMatchObject({
    problem_status: 'answered',
    answerKey: '',
    learnerAnswer: secondAnswer,
    graderVerdict: 'correct',
  });
  expect(captured.at(-1)?.solution).toBeTruthy();
  expect(captured.at(-1)?.graderFeedback).not.toContain('one more try');
});

test('session MC context keeps a wrong first practice answer retryable', async () => {
  const { exercise, activity } = await createExerciseActivity('sl-check-target');
  if (exercise.type !== 'mc') throw new Error('Expected a multiple-choice exercise');
  const wrong = exercise.options.find((option) => !option.correct);
  const correct = exercise.options.find((option) => option.correct);
  if (!wrong || !correct) throw new Error('Expected correct and incorrect options');
  const submit = (answer: string) =>
    app.request('/api/attempts', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        exerciseId: exercise.id,
        activityId: activity.id,
        answer,
        mode: 'practice',
      }),
    });

  expect((await submit(wrong.id)).status).toBe(200);
  expect(
    (
      await send('What should I reconsider?', undefined, {
        exerciseId: exercise.id,
        activityId: activity.id,
      })
    ).status,
  ).toBe(200);
  expect(captured.at(-1)).toMatchObject({
    problem_status: 'retrying',
    graderVerdict: 'incorrect',
    solution: '',
  });
  expect(captured.at(-1)?.graderFeedback).toContain('The learner has one more try.');

  expect((await submit(correct.id)).status).toBe(200);
  expect(
    (
      await send('What does the solution show?', undefined, {
        exerciseId: exercise.id,
        activityId: activity.id,
      })
    ).status,
  ).toBe(200);
  expect(captured.at(-1)?.problem_status).toBe('answered');
  expect(captured.at(-1)?.solution).toBeTruthy();
  expect(captured.at(-1)?.graderFeedback).not.toContain('one more try');
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
  expect(pageContent).toContain(
    '[diagram: The curve d equals t squared, the distance in metres a car has driven after t seconds. An orange straight line joins the points at t equals 3 and t equals 4 with slope 7, the average speed over that second. A blue line just touches the curve at t equals 3 with slope 6, the speed at that instant]',
  );
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
  expect(pageContent).toMatch(/^## Unit \d+ · .+$/m);
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
  expect(captured.at(-1)?.exerciseLabel).toBe('');
});

test('activation-functions final exercise receives its visible question label', async () => {
  const lesson = content.lessonsByConcept.get('activation-functions');
  const exercise = content.exercisesById.get('act-explain-layers');
  if (lesson?.final !== 'act-explain-layers' || exercise?.type !== 'explain') {
    throw new Error('Missing activation-functions final explain exercise');
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
      kind: 'learn',
      conceptId: 'activation-functions',
      exerciseIds: [exercise.id],
      plannedMinutes: 5,
      status: 'in_progress',
    })
    .returning();
  if (!activity) throw new Error('Expected a learn activity');

  expect(
    (
      await send('Help with the final question', undefined, {
        activityId: activity.id,
        exerciseId: exercise.id,
        questionLabel: 'Explain it',
      })
    ).status,
  ).toBe(200);
  expect(captured.at(-1)).toMatchObject({
    exercisePrompt: exercise.prompt,
    exerciseLabel: 'Explain it',
    problem_status: 'unanswered',
  });
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

test('provider failure removes a new learner message and thread; another user cannot read a thread', async () => {
  const llmCallsBefore = await db.select().from(llmCalls);
  failing = true;
  expect((await send('fail')).status).toBe(503);
  expect(await db.select().from(tutorThreads)).toHaveLength(0);
  expect(await db.select().from(tutorMessages)).toHaveLength(0);
  const callsAfter = await db.select().from(llmCalls);
  expect(callsAfter).toHaveLength(llmCallsBefore.length + 1);
  const previousIds = new Set(llmCallsBefore.map((call) => call.id));
  expect(callsAfter.filter((call) => !previousIds.has(call.id))).toMatchObject([
    { status: 'fallback' },
  ]);
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

test('provider failure after earlier messages removes only the main learner message', async () => {
  const threadId = '00000000-0000-4000-8000-000000000118';
  const earlierId = '00000000-0000-4000-8000-000000000119';
  const mainId = '00000000-0000-4000-8000-000000000120';
  failing = true;

  const response = await send('failed main question', undefined, {
    threadId,
    clientMessageId: mainId,
    earlier: [{ clientMessageId: earlierId, question: 'saved earlier question' }],
  });

  expect(response.status).toBe(503);
  expect(await db.select().from(tutorThreads)).toHaveLength(1);
  expect(
    await db
      .select({
        role: tutorMessages.role,
        content: tutorMessages.content,
        clientId: tutorMessages.clientId,
      })
      .from(tutorMessages)
      .where(eq(tutorMessages.threadId, threadId)),
  ).toEqual([{ role: 'user', content: 'saved earlier question', clientId: earlierId }]);
});

test('provider failure keeps a learner message that a later reply builds on', async () => {
  const firstClientMessageId = '00000000-0000-4000-8000-000000000122';
  const laterClientMessageId = '00000000-0000-4000-8000-000000000123';
  const firstProviderStarted = deferred<boolean>();
  const releaseFirstProvider = deferred<void>();
  respondWith = async (ctx) => {
    if (ctx.question === 'first question') {
      firstProviderStarted.resolve(true);
      await releaseFirstProvider.promise;
      throw new Error('provider offline');
    }
    return tutorReply('Reply to later question');
  };

  const firstRequest = send('first question', undefined, {
    clientMessageId: firstClientMessageId,
  });
  await firstProviderStarted.promise;
  const [thread] = await db.select({ id: tutorThreads.id }).from(tutorThreads);
  if (!thread) throw new Error('Expected the first request to create a thread');

  try {
    const laterResponse = await send('later question', thread.id, {
      clientMessageId: laterClientMessageId,
      earlier: [{ clientMessageId: firstClientMessageId, question: 'first question' }],
    });
    expect(laterResponse.status).toBe(200);
    expect(captured.find((ctx) => ctx.question === 'later question')?.history).toEqual([
      { role: 'learner', content: 'first question' },
    ]);

    releaseFirstProvider.resolve();
    expect((await firstRequest).status).toBe(503);
    const detail = await (await app.request(`/api/tutor/threads/${thread.id}`, { headers })).json();
    expect(
      detail.messages.map((message: { role: string; content: string; clientId: string | null }) => [
        message.role,
        message.content,
        message.clientId,
      ]),
    ).toEqual([
      ['user', 'first question', firstClientMessageId],
      ['user', 'later question', laterClientMessageId],
      ['assistant', 'Reply to later question', null],
    ]);
  } finally {
    releaseFirstProvider.resolve();
  }
});

test('provider failure in an existing thread removes only the failed learner message', async () => {
  const created = await send('keep this message');
  expect(created.status).toBe(200);
  const threadId = (await created.json()).thread.id as string;
  const originalMessages = await db
    .select()
    .from(tutorMessages)
    .where(eq(tutorMessages.threadId, threadId))
    .orderBy(tutorMessages.seq);
  const [originalThread] = await db
    .select()
    .from(tutorThreads)
    .where(eq(tutorThreads.id, threadId));

  failing = true;
  expect((await send('do not keep this failed message', threadId)).status).toBe(503);

  expect(
    await db
      .select()
      .from(tutorMessages)
      .where(eq(tutorMessages.threadId, threadId))
      .orderBy(tutorMessages.seq),
  ).toEqual(originalMessages);
  const [threadAfterFailure] = await db
    .select()
    .from(tutorThreads)
    .where(eq(tutorThreads.id, threadId));
  expect(threadAfterFailure?.updatedAt).toEqual(originalThread?.updatedAt);
});

test('a failed retry with an existing client ID keeps one saved learner message', async () => {
  const clientMessageId = '00000000-0000-4000-8000-000000000121';
  const controller = new AbortController();
  const providerStarted = deferred<boolean>();
  respondWith = async (_ctx, _level, _content, signal) => {
    providerStarted.resolve(true);
    await new Promise<void>((resolve) => {
      if (signal?.aborted) resolve();
      else signal?.addEventListener('abort', () => resolve(), { once: true });
    });
    throw new DOMException('The operation was aborted.', 'AbortError');
  };

  const firstRequest = send(
    'retry this question',
    undefined,
    { clientMessageId },
    controller.signal,
  );
  await providerStarted.promise;
  controller.abort();
  const firstResponse = await firstRequest;
  const threadId = (await firstResponse.json()).thread.id as string;
  respondWith = undefined;

  failing = true;
  expect((await send('retry this question', threadId, { clientMessageId })).status).toBe(503);
  expect(
    await db
      .select({ id: tutorMessages.id, clientId: tutorMessages.clientId })
      .from(tutorMessages)
      .where(eq(tutorMessages.threadId, threadId)),
  ).toMatchObject([{ clientId: clientMessageId }]);

  failing = false;
  expect((await send('retry this question', threadId, { clientMessageId })).status).toBe(200);
  const messages = await db
    .select({ role: tutorMessages.role, clientId: tutorMessages.clientId })
    .from(tutorMessages)
    .where(eq(tutorMessages.threadId, threadId))
    .orderBy(asc(tutorMessages.seq));
  expect(messages).toHaveLength(2);
  expect(messages).toEqual([
    { role: 'user', clientId: clientMessageId },
    { role: 'assistant', clientId: null },
  ]);
});

test('placement exercises and review activities are forbidden', async () => {
  const placementExercise = content.exercises.find((item) => item.role === 'diagnostic');
  const regular = content.exercisesById.get('sl-check-target');
  if (!placementExercise || !regular) throw new Error('Missing guard test exercises');
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
        conceptId: placementExercise.concept,
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
      await send('placement help', undefined, {
        exerciseId: placementExercise.id,
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
