import { expect, test } from '@playwright/test';
import { env } from '../../apps/api/src/config.js';
import { createDb } from '../../apps/api/src/db/client.js';
import {
  lessonProblems,
  lessonRuns,
  sessionActivities,
  studySessions,
  users,
} from '../../apps/api/src/db/schema.js';
import { enrollInDefaultCourse } from './course-start.js';

const db = createDb(env.TEST_DATABASE_URL);
let userId = '';

test.beforeEach(async () => {
  await db.delete(users);
  const [user] = await db
    .insert(users)
    .values({
      displayName: 'Lesson step navigation learner',
      timezone: 'UTC',
      startDate: '2026-01-01',
    })
    .returning();
  if (!user) throw new Error('Could not create learner');
  userId = user.id;
  await enrollInDefaultCourse(db, userId);
});

test.afterAll(async () => {
  await db.$client.end();
});

async function createLessonSession({
  stepsPassed,
  explainDone = false,
  explainActive = false,
}: {
  stepsPassed: boolean;
  explainDone?: boolean;
  explainActive?: boolean;
}) {
  const [session] = await db
    .insert(studySessions)
    .values({
      userId,
      status: 'active',
      plannedMinutes: 30,
      startedAt: new Date('2026-01-01T12:00:00Z'),
    })
    .returning();
  if (!session) throw new Error('Could not create session');
  await db.insert(sessionActivities).values({
    sessionId: session.id,
    idx: 0,
    kind: 'learn',
    conceptId: 'vectors',
    exerciseIds: ['vectors-fixture-final'],
    status: 'in_progress',
    plannedMinutes: 30,
    progress: explainDone
      ? {
          lessonRunnerContinued: true,
          finalQuestionContinued: true,
          completedExerciseIds: ['vectors-fixture-final'],
        }
      : explainActive
        ? { lessonRunnerContinued: true, finalQuestionContinued: true }
        : {},
  });
  const [run] = await db
    .insert(lessonRuns)
    .values({ userId, conceptId: 'vectors', status: stepsPassed ? 'quiz' : 'in_progress' })
    .returning();
  if (!run) throw new Error('Could not create run');
  if (stepsPassed) {
    await db.insert(lessonProblems).values(
      [
        {
          point: 'vectors-fixture-1',
          exercises: ['vectors-fixture-1-basics', 'vectors-fixture-practice-1'],
        },
        {
          point: 'vectors-fixture-2',
          exercises: ['vectors-fixture-2-basics', 'vectors-fixture-practice-4'],
        },
      ].flatMap(({ point, exercises }, pointIndex) =>
        exercises.map((exerciseId, index) => ({
          runId: run.id,
          knowledgePointId: point,
          exerciseId,
          round: 1,
          position: index + 1,
          correct: 1,
          answeredAt: new Date(`2026-01-01T12:00:0${pointIndex * 2 + index}Z`),
        })),
      ),
    );
  }
  if (!stepsPassed) {
    await db.insert(lessonProblems).values({
      runId: run.id,
      knowledgePointId: 'vectors-fixture-1',
      exerciseId: 'vectors-fixture-1-basics',
      round: 1,
      position: 1,
    });
  }
  return session.id;
}

test('completed lesson steps can be revisited during Explain it without losing the draft or changing progress', async ({
  page,
}) => {
  const sessionId = await createLessonSession({ stepsPassed: true });
  await page.goto(`/session/${sessionId}`);
  await expect(page.getByTestId('lesson-steps-complete')).toBeVisible();
  await expect(page.getByTestId('lesson-explain-chip')).toHaveAttribute(
    'aria-label',
    'Explain it, current',
  );
  await expect(page.getByTestId('lesson-quiz-chip')).toHaveAttribute(
    'aria-label',
    'Lesson quiz, upcoming',
  );
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByTestId('explain-memory-note')).toHaveCount(0);
  const draft = 'My explanation draft should survive a look at the earlier steps.';
  await page.getByLabel('Your answer').fill(draft);
  const changes: string[] = [];
  page.on('request', (request) => {
    if (request.method() !== 'GET' && request.url().includes('/api/')) changes.push(request.url());
  });
  await page.getByRole('button', { name: 'Step 1 of 2, passed' }).click();
  await expect(page.getByTestId('explain-step-recap')).toBeVisible();
  await expect(page.getByTestId('lesson-step-content')).toContainText(
    'A vector is an ordered list of coordinates',
  );
  await expect(page.getByRole('button', { name: 'Submit answer', exact: true })).toHaveCount(0);
  await page.screenshot({
    path: 'test-results/screenshots/lesson-step-navigation/recap-desktop.png',
  });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.getByRole('button', { name: 'Step 2 of 2, passed' }).click();
  await expect(page.getByTestId('lesson-step-content')).toContainText(
    'Vector operations combine coordinates',
  );
  await page.screenshot({
    path: 'test-results/screenshots/lesson-step-navigation/recap-mobile.png',
  });
  await page.getByRole('button', { name: 'Explain it', exact: true }).click();
  await expect(page.getByLabel('Your answer')).toHaveValue(draft);
  await expect(page.getByLabel('Your answer')).toBeEditable();
  await expect(page.getByTestId('lesson-quiz-chip')).toHaveAttribute(
    'aria-label',
    'Lesson quiz, upcoming',
  );
  await page.getByRole('button', { name: 'Step 1 of 2, passed' }).click();
  await page.getByRole('button', { name: 'Back to Explain it', exact: true }).click();
  await expect(page.getByLabel('Your answer')).toHaveValue(draft);
  expect(changes).toEqual([]);
});

test('Explain it step recaps follow the URL and set step tutor context', async ({ page }) => {
  const sessionId = await createLessonSession({ stepsPassed: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  let threadId = '';
  let messageCount = 0;
  const messages: Array<Record<string, unknown>> = [];
  const thread = () => ({
    id: threadId,
    conceptId: 'vectors',
    title: 'Explain step recap',
    updatedAt: '2026-01-01T12:00:00.000Z',
    conceptTitle: 'Vectors',
    messageCount: messages.length,
    lastMessagePreview: String(messages.at(-1)?.content ?? ''),
  });
  const detail = () => ({ thread: thread(), messages: [...messages] });
  await page.addInitScript(() => {
    localStorage.removeItem('academy.tutor.open');
    localStorage.removeItem('academy.tutor.thread');
  });
  await page.route('**/api/sessions/*', async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === 'GET' && url.pathname === `/api/sessions/${sessionId}`) {
      const response = await route.fetch();
      const payload = (await response.json()) as Record<string, unknown>;
      await route.fulfill({ response, json: { ...payload, tutorEnabled: true } });
      return;
    }
    await route.continue();
  });
  await page.route('**/api/tutor/status', (route) =>
    route.fulfill({ json: { tutorEnabled: true } }),
  );
  await page.route('**/api/tutor/threads**', async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as {
        question: string;
        threadId?: string;
        clientMessageId: string;
        lessonStage?: string;
      };
      if (body.lessonStage === 'explain') {
        const response = await route.fetch();
        const payload = (await response.json()) as { thread: { id: string } };
        threadId = payload.thread.id;
        await route.fulfill({ response, json: payload });
        return;
      }
      threadId = body.threadId ?? threadId;
      messageCount += 1;
      const userMessage = {
        id: `user-${messageCount}`,
        clientId: body.clientMessageId,
        role: 'user',
        content: body.question,
        createdAt: `2026-01-01T12:00:00.00${messageCount * 2 - 1}Z`,
      };
      const assistantMessage = {
        id: `assistant-${messageCount}`,
        clientId: null,
        role: 'assistant',
        content: `Tutor reply ${messageCount}`,
        createdAt: `2026-01-01T12:00:00.00${messageCount * 2}Z`,
      };
      messages.push(userMessage, assistantMessage);
      await route.fulfill({
        json: { thread: thread(), messages: [userMessage, assistantMessage] },
      });
      return;
    }
    if (url.pathname === '/api/tutor/threads') {
      await route.fulfill({ json: threadId ? [thread()] : [] });
      return;
    }
    if (threadId && url.pathname === `/api/tutor/threads/${threadId}`) {
      await route.fulfill({ json: detail() });
      return;
    }
    await route.continue();
  });

  await page.goto(`/session/${sessionId}?step=explain`);
  await expect(page.getByTestId('lesson-steps-complete')).toBeVisible();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByLabel('Your answer')).toBeVisible();
  await page.getByRole('button', { name: 'Step 1 of 2, passed' }).click();
  await expect(page).toHaveURL(/step=1/);
  await expect(page).toHaveURL(/activity=/);
  const recap = page.getByTestId('explain-step-recap');
  await expect(recap).toBeVisible();
  await expect(page.getByTestId('lesson-step-content')).toContainText(
    'A vector is an ordered list of coordinates',
  );
  await expect(page.getByTestId('lesson-explain-chip').getByRole('button')).toHaveText(
    'Explain it',
  );
  await page.screenshot({
    path: 'test-results/screenshots/lesson-step-navigation/explain-recap-url.png',
  });

  await page.getByRole('button', { name: 'Open tutor' }).click();
  const tutor = page.getByRole('complementary', { name: 'Tutor' });
  await tutor.getByRole('button', { name: 'New chat' }).click();
  const textarea = tutor.getByLabel('Ask the tutor');
  await textarea.fill('What does this step explain?');
  const requestPromise = page.waitForRequest(
    (request) => request.method() === 'POST' && request.url().includes('/api/tutor/threads'),
  );
  const responsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && response.url().includes('/api/tutor/threads'),
  );
  await textarea.press('Enter');
  const tutorRequest = await requestPromise;
  const tutorResponse = await responsePromise;
  expect(tutorResponse.status()).toBe(200);
  const tutorBody = tutorRequest.postDataJSON() as Record<string, unknown>;
  expect(tutorBody).toMatchObject({
    lessonStage: 'step',
    knowledgePointId: 'vectors-fixture-1',
  });
  expect(tutorBody).not.toHaveProperty('lessonProblemId');

  await page.reload();
  await expect(page).toHaveURL(/step=1/);
  await expect(recap).toBeVisible();
  await expect(page.getByTestId('lesson-step-content')).toContainText(
    'A vector is an ordered list of coordinates',
  );
  await page.getByRole('button', { name: 'Back to Explain it', exact: true }).click();
  await expect(page).toHaveURL(/step=explain/);
  await expect(page.getByLabel('Your answer')).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/step=1/);
  await expect(recap).toBeVisible();
  await page.getByTestId('lesson-explain-chip').getByRole('button').click();
  await expect(page).toHaveURL(/step=explain/);
  await expect(page.getByLabel('Your answer')).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/step=1/);
  await page.goForward();
  await expect(page).toHaveURL(/step=explain/);
});

test('lesson step tabs are restored from URL and invalid steps fall back', async ({ page }) => {
  const sessionId = await createLessonSession({ stepsPassed: true, explainActive: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  let threadId = '';
  let messageCount = 0;
  const messages: Array<Record<string, unknown>> = [];
  const thread = () => ({
    id: threadId,
    conceptId: 'vectors',
    title: 'Lesson stage context',
    updatedAt: '2026-01-01T12:00:00.000Z',
    conceptTitle: 'Vectors',
    messageCount: messages.length,
    lastMessagePreview: String(messages.at(-1)?.content ?? ''),
  });
  const detail = () => ({ thread: thread(), messages: [...messages] });
  await page.addInitScript(() => {
    localStorage.removeItem('academy.tutor.open');
    localStorage.removeItem('academy.tutor.thread');
  });
  await page.route('**/api/sessions/*', async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === 'GET' && url.pathname === `/api/sessions/${sessionId}`) {
      const response = await route.fetch();
      const payload = (await response.json()) as Record<string, unknown>;
      await route.fulfill({ response, json: { ...payload, tutorEnabled: true } });
      return;
    }
    await route.continue();
  });
  await page.route('**/api/tutor/status', (route) =>
    route.fulfill({ json: { tutorEnabled: true } }),
  );
  await page.route('**/api/tutor/threads**', async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as {
        question: string;
        threadId?: string;
        clientMessageId: string;
      };
      threadId = body.threadId ?? threadId;
      messageCount += 1;
      const userMessage = {
        id: `user-${messageCount}`,
        clientId: body.clientMessageId,
        role: 'user',
        content: body.question,
        createdAt: `2026-01-01T12:00:00.00${messageCount * 2 - 1}Z`,
      };
      const assistantMessage = {
        id: `assistant-${messageCount}`,
        clientId: null,
        role: 'assistant',
        content: `Tutor reply ${messageCount}`,
        createdAt: `2026-01-01T12:00:00.00${messageCount * 2}Z`,
      };
      messages.push(userMessage, assistantMessage);
      await route.fulfill({
        json: { thread: thread(), messages: [userMessage, assistantMessage] },
      });
      return;
    }
    if (url.pathname === '/api/tutor/threads') {
      await route.fulfill({ json: threadId ? [thread()] : [] });
      return;
    }
    if (threadId && url.pathname === `/api/tutor/threads/${threadId}`) {
      await route.fulfill({ json: detail() });
      return;
    }
    await route.continue();
  });
  await page.goto(`/session/${sessionId}?step=explain`);
  await expect(page.getByTestId('lesson-explain-chip')).toHaveAttribute(
    'aria-label',
    'Explain it, current',
  );
  await page.getByRole('button', { name: 'Open tutor' }).click();
  const tutor = page.getByRole('complementary', { name: 'Tutor' });
  await tutor.getByRole('button', { name: 'New chat' }).click();
  const textarea = tutor.getByLabel('Ask the tutor');
  await textarea.fill('What is this Explain it exercise asking?');
  const explainRequestPromise = page.waitForRequest(
    (request) => request.method() === 'POST' && request.url().includes('/api/tutor/threads'),
  );
  const explainResponsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && response.url().includes('/api/tutor/threads'),
  );
  await textarea.press('Enter');
  const explainRequest = await explainRequestPromise;
  const explainResponse = await explainResponsePromise;
  expect(explainResponse.status()).toBe(200);
  const explainBody = explainRequest.postDataJSON() as Record<string, unknown>;
  expect(explainBody).toMatchObject({
    lessonStage: 'explain',
    exerciseId: 'vectors-fixture-final',
  });
  expect(explainBody).not.toHaveProperty('lessonProblemId');
  expect(explainBody).not.toHaveProperty('knowledgePointId');

  await page.getByRole('button', { name: 'Step 1 of 2, passed' }).click();
  await expect(page).toHaveURL(/step=1/);
  await expect(page.getByTestId('lesson-step-content')).toContainText(
    'A vector is an ordered list of coordinates',
  );
  await textarea.fill('What does this step teach?');
  const stepRequestPromise = page.waitForRequest(
    (request) => request.method() === 'POST' && request.url().includes('/api/tutor/threads'),
  );
  const stepResponsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && response.url().includes('/api/tutor/threads'),
  );
  await textarea.press('Enter');
  const stepRequest = await stepRequestPromise;
  await stepResponsePromise;
  expect(stepRequest.postDataJSON()).toMatchObject({
    lessonStage: 'step',
    knowledgePointId: 'vectors-fixture-1',
  });

  await page.reload();
  await expect(page.getByTestId('lesson-step-content')).toContainText(
    'A vector is an ordered list of coordinates',
  );
  await page.goBack();
  await expect(page).toHaveURL(/step=explain/);
  await page.goForward();
  await expect(page).toHaveURL(/step=1/);
  await page.goto(`/session/${sessionId}?step=99`);
  await expect(page).not.toHaveURL(/step=99/);
  await expect(page.getByTestId('lesson-explain-chip')).toHaveAttribute(
    'aria-label',
    'Explain it, current',
  );
});

test('lesson step search is cleared on another session activity', async ({ page }) => {
  const sessionId = await createLessonSession({ stepsPassed: true });
  const [practiceActivity] = await db
    .insert(sessionActivities)
    .values({
      sessionId,
      idx: 1,
      kind: 'practice',
      conceptId: 'vectors',
      exerciseIds: ['vectors-fixture-final'],
      status: 'planned',
      plannedMinutes: 5,
    })
    .returning();
  if (!practiceActivity) throw new Error('Could not create practice activity');

  await page.goto(`/session/${sessionId}?activity=${practiceActivity.id}&step=1`);
  await expect(page).toHaveURL(new RegExp(`activity=${practiceActivity.id}`));
  await expect(page).not.toHaveURL(/step=/);
});

test('future steps stay unavailable and an active quiz cannot open lesson recaps', async ({
  page,
}) => {
  const sessionId = await createLessonSession({ stepsPassed: false });
  await page.goto(`/session/${sessionId}`);
  await expect(page.getByTestId('lesson-problem')).toBeVisible();
  await expect(page.getByTestId('lesson-step-chip').nth(1).locator('button')).toHaveCount(0);
  await expect(page.getByTestId('lesson-quiz-chip')).toHaveAttribute(
    'aria-label',
    'Lesson quiz, upcoming',
  );
  await db.delete(studySessions);
  await db.delete(lessonRuns);
  const quizSessionId = await createLessonSession({ stepsPassed: true, explainDone: true });
  await page.goto(`/session/${quizSessionId}`);
  await page.getByRole('button', { name: 'Start quiz', exact: true }).click();
  await expect(page.getByTestId('lesson-quiz-question')).toBeVisible();
  await expect(page.getByTestId('lesson-step-chip').locator('button')).toHaveCount(0);
  await expect(page.getByTestId('explain-step-recap')).toHaveCount(0);
});

test('a lesson can open directly on its Explain-it stage', async ({ page }) => {
  const sessionId = await createLessonSession({ stepsPassed: true });
  await page.goto(`/session/${sessionId}?step=explain`);

  await expect(page.getByTestId('lesson-steps-complete')).toBeVisible();
  await expect(page.getByTestId('lesson-explain-chip')).toHaveAttribute(
    'aria-label',
    'Explain it, current',
  );
  await expect(page).toHaveURL(/step=explain/);
});

test('an active quiz replaces saved step and Explain-it links with the quiz', async ({ page }) => {
  const sessionId = await createLessonSession({ stepsPassed: true, explainDone: true });
  await page.goto(`/session/${sessionId}`);
  await page.getByRole('button', { name: 'Start quiz', exact: true }).click();
  await expect(page.getByTestId('lesson-quiz-question')).toBeVisible();

  await page.goto(`/session/${sessionId}?step=1`);
  await expect(page.getByTestId('lesson-quiz-question')).toBeVisible();
  await expect(page).toHaveURL(/step=quiz/);

  await page.goto(`/session/${sessionId}?step=explain`);
  await expect(page.getByTestId('lesson-quiz-question')).toBeVisible();
  await expect(page).toHaveURL(/step=quiz/);
});

test('Explain it links fall forward to the quiz after the self-check is answered', async ({
  page,
}) => {
  const sessionId = await createLessonSession({ stepsPassed: true, explainDone: true });
  await page.goto(`/session/${sessionId}?step=explain`);

  await expect(page).toHaveURL(/step=quiz/);
  await expect(page.getByTestId('lesson-quiz-intro')).toBeVisible();
});

test('failed quiz Retry keeps the warm-up point in the URL', async ({ page }) => {
  const sessionId = await createLessonSession({ stepsPassed: true, explainDone: true });
  let lastPayload: Record<string, unknown> | null = null;
  let warmupProblem: Record<string, unknown> | null = null;
  await page.route('**/api/sessions/*', async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === 'GET' && url.pathname === `/api/sessions/${sessionId}`) {
      const response = await route.fetch();
      const payload = (await response.json()) as Record<string, unknown>;
      await route.fulfill({ response, json: { ...payload, tutorEnabled: true } });
      return;
    }
    await route.continue();
  });
  await page.route('**/api/tutor/status', (route) =>
    route.fulfill({ json: { tutorEnabled: true } }),
  );
  await page.route('**/api/lessons/vectors/run*', async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === 'POST' && url.pathname.endsWith('/run/practice')) {
      const run = lastPayload?.run as Record<string, unknown>;
      const problem = run.lastAnsweredProblem as Record<string, unknown>;
      warmupProblem = {
        ...problem,
        id: 'warmup-problem',
        practiceOnly: true,
        result: undefined,
      };
      const payload = { ...lastPayload, run: { ...run, pendingPracticeProblem: warmupProblem } };
      lastPayload = payload;
      await route.fulfill({ status: 200, json: payload });
      return;
    }
    const response = await route.fetch();
    const payload = (await response.json()) as Record<string, unknown>;
    const run = payload.run as Record<string, unknown>;
    const quiz = run.quiz as Record<string, unknown>;
    run.status = 'quiz';
    quiz.last = {
      attemptId: 'failed-attempt',
      passed: false,
      correctCount: 0,
      total: 1,
      perStep: [{ pointId: 'vectors-fixture-1', title: 'Vector basics', correct: 0, total: 1 }],
    };
    quiz.reviewRequired = [{ pointId: 'vectors-fixture-1', answered: 0, needed: 1 }];
    if (warmupProblem) run.pendingPracticeProblem = warmupProblem;
    lastPayload = payload;
    await route.fulfill({ response, json: payload });
  });

  await page.goto(`/session/${sessionId}`);
  await expect(page.getByTestId('lesson-quiz-results')).toBeVisible();
  await page.getByRole('button', { name: 'Open tutor' }).click();
  const tutor = page.getByRole('complementary', { name: 'Tutor' });
  await tutor.getByRole('button', { name: 'New chat' }).click();
  const tutorInput = tutor.getByLabel('Ask the tutor');
  await tutorInput.fill('What did I miss?');
  const quizTutorRequest = page.waitForRequest(
    (request) => request.method() === 'POST' && request.url().includes('/api/tutor/threads'),
  );
  const tutorResponsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && response.url().includes('/api/tutor/threads'),
  );
  await tutorInput.press('Enter');
  const quizTutorBody = (await quizTutorRequest).postDataJSON() as Record<string, unknown>;
  expect((await tutorResponsePromise).status()).toBe(200);
  expect(quizTutorBody).toMatchObject({ lessonStage: 'quiz' });
  expect(quizTutorBody).not.toHaveProperty('lessonProblemId');
  expect(quizTutorBody).not.toHaveProperty('knowledgePointId');
  expect(quizTutorBody).not.toHaveProperty('exerciseId');

  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page).toHaveURL(/step=1/);
  await expect(page.getByTestId('lesson-quiz-warmup')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('lesson-quiz-warmup')).toBeVisible();
});
