import { mkdirSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { eq } from 'drizzle-orm';
import { createDb } from '../../src/server/db/client.js';
import { sessionActivities, studySessions, users } from '../../src/server/db/schema.js';
import { env } from '../../src/server/env.js';

declare global {
  interface Window {
    __layoutShifts: number[];
  }
}

const screenshotDir = '/home/ubuntu/screenshots/tutor-optimistic';
mkdirSync(screenshotDir, { recursive: true });
const pageContextScreenshotDir = '/home/ubuntu/screenshots/tutor-page-context';
mkdirSync(pageContextScreenshotDir, { recursive: true });
const greetingScreenshotDir = '/home/ubuntu/screenshots/tutor-greeting';
mkdirSync(greetingScreenshotDir, { recursive: true });
let sessionId = '';

test.beforeEach(async () => {
  const db = createDb(env.TEST_DATABASE_URL);
  await db.delete(users);
  const [user] = await db
    .insert(users)
    .values({
      displayName: 'Tutor sidebar learner',
      timezone: 'UTC',
      startDate: '2026-01-01',
      prefs: { scheduleMinutes: 60 },
    })
    .returning();
  if (!user) throw new Error('Could not create the E2E learner');
  const [session] = await db
    .insert(studySessions)
    .values({
      userId: user.id,
      plannedMinutes: 30,
      startedAt: new Date('2026-01-01T12:00:00.000Z'),
      status: 'active',
    })
    .returning();
  if (!session) throw new Error('Could not create the E2E session');
  await db.insert(sessionActivities).values({
    sessionId: session.id,
    idx: 0,
    kind: 'learn',
    conceptId: 'supervised-learning',
    plannedMinutes: 30,
    status: 'in_progress',
  });
  sessionId = session.id;
  await db.$client.end();
});

test('Course tutor sidebar fills at least 90 percent of the viewport height', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    localStorage.setItem('academy.tutor.open', 'true');
  });
  await page.goto('/course');
  const tutor = page.getByRole('complementary', { name: 'Tutor' });
  await expect(tutor).toBeVisible();
  const viewportHeight = await page.evaluate(() => window.innerHeight);
  expect(
    await tutor.evaluate((element) => element.getBoundingClientRect().height),
  ).toBeGreaterThanOrEqual(viewportHeight * 0.9);
});

test('tutor chat sends optimistically and supports chat-list navigation', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-01-01T12:00:00.000Z') });
  await page.addInitScript(() => {
    const shifts: number[] = [];
    window.__layoutShifts = shifts;
    new PerformanceObserver((entries) => {
      for (const entry of entries.getEntries()) {
        const shift = entry as PerformanceEntry & { hadRecentInput: boolean; value: number };
        if (!shift.hadRecentInput) shifts.push(shift.value);
      }
    }).observe({ type: 'layout-shift', buffered: true });
  });
  await page.route('**/api/tutor/threads**', async (route) => {
    if (route.request().method() === 'POST') await page.waitForTimeout(1800);
    await route.continue();
  });
  await page.goto(`/session/${sessionId}`);
  await expect(page.getByRole('heading', { name: 'Supervised learning' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Ask the tutor' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open tutor' })).toBeVisible();

  await page.evaluate(() => {
    window.__layoutShifts = [];
  });
  const mainContent = page.locator('main').first();
  const mainWidthBefore = await mainContent.evaluate(
    (element) => element.getBoundingClientRect().width,
  );
  await page.getByRole('button', { name: 'Ask the tutor' }).click();
  const tutor = page.getByRole('complementary', { name: 'Tutor' });
  await expect(tutor).toBeVisible();
  await expect(tutor.getByTestId('tutor-conversation-title')).toHaveText('New chat');
  await expect(tutor.getByTestId('tutor-greeting')).toContainText(
    'What would you like help with on this question?',
  );
  await expect(page.locator('[data-slot="sheet-overlay"]')).toHaveCount(0);
  const mainWidthAfter = await mainContent.evaluate(
    (element) => element.getBoundingClientRect().width,
  );
  expect(mainWidthAfter, 'tutor sidebar reduces the main page width').toBeLessThan(mainWidthBefore);
  await expect(tutor.getByText('Supervised learning', { exact: true })).toBeVisible();
  await expect(tutor.getByTestId('tutor-greeting')).toBeVisible();

  const textarea = tutor.getByLabel('Ask the tutor');
  await textarea.fill('Explain the first step');
  await textarea.press('Enter');
  await expect(textarea).toHaveValue('');
  await expect(
    tutor.getByTestId('tutor-user-message').filter({ hasText: 'Explain the first step' }),
  ).toHaveCount(1);
  await expect(tutor.getByRole('status', { name: 'Tutor is responding' })).toBeVisible();
  await expect(tutor.getByTestId('tutor-thinking-bubble')).toBeVisible();
  await textarea.fill('Draft while waiting');
  await expect(textarea).toHaveValue('Draft while waiting');
  await expect(tutor.getByRole('button', { name: 'Sending…' })).toBeDisabled();
  await textarea.fill('');
  await expect(textarea).toHaveValue('');
  await page.screenshot({ path: `${screenshotDir}/tutor-pending.png` });

  await expect(tutor.getByText('Tutor reply to: Explain the first step')).toBeVisible();
  await expect(
    tutor.getByTestId('tutor-user-message').filter({ hasText: 'Explain the first step' }),
  ).toHaveCount(1);
  await page.screenshot({ path: `${screenshotDir}/tutor-conversation.png` });

  const cls = await page.evaluate(() =>
    window.__layoutShifts.reduce((total, value) => total + value, 0),
  );
  expect(cls, 'opening the tutor sidebar CLS').toBeLessThan(0.02);

  await page.reload();
  const restoredTutor = page.getByRole('complementary', { name: 'Tutor' });
  await expect(restoredTutor).toBeVisible();
  await expect(restoredTutor.getByText('Tutor reply to: Explain the first step')).toBeVisible();
  await expect(
    restoredTutor.getByTestId('tutor-user-message').filter({ hasText: 'Explain the first step' }),
  ).toHaveCount(1);

  await restoredTutor.getByRole('button', { name: 'Chats' }).click();
  await expect(restoredTutor.getByRole('heading', { name: 'Chats' })).toBeVisible();
  await restoredTutor.getByRole('button', { name: 'New chat' }).first().click();
  await expect(restoredTutor.getByTestId('tutor-conversation-title')).toHaveText('New chat');
  await expect(restoredTutor.getByText('Supervised learning', { exact: true })).toBeVisible();
  const secondTextarea = restoredTutor.getByLabel('Ask the tutor');
  await secondTextarea.fill('Why are targets useful?');
  await restoredTutor.getByRole('button', { name: 'Send' }).click();
  await expect(
    restoredTutor.getByTestId('tutor-user-message').filter({ hasText: 'Why are targets useful?' }),
  ).toHaveCount(1);
  await expect(restoredTutor.getByText('Tutor reply to: Why are targets useful?')).toBeVisible();

  await restoredTutor.getByRole('button', { name: 'Chats' }).click();
  await expect(restoredTutor.getByRole('heading', { name: 'Today' })).toBeVisible();
  const threadRows = restoredTutor.locator('[data-testid^="tutor-thread-"]');
  await expect(threadRows).toHaveCount(2);
  await expect(threadRows.filter({ hasText: 'Explain the first step' })).toHaveCount(1);
  await expect(threadRows.filter({ hasText: 'Why are targets useful?' })).toHaveCount(1);
  await expect(threadRows.first().locator('[data-slot="badge"]')).toHaveText('Supervised learning');
  await expect(threadRows.nth(1).locator('[data-slot="badge"]')).toHaveText('Supervised learning');
  await page.screenshot({ path: `${screenshotDir}/tutor-chats.png` });

  const firstThreadRow = restoredTutor.locator(
    '[data-testid^="tutor-thread-"]:not([aria-pressed="true"])',
  );
  await expect(firstThreadRow).toHaveCount(1);
  const firstThreadTestId = await firstThreadRow.getAttribute('data-testid');
  if (!firstThreadTestId) throw new Error('Could not identify the first tutor thread');
  const firstThread = restoredTutor.getByTestId(firstThreadTestId);
  await firstThread.click();
  await expect(restoredTutor.getByTestId('tutor-conversation-title')).toHaveText(
    'Explain the first step',
  );
  await expect(
    restoredTutor.getByTestId('tutor-user-message').filter({ hasText: 'Explain the first step' }),
  ).toHaveCount(1);
  await restoredTutor.getByRole('button', { name: 'Chats' }).click();
  await restoredTutor.getByRole('button', { name: 'New chat' }).first().click();
  await expect(restoredTutor.getByTestId('tutor-conversation-title')).toHaveText('New chat');
  await expect(restoredTutor.getByText('Supervised learning', { exact: true })).toBeVisible();
  await expect(restoredTutor.getByTestId('tutor-user-message')).toHaveCount(0);
  await expect(restoredTutor.getByText('Start a conversation')).toBeVisible();

  await restoredTutor.getByRole('button', { name: 'Chats' }).click();
  await firstThread.click();
  await page.reload();
  const reloadedTutor = page.getByRole('complementary', { name: 'Tutor' });
  await expect(reloadedTutor).toBeVisible();
  await expect(reloadedTutor.getByTestId('tutor-conversation-title')).toHaveText(
    'Explain the first step',
  );
  await expect(
    reloadedTutor.getByTestId('tutor-user-message').filter({ hasText: 'Explain the first step' }),
  ).toHaveCount(1);

  await page.evaluate(() => {
    window.__layoutShifts = [];
    localStorage.setItem('academy.tutor.open', 'true');
  });
  await page.goto('/');
  await expect(page.getByRole('complementary', { name: 'Tutor' })).toBeVisible();
  const restoreCls = await page.evaluate(() =>
    window.__layoutShifts.reduce((total, value) => total + value, 0),
  );
  expect(restoreCls, 'restoring the tutor sidebar on Learn CLS').toBeLessThan(0.02);

  await page.goto('/diagnostic');
  await expect(page.getByRole('button', { name: 'Open tutor' })).toHaveCount(0);
  await expect(page.getByRole('complementary', { name: 'Tutor' })).toHaveCount(0);
});

test('Ask the tutor starts a fresh greeted chat on each problem launch', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/session/${sessionId}`);
  await expect(page.getByRole('heading', { name: 'Supervised learning' })).toBeVisible();

  const askButton = page.getByRole('button', { name: 'Ask the tutor' });
  await askButton.click();
  const tutor = page.getByRole('complementary', { name: 'Tutor' });
  await expect(tutor.getByTestId('tutor-conversation-title')).toHaveText('New chat');
  await expect(tutor.getByTestId('tutor-greeting')).toContainText(
    'What would you like help with on this question?',
  );
  const firstComposer = tutor.getByLabel('Ask the tutor');
  await firstComposer.fill('Earlier question about this lesson');
  await firstComposer.press('Enter');
  await expect(
    tutor
      .getByTestId('tutor-user-message')
      .filter({ hasText: 'Earlier question about this lesson' }),
  ).toHaveCount(1);
  await expect(
    tutor.getByTestId('tutor-assistant-message').filter({
      hasText: 'Tutor reply to: Earlier question about this lesson',
    }),
  ).toBeVisible();
  await expect(tutor.getByTestId('tutor-conversation-title')).toHaveText(
    'Earlier question about this lesson',
  );

  await tutor.getByRole('button', { name: 'Close tutor' }).click();
  await expect(askButton).toBeVisible();
  await askButton.click();
  await expect(tutor.getByTestId('tutor-conversation-title')).toHaveText('New chat');
  const greeting = tutor.getByTestId('tutor-greeting');
  await expect(greeting).toContainText('What would you like help with on this question?');
  await expect(tutor.getByTestId('tutor-user-message')).toHaveCount(0);
  await expect(tutor.getByTestId('tutor-assistant-message')).toHaveCount(0);
  const composer = tutor.getByLabel('Ask the tutor');
  await expect(composer).toBeFocused();
  await page.screenshot({
    path: `${greetingScreenshotDir}/greeting.png`,
    fullPage: true,
  });

  await composer.fill('Why is this answer correct?');
  await composer.press('Enter');
  await expect(tutor.getByTestId('tutor-conversation-title')).toHaveText(
    'Why is this answer correct?',
  );
  await expect(
    tutor.getByTestId('tutor-user-message').filter({ hasText: 'Why is this answer correct?' }),
  ).toHaveCount(1);
  await expect(greeting).toBeVisible();
  await expect(
    tutor.getByTestId('tutor-assistant-message').filter({
      hasText: 'Tutor reply to: Why is this answer correct?',
    }),
  ).toBeVisible();
  const greetingAndMessages = tutor.locator(
    '[data-testid="tutor-greeting"], [data-testid="tutor-user-message"]',
  );
  await expect(greetingAndMessages).toHaveCount(2);
  await expect(greetingAndMessages.first()).toHaveAttribute('data-testid', 'tutor-greeting');
  await expect(greetingAndMessages.last()).toHaveAttribute('data-testid', 'tutor-user-message');
  await page.screenshot({
    path: `${greetingScreenshotDir}/after-send.png`,
    fullPage: true,
  });

  await tutor.getByRole('button', { name: 'Close tutor' }).click();
  await expect(askButton).toBeVisible();
  await askButton.click();
  await expect(tutor.getByTestId('tutor-conversation-title')).toHaveText('New chat');
  await expect(tutor.getByTestId('tutor-greeting')).toContainText(
    'What would you like help with on this question?',
  );
  await expect(tutor.getByTestId('tutor-user-message')).toHaveCount(0);
  await expect(tutor.getByTestId('tutor-assistant-message')).toHaveCount(0);
});

test('tutor send failure restores the draft and removes the optimistic message', async ({
  page,
}) => {
  await page.route('**/api/tutor/threads**', async (route) => {
    if (route.request().method() === 'POST') {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'The tutor could not respond. Try again.' }),
      });
      return;
    }
    await route.continue();
  });
  await page.goto(`/session/${sessionId}`);
  await page.getByRole('button', { name: 'Ask the tutor' }).click();
  const tutor = page.getByRole('complementary', { name: 'Tutor' });
  const textarea = tutor.getByLabel('Ask the tutor');
  await textarea.fill('What does the target represent?');
  await textarea.press('Shift+Enter');
  await textarea.type('Please show the next line.');
  await expect(textarea).toHaveValue('What does the target represent?\nPlease show the next line.');
  await textarea.fill('What does the target represent?');
  await textarea.press('Enter');
  await expect(textarea).toHaveValue('What does the target represent?');
  await expect(tutor.getByRole('alert')).toContainText('The tutor could not respond. Try again.');
  await expect(tutor.getByTestId('tutor-user-message')).toHaveCount(0);
  await expect(tutor.getByTestId('tutor-thinking-bubble')).toHaveCount(0);
});

test('Practice activity without a concept can send a tutor message', async ({ page }) => {
  const db = createDb(env.TEST_DATABASE_URL);
  await db
    .update(sessionActivities)
    .set({ status: 'planned' })
    .where(eq(sessionActivities.sessionId, sessionId));
  const [activity] = await db
    .insert(sessionActivities)
    .values({
      sessionId,
      idx: 1,
      kind: 'practice',
      conceptId: null,
      exerciseIds: ['slp-input-target'],
      plannedMinutes: 5,
      status: 'in_progress',
    })
    .returning();
  await db.$client.end();
  if (!activity) throw new Error('Could not create a null-concept practice activity');

  let requestBody: Record<string, unknown> | undefined;
  await page.route('**/api/tutor/threads**', async (route) => {
    if (route.request().method() === 'POST') {
      requestBody = route.request().postDataJSON();
    }
    await route.continue();
  });
  await page.goto(`/session/${sessionId}`);
  await expect(page.getByText(/A shop predicts tomorrow's number of orders/)).toBeVisible();
  await page.getByRole('button', { name: 'Ask the tutor' }).click();
  const tutor = page.getByRole('complementary', { name: 'Tutor' });
  const textarea = tutor.getByLabel('Ask the tutor');
  await textarea.fill('What is the target in this question?');
  await textarea.press('Enter');
  await expect(
    tutor.getByText('Tutor reply to: What is the target in this question?'),
  ).toBeVisible();
  await expect(page.getByText('Invalid tutor request', { exact: true })).toHaveCount(0);
  expect(requestBody).toMatchObject({
    activityId: activity.id,
    exerciseId: 'slp-input-target',
  });
  expect(requestBody).not.toHaveProperty('conceptId');
});

test('tutor Reading context follows the session, lesson, and home pages', async ({ page }) => {
  let requestBody: Record<string, unknown> | undefined;
  await page.route('**/api/tutor/threads**', async (route) => {
    if (route.request().method() === 'POST') {
      requestBody = route.request().postDataJSON() as Record<string, unknown>;
    }
    await route.continue();
  });

  await page.goto(`/session/${sessionId}`);
  await expect(page.getByRole('heading', { name: 'Supervised learning' })).toBeVisible();
  await page.getByRole('button', { name: 'Ask the tutor' }).click();
  const tutor = page.getByRole('complementary', { name: 'Tutor' });
  const reading = tutor.getByTestId('tutor-reading-context');
  await expect(reading).toHaveText(/^Reading: Supervised learning · step 1 of \d+$/);
  await page.screenshot({
    path: `${pageContextScreenshotDir}/tutor-session.png`,
    fullPage: true,
  });

  const knowledgePointId = await page.evaluate(async () => {
    const response = await fetch('/api/lessons/supervised-learning/run');
    const payload = await response.json();
    return payload.run?.currentPointId as string | undefined;
  });
  expect(knowledgePointId).toBeTruthy();
  const textarea = tutor.getByLabel('Ask the tutor');
  await textarea.fill('What does this step mean?');
  const sendResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && response.url().includes('/api/tutor/threads'),
  );
  await textarea.press('Enter');
  await sendResponse;
  expect(requestBody).toMatchObject({
    page: 'session',
    knowledgePointId,
  });
  expect(requestBody).not.toHaveProperty('pageLabel');
  expect(requestBody).not.toHaveProperty('page_content');
  await expect(tutor.getByTestId('tutor-assistant-message')).toContainText(
    'Tutor reply to: What does this step mean?',
  );

  await page.evaluate(() => {
    window.history.pushState(window.history.state, '', '/lessons/supervised-learning');
    window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state }));
  });
  await expect(page).toHaveURL(/\/lessons\/supervised-learning$/);
  await expect(page.getByRole('heading', { name: 'Supervised learning' })).toBeVisible();
  await expect(reading).toHaveText('Reading: Supervised learning · full lesson');
  await page.screenshot({
    path: `${pageContextScreenshotDir}/tutor-lesson.png`,
    fullPage: true,
  });

  await page.getByRole('link', { name: 'Learn' }).click();
  await expect(page).toHaveURL('/');
  await expect(tutor.getByTestId('tutor-reading-context')).toHaveCount(0);
});
