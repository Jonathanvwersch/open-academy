import type { QuizPayload } from '@academy/aesop/api/quizzes';
import type { SessionPayload } from '@academy/aesop/api/sessions';
import type { ContentIndex } from '@academy/aesop/course/types';
import type { Page, TestInfo } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { asc, eq } from 'drizzle-orm';
import { answerFor, wrongAnswerFor } from '../../apps/api/scripts/learner-simulation-support.js';
import { env } from '../../apps/api/src/config.js';
import { loadContent } from '../../apps/api/src/content/load.js';
import { createDb } from '../../apps/api/src/db/client.js';
import { lessonRuns, quizItems, quizRuns, users, xpEvents } from '../../apps/api/src/db/schema.js';

const db = createDb(env.TEST_DATABASE_URL);
const start = '2026-01-01T12:00:00.000Z';

async function captureShellTransitionFrames(page: Page, testInfo: TestInfo, name: string) {
  const timestamps = [0, 80, 160, 300];
  const startedAt = Date.now();
  for (const timestamp of timestamps) {
    const remaining = timestamp - (Date.now() - startedAt);
    if (remaining > 0) await page.waitForTimeout(remaining);
    await page.screenshot({ path: testInfo.outputPath(`${name}-${timestamp}ms.png`) });
  }
}

async function expectSidebarFullyOffcanvas(page: Page) {
  const navigation = page.getByRole('navigation', { name: 'Main navigation' });
  await expect(navigation).toHaveAttribute('data-state', 'collapsed');
  await expect(navigation).toHaveAttribute('data-collapsible', 'offcanvas');
  await expect
    .poll(() =>
      page.locator('[data-slot="sidebar-gap"]').evaluate((element) => {
        return element.getBoundingClientRect().width;
      }),
    )
    .toBe(0);
  const container = page.locator('[data-slot="sidebar-container"]');
  await expect(container).toHaveCSS('visibility', 'hidden');
  const bounds = await container.evaluate((element) => {
    const { left, right, width } = element.getBoundingClientRect();
    return { left, right, width };
  });
  expect(bounds.left).toBeLessThan(-200);
  expect(Math.abs(bounds.right)).toBeLessThanOrEqual(1);
  expect(bounds.width).toBeGreaterThan(200);
}

async function completeReviewActivities(
  page: Page,
  content: ContentIndex,
  sessionId: string,
  headers: Record<string, string>,
) {
  const response = await page.request.get(`/api/sessions/${sessionId}`, { headers });
  expect(response.ok()).toBe(true);
  const reviewPlan = (await response.json()) as SessionPayload;
  for (const activity of reviewPlan.activities) {
    const attempted = new Set<string>();
    let exercises = activity.exerciseIds;
    while (exercises.length) {
      for (const exerciseId of exercises) {
        const submit = () =>
          page.request.post('/api/attempts', {
            headers,
            data: {
              exerciseId,
              sessionId,
              activityId: activity.id,
              mode: 'review',
              answer: answerFor(content, exerciseId),
            },
          });
        const attempt = await submit();
        expect(attempt.ok(), await attempt.text()).toBe(true);
        if ((await attempt.json()).retryAllowed) {
          const retry = await submit();
          expect(retry.ok(), await retry.text()).toBe(true);
          expect((await retry.json()).retryAllowed).toBe(false);
        }
        attempted.add(exerciseId);
      }
      const refreshed = await page.request.get(`/api/sessions/${sessionId}`, { headers });
      expect(refreshed.ok()).toBe(true);
      const current = ((await refreshed.json()) as SessionPayload).activities.find(
        ({ id }) => id === activity.id,
      );
      exercises = current?.exerciseIds.filter((id) => !attempted.has(id)) ?? [];
      if (exercises.length === 0) expect(current?.status).toBe('completed');
    }
  }
  return reviewPlan.activities.length;
}

test.skip(
  process.env.PLAYWRIGHT_CONTENT_DIR !== 'content',
  'This journey needs eight unrelated learned topics from the full curriculum.',
);

test.afterAll(async () => {
  await db.$client.end();
});

test('starts a quiz, preserves progress on refresh, and unlocks a fresh retake only after reviews', async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  const content = await loadContent('content');
  await db.delete(users);
  const [user] = await db
    .insert(users)
    .values({
      displayName: 'Timed quiz learner',
      timezone: 'UTC',
      startDate: '2026-01-01',
      activeCourseId: 'ml-foundations',
    })
    .returning();
  await db.insert(lessonRuns).values(
    content.lessons.map(({ concept }) => ({
      userId: user.id,
      conceptId: concept,
      status: 'completed' as const,
      completedAt: new Date(start),
    })),
  );
  await db.insert(xpEvents).values({
    userId: user.id,
    amount: 150,
    kind: 'knowledge_point',
    sourceKey: 'e2e:timed-quiz',
    earnedAt: new Date(start),
    localDate: '2026-01-01',
  });

  let now = start;
  await page.route('**/api/**', (route) =>
    route.continue({
      headers: { ...route.request().headers(), 'x-now': now, 'x-time-zone': 'UTC' },
    }),
  );
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript(() => {
    if (
      location.origin !== 'null' &&
      sessionStorage.getItem('academy.e2e.sidebar-open-initialized') !== 'true'
    ) {
      localStorage.setItem('academy.app-sidebar.open', 'true');
      sessionStorage.setItem('academy.e2e.sidebar-open-initialized', 'true');
    }
  });
  const session = await page.request.post('/api/sessions', {
    data: { budgetMinutes: 120 },
    headers: { 'x-now': now, 'x-time-zone': 'UTC' },
  });
  expect(session.ok()).toBe(true);
  const { id: sessionId, activities } = (await session.json()) as SessionPayload & { id: string };
  expect(activities[0].kind).toBe('mixed_quiz');
  expect(activities.length).toBeGreaterThan(1);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Next up', exact: true })).toBeVisible();
  const desktopNavigation = page.getByRole('navigation', { name: 'Main navigation' });
  await expect(desktopNavigation).toHaveAttribute('data-state', 'expanded');
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('academy.app-sidebar.open')))
    .toBe('true');
  await page.screenshot({ path: testInfo.outputPath('desktop-home-expanded-final.png') });
  const resumeSession = page.getByRole('link', { name: /^Resume/ });
  await expect(resumeSession).toHaveAttribute('href', `/session/${sessionId}`);
  await resumeSession.click();
  await expect(page).toHaveURL(`/session/${sessionId}`);
  await expect(page.getByRole('button', { name: 'Open quiz' })).toBeVisible();
  await page.getByRole('button', { name: 'Open quiz' }).click();
  await expect(page).toHaveURL(/\/quizzes\//);
  await captureShellTransitionFrames(page, testInfo, 'desktop-enter-quiz');
  await expect(page.getByText('Question 1 of 8')).toBeVisible();
  await expect(page.getByTestId('quiz-prompt')).not.toBeEmpty();
  await expect(page.getByRole('timer')).toBeVisible();
  await expect(page.getByRole('button', { name: /hint|tutor/i })).toHaveCount(0);
  await expect(page.locator('a[href*="/lessons/"]')).toHaveCount(0);
  await expectSidebarFullyOffcanvas(page);
  await page.screenshot({ path: testInfo.outputPath('desktop-quiz-final.png') });
  await page.screenshot({ path: testInfo.outputPath('timed-quiz-desktop.png') });

  const quizId = new URL(page.url()).pathname.split('/').at(-1) ?? '';
  const headers = () => ({ 'x-now': now, 'x-time-zone': 'UTC' });

  const mobilePage = await page.context().newPage();
  await mobilePage.setViewportSize({ width: 390, height: 844 });
  await mobilePage.addInitScript(() => {
    if (
      location.origin !== 'null' &&
      sessionStorage.getItem('academy.e2e.sidebar-open-initialized') !== 'true'
    ) {
      localStorage.setItem('academy.app-sidebar.open', 'true');
      sessionStorage.setItem('academy.e2e.sidebar-open-initialized', 'true');
    }
  });
  await mobilePage.route('**/api/**', (route) =>
    route.continue({
      headers: { ...route.request().headers(), 'x-now': now, 'x-time-zone': 'UTC' },
    }),
  );
  await mobilePage.goto('/');
  await expect(mobilePage.getByRole('heading', { name: 'Next up', exact: true })).toBeVisible();
  await mobilePage.getByRole('link', { name: /^Resume/ }).click();
  await expect(mobilePage).toHaveURL(`/session/${sessionId}`);
  const mobileHeader = mobilePage.getByTestId('mobile-app-header');
  await expect(mobileHeader).toHaveCount(1);
  await mobileHeader.evaluate((element) => {
    element.setAttribute('data-mark', '1');
  });
  await mobilePage.getByRole('button', { name: 'Open quiz' }).click();
  await expect(mobilePage).toHaveURL(new RegExp(`/quizzes/${quizId}(?:\\?.*)?$`));
  await expect(mobilePage.getByRole('main')).toHaveCount(1);
  await captureShellTransitionFrames(mobilePage, testInfo, 'mobile-enter-quiz');
  await expect(mobilePage.getByText('Question 1 of 8')).toBeVisible();
  await expect(mobileHeader).toHaveAttribute('data-mark', '1');
  await expect(mobileHeader).toHaveCSS('opacity', '0');
  await expect(mobileHeader).toHaveCSS('height', '0px');
  const headerTransitionProperty = await mobileHeader.evaluate(
    (element) => getComputedStyle(element).transitionProperty,
  );
  expect(headerTransitionProperty).toContain('height');
  expect(headerTransitionProperty).toContain('opacity');
  await mobilePage.screenshot({ path: testInfo.outputPath('mobile-quiz-final.png') });
  await mobilePage.goBack();
  await expect(mobilePage).toHaveURL(`/session/${sessionId}`);
  await expect(mobileHeader).toHaveAttribute('data-mark', '1');
  const restoredHeaderTransitionProperty = await mobileHeader.evaluate(
    (element) => getComputedStyle(element).transitionProperty,
  );
  expect(restoredHeaderTransitionProperty).toContain('height');
  expect(restoredHeaderTransitionProperty).toContain('opacity');
  await captureShellTransitionFrames(mobilePage, testInfo, 'mobile-exit-quiz');
  await expect(mobileHeader).toHaveCSS('opacity', '1');
  await expect(mobileHeader).toHaveCSS('height', '56px');
  await mobileHeader.getByRole('button', { name: 'Open navigation' }).click();
  const mobileNavigation = mobilePage.getByRole('navigation', { name: 'Main navigation' });
  await expect(mobileNavigation).toBeVisible();
  await expect(mobileNavigation).toHaveAttribute('data-mobile', 'true');
  await mobilePage.goForward();
  await expect(mobilePage).toHaveURL(new RegExp(`/quizzes/${quizId}(?:\\?.*)?$`));
  await expect(mobileNavigation).toBeHidden();
  await expect(mobileHeader).toHaveAttribute('data-mark', '1');
  await mobilePage.goBack();
  await expect(mobilePage).toHaveURL(`/session/${sessionId}`);
  await mobileHeader.getByRole('link', { name: 'Open Academy home' }).click();
  await expect(mobilePage.getByRole('heading', { name: 'Next up', exact: true })).toBeVisible();
  await mobilePage.screenshot({ path: testInfo.outputPath('mobile-home-after-quiz-final.png') });
  await mobilePage.close();

  const readQuiz = async () =>
    (await (
      await page.request.get(`/api/quizzes/${quizId}`, {
        headers: headers(),
      })
    ).json()) as QuizPayload;
  const opened = await readQuiz();
  const items = await db
    .select()
    .from(quizItems)
    .where(eq(quizItems.runId, quizId))
    .orderBy(asc(quizItems.position));
  const first = items[0].question;
  const firstAnswer = answerFor(content, first.exercise.id, first.seed);
  const firstResponse = await page.request.post(`/api/quizzes/${quizId}/answer`, {
    headers: headers(),
    data: { position: 0, questionId: first.exercise.id, answer: firstAnswer },
  });
  expect(firstResponse.ok()).toBe(true);
  now = new Date(Date.parse(start) + 12_000).toISOString();
  await page.reload();
  await expect(page.getByText('Question 2 of 8')).toBeVisible();
  await expect(page.getByTestId('quiz-prompt')).not.toBeEmpty();
  expect((await readQuiz()).deadline).toBe(opened.deadline);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath('timed-quiz-refreshed-mobile.png') });

  now = opened.deadline;
  const second = items[1].question;
  const late = await page.request.post(`/api/quizzes/${quizId}/answer`, {
    headers: headers(),
    data: {
      position: 1,
      questionId: second.exercise.id,
      answer: answerFor(content, second.exercise.id, second.seed),
    },
  });
  expect(late.status()).toBe(409);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Quiz results' })).toBeVisible();
  await expect(page.getByText('1 of 8 correct')).toBeVisible();
  await expect(page.getByText('Then you can retake the quiz once, if you want.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retake quiz now' })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('timed-quiz-results-mobile.png') });
  const previousViewport = page.viewportSize();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: testInfo.outputPath('timed-quiz-results-desktop.png') });
  if (previousViewport) await page.setViewportSize(previousViewport);
  const locked = await page.request.post(`/api/quizzes/${quizId}/retake`, { headers: headers() });
  expect(locked.status()).toBe(409);

  await page.getByRole('button', { name: 'Review now' }).click();
  await expect(page).toHaveURL(/\/session\//);
  const reviewSession = new URL(page.url()).pathname.split('/').at(-1);
  if (!reviewSession) throw new Error('Expected a review session ID');
  expect(await completeReviewActivities(page, content, reviewSession, headers())).toBe(7);
  await page.goto(`/session/${reviewSession}`);
  const finish = page.getByRole('button', { name: 'Finish session' });
  await expect(finish).toBeVisible({ timeout: 15_000 });
  await finish.click();
  await expect(page.getByRole('link', { name: 'Continue session' })).toHaveAttribute(
    'href',
    `/session/${sessionId}`,
  );
  await expect(
    page.getByRole('heading', { name: 'Reviews done. Your retake is unlocked.' }),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: /Skip the retake/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retake quiz now' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('timed-quiz-retake-mobile.png') });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.screenshot({ path: testInfo.outputPath('timed-quiz-retake-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Retake quiz now' }).click();
  await expect(page.getByRole('heading', { name: 'Quiz retake' })).toBeVisible();
  const retakeId = new URL(page.url()).pathname.split('/').at(-1) ?? '';
  const retake = await db
    .select()
    .from(quizItems)
    .where(eq(quizItems.runId, retakeId))
    .orderBy(asc(quizItems.position));
  expect(retake.map(({ conceptId }) => conceptId)).toEqual(items.map(({ conceptId }) => conceptId));
  expect(
    retake.every(({ question }) => items.every((item) => item.question.key !== question.key)),
  ).toBe(true);

  for (const item of retake) {
    const exerciseId = item.question.exercise.id;
    const answer =
      item.position === 0
        ? wrongAnswerFor(content, exerciseId, item.question.seed)
        : answerFor(content, exerciseId, item.question.seed);
    const response = await page.request.post(`/api/quizzes/${retakeId}/answer`, {
      headers: headers(),
      data: { position: item.position, answer },
    });
    expect(response.ok(), await response.text()).toBe(true);
  }
  const finalized = await page.request.post(`/api/quizzes/${retakeId}/finalize`, {
    headers: headers(),
  });
  expect(finalized.ok(), await finalized.text()).toBe(true);
  const retakeResult = (await finalized.json()) as QuizPayload;
  expect(retakeResult.result?.topics.filter(({ missed }) => missed)).toHaveLength(1);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Retake results' })).toBeVisible();
  await expect(page.getByText('7 of 8 correct')).toBeVisible();
  await page.getByRole('button', { name: 'Review now' }).click();
  await expect(page).toHaveURL(/\/session\//);
  const retakeReviewSession = new URL(page.url()).pathname.split('/').at(-1);
  if (!retakeReviewSession) throw new Error('Expected a retake review session ID');
  expect(
    await completeReviewActivities(page, content, retakeReviewSession, headers()),
  ).toBeGreaterThan(0);
  await page.goto(`/session/${retakeReviewSession}`);
  const finishRetakeReview = page.getByRole('button', { name: 'Finish session' });
  await expect(finishRetakeReview).toBeVisible({ timeout: 15_000 });
  await finishRetakeReview.click();
  await expect(page).toHaveURL((url) => url.pathname === `/quizzes/${retakeId}`);
  await expect(page.getByRole('heading', { name: 'Retake results' })).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Reviews done. This quiz is finished.' }),
  ).toBeVisible();
  await expect(
    page.getByText(
      'You reviewed the topic from this retake. That was your one retake, so there is nothing more to do here. That topic stays in your normal reviews.',
    ),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'Back to Home' })).toHaveAttribute('href', '/');
  await page.screenshot({ path: testInfo.outputPath('completed-retake-mobile.png') });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.screenshot({ path: testInfo.outputPath('completed-retake-desktop.png') });
  await page.getByRole('link', { name: 'Back to Home' }).click();
  await expect(page).toHaveURL('/');
  await captureShellTransitionFrames(page, testInfo, 'desktop-exit-quiz');
  await expect(page.getByRole('heading', { name: 'Next up', exact: true })).toBeVisible();
  await expect(desktopNavigation).toHaveAttribute('data-state', 'expanded');
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('academy.app-sidebar.open')))
    .toBe('true');
  await page.screenshot({
    path: testInfo.outputPath('desktop-home-after-quiz-expanded-final.png'),
  });

  await desktopNavigation.getByRole('button', { name: 'Collapse navigation' }).click();
  await expect(desktopNavigation).toHaveAttribute('data-state', 'collapsed');
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('academy.app-sidebar.open')))
    .toBe('false');
  await page.goto(`/quizzes/${retakeId}`);
  await expect(page.getByRole('heading', { name: 'Retake results' })).toBeVisible();
  await expectSidebarFullyOffcanvas(page);
  await page.screenshot({ path: testInfo.outputPath('desktop-collapsed-quiz-final.png') });
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('academy.app-sidebar.open')))
    .toBe('false');
  await page.getByRole('link', { name: 'Back to Home' }).click();
  await expect(page).toHaveURL('/');
  await expect(page.getByRole('heading', { name: 'Next up', exact: true })).toBeVisible();
  await expect(desktopNavigation).toHaveAttribute('data-state', 'collapsed');
  await expect(desktopNavigation).toHaveAttribute('data-collapsible', 'icon');
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('academy.app-sidebar.open')))
    .toBe('false');
  await page.screenshot({
    path: testInfo.outputPath('desktop-home-after-quiz-collapsed-final.png'),
  });
});

test('a stale answer shows the changed question and keeps the quiz usable', async ({
  page,
}, testInfo) => {
  const content = await loadContent('content');
  const exercise = content.exercisesById.get('vecp-entry');
  if (exercise?.type !== 'numeric') throw new Error('Missing timed quiz fixture');
  await db.delete(users);
  const [user] = await db
    .insert(users)
    .values({
      displayName: 'Timed quiz learner',
      timezone: 'UTC',
      startDate: '2026-01-01',
    })
    .returning();
  const deadline = new Date(Date.parse(start) + 120_000);
  const [run] = await db
    .insert(quizRuns)
    .values({
      userId: user.id,
      startedAt: new Date(start),
      deadline,
      plannedMinutes: 2,
      seed: 0,
      difficulty: 2,
    })
    .returning();
  const question = { key: exercise.prompt.trim().replace(/\s+/g, ' '), exercise, seed: 0 };
  await db.insert(quizItems).values({
    runId: run.id,
    position: 0,
    conceptId: exercise.concept,
    question,
  });
  await page.goto(`/quizzes/${run.id}`);
  const text = page.getByTestId('quiz-prompt');
  await expect(text).not.toBeEmpty();
  const original = (await text.textContent()) ?? '';
  await db
    .update(quizItems)
    .set({
      question: { ...question, exercise: { ...exercise, id: 'deleted-e2e-quiz-question' } },
    })
    .where(eq(quizItems.runId, run.id));
  await page.getByLabel('Your answer').fill('999');
  const stale = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/quizzes/${run.id}/answer`) && response.status() === 409,
  );
  await page.getByRole('button', { name: 'Submit answer' }).click();
  await stale;
  await expect(page.getByRole('alert')).toHaveText(
    'Question changed. Answer the current question.',
  );
  await expect(text).not.toHaveText(original);
  await expect(page.getByText('Question 1 of 1')).toBeVisible();
  const [replaced] = await db.select().from(quizItems).where(eq(quizItems.runId, run.id));
  expect(replaced.answeredAt).toBeNull();
  expect(replaced.question.exercise.concept).toBe(exercise.concept);
  expect((await db.select().from(quizRuns).where(eq(quizRuns.id, run.id)))[0].deadline).toEqual(
    deadline,
  );
  await page.screenshot({ path: testInfo.outputPath('timed-quiz-question-changed.png') });
  const replacement = replaced.question.exercise;
  if (replacement.type === 'mc') {
    await page
      .getByRole(replacement.multi ? 'checkbox' : 'radio')
      .first()
      .click();
  } else {
    await expect(page.getByLabel('Your answer')).toHaveValue('');
    await page
      .getByLabel('Your answer')
      .fill(String(answerFor(content, replacement.id, replaced.question.seed)));
  }
  await page.getByRole('button', { name: 'Submit answer' }).click();
  await expect(page.getByRole('heading', { name: 'Quiz results' })).toBeVisible();
});
