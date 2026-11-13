import { mkdirSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { eq } from 'drizzle-orm';
import { env } from '../../apps/api/src/config.js';
import { createDb } from '../../apps/api/src/db/client.js';
import { sessionActivities, studySessions, users } from '../../apps/api/src/db/schema.js';

declare global {
  interface Window {
    __layoutShifts: number[];
  }
}

const screenshotDir = 'test-results/screenshots/screenshots/tutor-optimistic';
mkdirSync(screenshotDir, { recursive: true });
const pageContextScreenshotDir = 'test-results/screenshots/screenshots/tutor-page-context';
mkdirSync(pageContextScreenshotDir, { recursive: true });
const greetingScreenshotDir = 'test-results/screenshots/screenshots/tutor-greeting';
mkdirSync(greetingScreenshotDir, { recursive: true });
const headerScreenshotDir = 'test-results/screenshots/screenshots/tutor-header';
mkdirSync(headerScreenshotDir, { recursive: true });
const latexScreenshotDir = 'test-results/screenshots/screenshots/tutor-latex';
mkdirSync(latexScreenshotDir, { recursive: true });
const tutorMathScreenshotDir = 'test-results/screenshots/screenshots/tutor-math';
mkdirSync(tutorMathScreenshotDir, { recursive: true });
const tutorSidebarScreenshotDir = 'test-results/screenshots/shots/tutor-sidebar';
mkdirSync(tutorSidebarScreenshotDir, { recursive: true });
let sessionId = '';

async function waitForTutorSidebarToSettle(page: Page, panelSelector: string) {
  const panel = page.locator(panelSelector);
  const wrapper = page.locator('[data-slot="sidebar-wrapper"]');
  await expect
    .poll(async () => {
      const panelRight = await panel.evaluate((element) => element.getBoundingClientRect().right);
      const expectedRight =
        (await panel.getAttribute('data-mobile')) === 'true'
          ? await page.evaluate(() => window.innerWidth)
          : await wrapper.evaluate((element) => element.getBoundingClientRect().right);
      return Math.abs(expectedRight - panelRight);
    })
    .toBeLessThanOrEqual(0.25);
}

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

async function openMockedTutorReply(page: Page, threadId: string, question: string, reply: string) {
  const updatedAt = '2026-01-01T12:00:00.002Z';
  let requestBody: Record<string, unknown> | undefined;
  const messages = [
    {
      id: `${threadId}-user`,
      role: 'user',
      content: question,
      createdAt: '2026-01-01T12:00:00.001Z',
    },
    {
      id: `${threadId}-assistant`,
      role: 'assistant',
      content: reply,
      createdAt: updatedAt,
    },
  ];
  const thread = {
    id: threadId,
    conceptId: 'supervised-learning',
    title: 'Math display test',
    updatedAt,
  };

  await page.route('**/api/tutor/threads**', async (route) => {
    if (route.request().method() === 'POST') {
      requestBody = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ thread, messages }),
      });
      return;
    }
    if (route.request().url().endsWith(`/api/tutor/threads/${threadId}`)) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          thread: {
            ...thread,
            conceptTitle: 'Supervised learning',
            messageCount: messages.length,
            lastMessagePreview: question,
          },
          messages,
        }),
      });
      return;
    }
    await route.continue();
  });

  await page.goto(`/session/${sessionId}`);
  await expect(page.getByRole('heading', { name: 'Supervised learning' })).toBeVisible();
  const visibleQuestion = page.getByTestId('lesson-problem').locator('h3');
  await expect(visibleQuestion).toHaveText(/^Question \d+$/);
  const visibleQuestionLabel = (await visibleQuestion.textContent()) ?? '';
  await page.getByRole('button', { name: 'Ask the tutor' }).click();
  const tutor = page.getByRole('complementary', { name: 'Tutor' });
  const textarea = tutor.getByLabel('Ask the tutor');
  await textarea.fill(question);
  await textarea.press('Enter');
  const assistantMessage = tutor.getByTestId('tutor-assistant-message');
  await expect(assistantMessage.locator('.katex').first()).toBeVisible();
  await waitForTutorSidebarToSettle(page, '[data-slot="sidebar-container"]');
  return { tutor, assistantMessage, requestBody, visibleQuestionLabel };
}

type MockedTutorMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
};

async function openMockedLongTutorThread(page: Page, threadId: string) {
  const question = 'Open the long tutor thread.';
  const updatedAt = '2026-01-01T12:00:00.002Z';
  let messages: MockedTutorMessage[] = [
    {
      id: `${threadId}-user`,
      role: 'user',
      content: question,
      createdAt: '2026-01-01T12:00:00.001Z',
    },
    {
      id: `${threadId}-assistant`,
      role: 'assistant',
      content: Array.from(
        { length: 20 },
        (_, index) =>
          `Reply ${index + 1}: ${'This explanation adds enough detail to make the tutor conversation scroll. '.repeat(4)}`,
      ).join('\n\n'),
      createdAt: updatedAt,
    },
  ];
  const thread = {
    id: threadId,
    conceptId: 'supervised-learning',
    title: 'Long tutor thread',
    updatedAt,
  };
  let postCount = 0;

  await page.addInitScript(() => {
    localStorage.removeItem('academy.tutor.width');
    localStorage.removeItem('academy.tutor.thread');
    localStorage.setItem('academy.tutor.open', 'false');
  });
  await page.route('**/api/tutor/threads**', async (route) => {
    const request = route.request();
    const url = request.url();
    if (request.method() === 'POST') {
      postCount += 1;
      if (postCount > 1) {
        const { question: nextQuestion } = request.postDataJSON() as { question: string };
        const newMessages: MockedTutorMessage[] = [
          {
            id: `${threadId}-follow-up-${postCount}`,
            role: 'user',
            content: nextQuestion,
            createdAt: '2026-01-01T12:01:00.001Z',
          },
          {
            id: `${threadId}-follow-up-reply-${postCount}`,
            role: 'assistant',
            content: `Tutor reply to: ${nextQuestion}`,
            createdAt: '2026-01-01T12:01:00.002Z',
          },
        ];
        messages = [...messages, ...newMessages];
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ thread, messages: newMessages }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ thread, messages }),
      });
      return;
    }
    if (url.endsWith(`/api/tutor/threads/${threadId}`)) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          thread: {
            ...thread,
            conceptTitle: 'Supervised learning',
            messageCount: messages.length,
            lastMessagePreview: messages.at(-1)?.content,
          },
          messages,
        }),
      });
      return;
    }
    if (url.endsWith('/api/tutor/threads')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            ...thread,
            conceptTitle: 'Supervised learning',
            messageCount: messages.length,
            lastMessagePreview: messages.at(-1)?.content,
          },
        ]),
      });
      return;
    }
    await route.continue();
  });

  await page.goto(`/session/${sessionId}`);
  await expect(page.getByRole('heading', { name: 'Supervised learning' })).toBeVisible();
  await page.getByRole('button', { name: 'Ask the tutor' }).click();
  const tutor = page.getByRole('complementary', { name: 'Tutor' });
  await tutor.getByLabel('Ask the tutor').fill(question);
  await tutor.getByLabel('Ask the tutor').press('Enter');
  await expect(tutor.getByTestId('tutor-assistant-message').last()).toContainText('Reply 20:');
  await waitForTutorSidebarToSettle(page, '[data-slot="sidebar-container"]');
  return { tutor, conversation: tutor.locator('.tutor-message-scroll-area') };
}

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

test('restored tutor sidebar loads while the tutor flag is pending', async ({ page }) => {
  let startTodayRequest!: () => void;
  let releaseTodayResponse!: () => void;
  const todayRequestStarted = new Promise<void>((resolve) => {
    startTodayRequest = resolve;
  });
  const todayResponseGate = new Promise<void>((resolve) => {
    releaseTodayResponse = resolve;
  });

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.addInitScript(() => {
    localStorage.removeItem('academy.tutor.thread');
    localStorage.setItem('academy.tutor.open', 'true');
  });
  await page.route('**/api/tutor/status', async (route) => {
    startTodayRequest();
    await todayResponseGate;
    await route.continue();
  });

  const navigation = page.goto('/course');
  await todayRequestStarted;
  const tutor = page.getByRole('complementary', { name: 'Tutor' });
  const unavailable = tutor.getByText('Tutor is unavailable.', { exact: true });
  try {
    await expect(tutor).toBeVisible();
    await expect(unavailable).toHaveCount(0);
    await expect(tutor.getByRole('status', { name: 'Loading tutor' })).toBeVisible();
    const loadingPosition = await tutor
      .getByRole('status', { name: 'Loading tutor' })
      .evaluate((element) => {
        const content = element.closest('[data-slot="sidebar-content"]');
        if (!content) throw new Error('Expected sidebar content');
        const rect = element.getBoundingClientRect();
        const bounds = content.getBoundingClientRect();
        return { actual: rect.y + rect.height / 2, expected: bounds.y + bounds.height / 2 };
      });
    expect(Math.abs(loadingPosition.actual - loadingPosition.expected)).toBeLessThan(1);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await expect(unavailable).toHaveCount(0);
  } finally {
    releaseTodayResponse();
  }

  await navigation;
  await expect(tutor.getByRole('heading', { name: 'Chats' })).toBeVisible();
  await expect(tutor.getByRole('button', { name: 'New chat' }).first()).toBeVisible();
});

test('tutor sidebar defaults to 448px when width storage is empty', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    localStorage.removeItem('academy.tutor.width');
    localStorage.removeItem('academy.tutor.thread');
    localStorage.setItem('academy.tutor.open', 'true');
  });
  await page.goto('/course');

  const tutor = page.getByRole('complementary', { name: 'Tutor' });
  const container = tutor.locator('[data-slot="sidebar-container"]');
  await expect(container).toBeVisible();
  await expect
    .poll(() => container.evaluate((element) => element.getBoundingClientRect().width))
    .toBe(448);
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('academy.tutor.width')))
    .toBeNull();
});

test('tutor sidebar width resizes, persists, responds to the keyboard, and clamps', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    if (sessionStorage.getItem('tutor-width-test-initialized') !== 'true') {
      localStorage.removeItem('academy.tutor.width');
      localStorage.removeItem('academy.tutor.thread');
      localStorage.setItem('academy.tutor.open', 'true');
      sessionStorage.setItem('tutor-width-test-initialized', 'true');
    }
  });
  await page.goto('/course');

  const tutor = page.getByRole('complementary', { name: 'Tutor' });
  const container = tutor.locator('[data-slot="sidebar-container"]');
  const separator = tutor.getByRole('separator', { name: 'Resize tutor' });
  const width = () => container.evaluate((element) => element.getBoundingClientRect().width);
  const inset = page.locator('[data-slot="sidebar-inset"]');
  const insetWidthBefore = await inset.evaluate((element) => element.getBoundingClientRect().width);
  await expect.poll(width).toBe(448);

  const dragBy = async (amount: number) => {
    const box = await separator.boundingBox();
    if (!box) throw new Error('Tutor resize separator is not visible');
    const x = box.x + box.width / 2;
    const y = box.y + 100;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x - amount, y, { steps: 8 });
    await page.mouse.up();
  };

  await dragBy(200);
  await expect.poll(width).toBe(648);
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('academy.tutor.width')))
    .toBe('648');
  const insetWidthAfter = await inset.evaluate((element) => element.getBoundingClientRect().width);
  expect(Math.abs(insetWidthBefore - insetWidthAfter - 200)).toBeLessThanOrEqual(4);
  await page.screenshot({ path: `${tutorSidebarScreenshotDir}/widened.png` });

  await page.reload();
  await expect.poll(width).toBe(648);
  await separator.press('ArrowLeft');
  await expect.poll(width).toBe(664);
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('academy.tutor.width')))
    .toBe('664');

  const box = await separator.boundingBox();
  if (!box) throw new Error('Tutor resize separator is not visible');
  const x = box.x + box.width / 2;
  const y = box.y + 100;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(0, y, { steps: 8 });
  await page.mouse.up();
  await expect.poll(width).toBe(768);
  await expect(separator).toHaveAttribute('aria-valuemax', '768');
  await expect(separator).toHaveAttribute('aria-valuenow', '768');
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('academy.tutor.width')))
    .toBe('768');

  await page.setViewportSize({ width: 800, height: 900 });
  await expect.poll(width).toBe(320);
  await expect(separator).toHaveAttribute('aria-valuemax', '320');
  await page.reload();
  await expect.poll(width).toBe(320);
  await page.setViewportSize({ width: 1440, height: 900 });

  await separator.dblclick();
  await expect.poll(width).toBe(448);
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('academy.tutor.width')))
    .toBe('448');
});

test('chat text stays visible while Markdown loads', async ({ page }) => {
  let releaseMarkdown!: () => void;
  let markMarkdownRequested!: () => void;
  const markdownGate = new Promise<void>((resolve) => {
    releaseMarkdown = resolve;
  });
  const markdownRequested = new Promise<void>((resolve) => {
    markMarkdownRequested = resolve;
  });
  await page.route('**/src/components/markdown.tsx*', async (route) => {
    markMarkdownRequested();
    await markdownGate;
    await route.continue();
  });
  await page.goto('/course');
  await page.getByRole('button', { name: 'Open tutor' }).click();
  const tutor = page.getByRole('complementary', { name: 'Tutor' });
  await tutor.getByRole('button', { name: 'New chat' }).click();
  const question = 'Explain this without hiding my message';
  try {
    await tutor.getByLabel('Ask the tutor').fill(question);
    await tutor.getByLabel('Ask the tutor').press('Enter');
    await markdownRequested;
    await expect(tutor.getByTestId('tutor-user-message')).toContainText(question);
    await expect(tutor.getByTestId('tutor-assistant-message')).toContainText(
      `Tutor reply to: ${question}`,
    );
    await expect(tutor.getByRole('status', { name: 'Loading message' })).toHaveCount(0);
    await expect(tutor.locator('[data-testid="tutor-user-message"] svg')).toHaveCount(0);
    await page.screenshot({ path: `${screenshotDir}/markdown-loading.png` });
  } finally {
    releaseMarkdown();
  }
  await expect(tutor.getByTestId('tutor-assistant-message').locator('.markdown')).toBeVisible();
});

test('pending tutor reply uses a skeleton within the mobile conversation', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let releaseReply!: () => void;
  const replyGate = new Promise<void>((resolve) => {
    releaseReply = resolve;
  });
  await page.route('**/api/tutor/threads**', async (route) => {
    if (route.request().method() === 'POST') await replyGate;
    await route.continue();
  });
  await page.goto('/course');
  await page.getByRole('button', { name: 'Open tutor' }).click();
  const conversation = page.getByLabel('Ask the tutor');
  await page.getByRole('button', { name: 'New chat' }).click();
  try {
    await conversation.fill('Explain this topic');
    await conversation.press('Enter');
    await expect(page.getByTestId('tutor-user-message')).toContainText('Explain this topic');
    const loading = page.getByRole('status', { name: 'Tutor is responding' });
    await expect(loading).toBeVisible();
    await expect(loading.locator('[data-slot="skeleton"]')).toHaveCount(3);
    const bounds = await loading.boundingBox();
    if (!bounds) throw new Error('Reply skeleton is not visible');
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
    await page.screenshot({ path: `${screenshotDir}/tutor-pending-mobile.png` });
  } finally {
    releaseReply();
  }
  await expect(page.getByTestId('tutor-assistant-message')).toContainText(
    'Tutor reply to: Explain this topic',
  );
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
  let markTutorRequestStarted!: () => void;
  let releaseTutorRequest!: () => void;
  const tutorRequestStarted = new Promise<void>((resolve) => {
    markTutorRequestStarted = resolve;
  });
  const tutorRequestGate = new Promise<void>((resolve) => {
    releaseTutorRequest = resolve;
  });
  await page.route('**/api/tutor/threads**', async (route) => {
    if (route.request().method() === 'POST') {
      markTutorRequestStarted();
      await tutorRequestGate;
    }
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
  const conversationHeader = tutor.locator('[data-slot="sidebar-header"]');
  await expect(conversationHeader.getByTestId('tutor-conversation-title')).toHaveClass(/sr-only/);
  await expect(conversationHeader.getByText('Supervised learning', { exact: true })).toHaveCount(0);
  const contextLine = tutor.getByTestId('tutor-reading-context');
  await expect(contextLine).toContainText(/^Context: Supervised learning · step 1 of \d+$/);
  await expect(contextLine).toHaveAttribute('title', /^Context: /);
  const contextFollowsSend = await tutor.evaluate((element) => {
    const sendButton = element.querySelector<HTMLButtonElement>('[aria-label="Send"]');
    const line = element.querySelector('[data-testid="tutor-reading-context"]');
    return Boolean(
      sendButton &&
        line &&
        (sendButton.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
    );
  });
  expect(contextFollowsSend).toBe(true);
  await tutor.getByRole('button', { name: 'New chat' }).click();
  await expect(tutor.getByTestId('tutor-conversation-title')).toHaveText('New chat');
  await expect(tutor.getByText('Start a conversation')).toHaveCount(0);

  const textarea = tutor.getByLabel('Ask the tutor');
  await textarea.fill('Explain the first step');
  const sendButton = tutor.locator('form button[type="submit"]');
  const sendButtonBefore = await sendButton.boundingBox();
  if (!sendButtonBefore) throw new Error('Tutor Send button is not visible');
  await textarea.press('Enter');
  await tutorRequestStarted;
  await expect(textarea).toHaveValue('');
  await expect(
    tutor.getByTestId('tutor-user-message').filter({ hasText: 'Explain the first step' }),
  ).toHaveCount(1);
  await expect(tutor.getByRole('status', { name: 'Tutor is responding' })).toBeVisible();
  await expect(tutor.getByTestId('tutor-thinking-bubble')).toBeVisible();
  await expect(
    tutor.getByTestId('tutor-thinking-bubble').locator('[data-slot="skeleton"]'),
  ).toHaveCount(3);
  await expect(tutor.getByTestId('tutor-thinking-bubble').locator('svg')).toHaveCount(0);
  await expect(sendButton).toHaveAttribute('aria-busy', 'true');
  await expect(sendButton).toHaveAttribute('data-loading', 'true');
  await expect(sendButton.getByTestId('button-spinner')).toBeVisible();
  await expect(sendButton.getByText('Send', { exact: true })).toHaveCSS('opacity', '0');
  const sendButtonAfter = await sendButton.boundingBox();
  if (!sendButtonAfter) throw new Error('Loading Tutor Send button is not visible');
  expect(Math.abs(sendButtonAfter.width - sendButtonBefore.width)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(sendButtonAfter.height - sendButtonBefore.height)).toBeLessThanOrEqual(0.5);
  await expect
    .poll(() => sendButton.evaluate((element) => getComputedStyle(element).opacity))
    .toBe('1');
  await textarea.fill('Draft while waiting');
  await expect(textarea).toHaveValue('Draft while waiting');
  await expect(sendButton).toBeDisabled();
  await textarea.fill('');
  await expect(textarea).toHaveValue('');
  await page.screenshot({ path: `${screenshotDir}/tutor-pending.png` });

  releaseTutorRequest();
  await expect(tutor.getByText('Tutor reply to: Explain the first step')).toBeVisible();
  await expect(
    tutor.getByTestId('tutor-user-message').filter({ hasText: 'Explain the first step' }),
  ).toHaveCount(1);
  await expect(conversationHeader.getByTestId('tutor-conversation-title')).toHaveClass(/sr-only/);
  const visibleHeaderText = await conversationHeader.evaluate((element) => {
    const clone = element.cloneNode(true) as HTMLElement;
    clone.querySelector('[data-testid="tutor-conversation-title"]')?.remove();
    return clone.textContent?.trim() ?? '';
  });
  expect(visibleHeaderText).toBe('Chats');
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

  const restoredHeader = restoredTutor.locator('[data-slot="sidebar-header"]');
  await expect(restoredHeader.getByTestId('tutor-conversation-title')).toHaveClass(/sr-only/);
  const restoredVisibleHeaderText = await restoredHeader.evaluate((element) => {
    const clone = element.cloneNode(true) as HTMLElement;
    clone.querySelector('[data-testid="tutor-conversation-title"]')?.remove();
    return clone.textContent?.trim() ?? '';
  });
  expect(restoredVisibleHeaderText).toBe('Chats');
  await restoredTutor.getByRole('button', { name: 'New chat' }).click();
  await expect(restoredTutor.getByTestId('tutor-conversation-title')).toHaveText('New chat');
  await expect(restoredTutor.getByText('Start a conversation')).toHaveCount(0);
  await expect(restoredTutor.getByTestId('tutor-reading-context')).toContainText(
    /^Context: Supervised learning/,
  );
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
  await expect(restoredTutor.getByTestId('tutor-reading-context')).toContainText(
    /^Context: Supervised learning/,
  );
  await expect(restoredTutor.getByTestId('tutor-user-message')).toHaveCount(0);
  await expect(restoredTutor.getByText('Start a conversation')).toHaveCount(0);

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

test('conversation-header new chat focuses the tutor composer', async ({ page }) => {
  await page.goto(`/session/${sessionId}`);
  await expect(page.getByRole('heading', { name: 'Supervised learning' })).toBeVisible();
  await page.getByRole('button', { name: 'Ask the tutor' }).click();

  const tutor = page.getByRole('complementary', { name: 'Tutor' });
  const composer = tutor.getByLabel('Ask the tutor');
  await expect(composer).toBeFocused();
  await tutor.getByRole('button', { name: 'New chat' }).click();
  await expect(composer).toBeFocused();
  await page.keyboard.type('x');
  await expect(composer).toHaveValue('x');
});

test('Chat lists expose one New chat action and focus the composer', async ({ page }) => {
  await page.goto(`/session/${sessionId}`);
  await expect(page.getByRole('heading', { name: 'Supervised learning' })).toBeVisible();
  await page.getByRole('button', { name: 'Ask the tutor' }).click();

  const tutor = page.getByRole('complementary', { name: 'Tutor' });
  const composer = tutor.getByLabel('Ask the tutor');
  await tutor.getByRole('button', { name: 'Chats' }).click();
  await expect(tutor.getByRole('heading', { name: 'Chats' })).toBeVisible();
  await expect(tutor.getByRole('button', { name: 'New chat', exact: true })).toHaveCount(1);
  await tutor.getByRole('button', { name: 'New chat', exact: true }).click();
  await expect(composer).toBeFocused();
  await page.keyboard.type('x');
  await expect(composer).toHaveValue('x');

  await tutor.getByRole('button', { name: 'Chats' }).click();
  await expect(tutor.getByRole('button', { name: 'New chat', exact: true })).toHaveCount(1);
  await tutor.getByRole('button', { name: 'New chat', exact: true }).click();
  await expect(composer).toBeFocused();
  await composer.fill('Explain the first step');
  await tutor.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(tutor.getByTestId('tutor-assistant-message')).toHaveCount(1);
  await tutor.getByRole('button', { name: 'Chats', exact: true }).click();
  await expect(tutor.getByRole('button', { name: 'New chat', exact: true })).toHaveCount(1);
  await expect(tutor.getByText('No chats yet')).toHaveCount(0);
  await tutor
    .locator('[data-slot="sidebar-header"]')
    .getByRole('button', { name: 'New chat', exact: true })
    .click();
  await expect(composer).toBeFocused();
  const mobileTutor = page.locator('[data-slot="sidebar"][data-mobile="true"]');
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(mobileTutor).toBeVisible();
    await waitForTutorSidebarToSettle(page, '[data-slot="sidebar"][data-mobile="true"]');
    const panel = await mobileTutor.boundingBox();
    expect(panel?.width).toBeGreaterThanOrEqual(width - 1);
    expect(Math.abs(panel?.x ?? 100)).toBeLessThan(1);
  }
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

test('tutor reply renders TeX inline and display delimiters', async ({ page }) => {
  const threadId = '00000000-0000-4000-8000-000000000002';
  const updatedAt = '2026-01-01T12:00:00.002Z';
  const reply = String.raw`\[ \frac{\partial f}{\partial w}=2(wx+b-y)x \]

\( x \)`;
  const messages = [
    {
      id: 'math-user-message',
      role: 'user',
      content: 'Show me the derivative.',
      createdAt: '2026-01-01T12:00:00.001Z',
    },
    {
      id: 'math-assistant-message',
      role: 'assistant',
      content: reply,
      createdAt: updatedAt,
    },
  ];
  const thread = {
    id: threadId,
    conceptId: 'supervised-learning',
    title: 'Derivative question',
    updatedAt,
  };
  await page.route('**/api/tutor/threads**', async (route) => {
    if (route.request().method() === 'POST') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ thread, messages }),
      });
      return;
    }
    if (route.request().url().endsWith(`/api/tutor/threads/${threadId}`)) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          thread: {
            ...thread,
            conceptTitle: 'Supervised learning',
            messageCount: messages.length,
            lastMessagePreview: 'Show me the derivative.',
          },
          messages,
        }),
      });
      return;
    }
    await route.continue();
  });

  await page.goto(`/session/${sessionId}`);
  await expect(page.getByRole('heading', { name: 'Supervised learning' })).toBeVisible();
  await page.getByRole('button', { name: 'Ask the tutor' }).click();
  const tutor = page.getByRole('complementary', { name: 'Tutor' });
  const textarea = tutor.getByLabel('Ask the tutor');
  await textarea.fill('Show me the derivative.');
  await textarea.press('Enter');

  const assistantMessage = tutor.getByTestId('tutor-assistant-message');
  await expect(assistantMessage.locator('.katex')).toHaveCount(2);
  const renderedMath = assistantMessage.locator('.katex-html');
  const renderedMathText = (await renderedMath.allTextContents()).join('');
  expect(renderedMathText).not.toContain('\\frac');
  expect(renderedMathText).not.toContain('\\(');
  expect(renderedMathText).not.toContain('\\[');
  await page.screenshot({ path: `${latexScreenshotDir}/reply.png`, fullPage: true });
});

test('copying tutor math preserves its TeX source as plain text', async ({ page }) => {
  const { assistantMessage } = await openMockedTutorReply(
    page,
    '00000000-0000-4000-8000-000000000008',
    'What does this batch shape mean?',
    'Keep one row per example: $B \\times d_{in}$ is the batch shape.',
  );
  const paragraph = assistantMessage.locator('p').filter({ hasText: 'Keep one row per example' });
  await expect(paragraph.locator('.katex')).toBeVisible();
  const copiedText = await paragraph.evaluate((element) => {
    const selection = window.getSelection();
    if (!selection) throw new Error('Could not select the tutor message');
    const range = document.createRange();
    range.selectNodeContents(element);
    selection.removeAllRanges();
    selection.addRange(range);
    let plainText = '';
    document.addEventListener(
      'copy',
      (event) => {
        plainText = event.clipboardData?.getData('text/plain') ?? '';
      },
      { once: true },
    );
    document.execCommand('copy');
    selection.removeAllRanges();
    return plainText;
  });
  expect(copiedText).toContain('$B \\times d_{in}$');
  expect(copiedText.split(/\r?\n/).filter((line) => line.trim().length === 1)).toEqual([]);
});

test('lesson step tutor request includes the visible question label', async ({ page }) => {
  const { requestBody, visibleQuestionLabel } = await openMockedTutorReply(
    page,
    '00000000-0000-4000-8000-000000000007',
    'Can you help with this question?',
    'Compare $z$ and $\\sigma(z)$.',
  );

  expect(visibleQuestionLabel).toMatch(/^Question \d+$/);
  expect(requestBody).toMatchObject({ questionLabel: visibleQuestionLabel });
});

test('sending a tutor message scrolls back to the latest message', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { tutor, conversation } = await openMockedLongTutorThread(
    page,
    '00000000-0000-4000-8000-000000000006',
  );
  const atBottom = () =>
    conversation.evaluate(
      (element) => element.scrollTop + element.clientHeight >= element.scrollHeight - 2,
    );
  await conversation.evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect.poll(atBottom).toBe(false);

  const textarea = tutor.getByLabel('Ask the tutor');
  await textarea.fill('Return to the latest message');
  await textarea.press('Enter');
  await expect(tutor.getByTestId('tutor-assistant-message').last()).toContainText(
    'Tutor reply to: Return to the latest message',
  );
  await expect.poll(atBottom).toBe(true);
});

test('tutor scroll-to-latest button returns to the bottom', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { tutor, conversation } = await openMockedLongTutorThread(
    page,
    '00000000-0000-4000-8000-000000000007',
  );
  const atBottom = () =>
    conversation.evaluate(
      (element) => element.scrollTop + element.clientHeight >= element.scrollHeight - 2,
    );
  await conversation.evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect.poll(atBottom).toBe(false);

  const scrollButton = tutor.getByRole('button', { name: 'Scroll to latest message' });
  await expect(scrollButton).toBeVisible();
  await page.screenshot({ path: `${tutorSidebarScreenshotDir}/scroll-latest.png` });
  await scrollButton.click();
  await expect.poll(atBottom).toBe(true);
  await expect(scrollButton).toHaveCount(0);
});

test('long tutor display math wraps within its message at desktop and mobile widths', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => localStorage.removeItem('academy.tutor.width'));
  const reply = String.raw`$$E[X]=0\cdot P(X=0)+1\cdot P(X=1)+2\cdot P(X=2)+3\cdot P(X=3)$$`;
  const { assistantMessage } = await openMockedTutorReply(
    page,
    '00000000-0000-4000-8000-000000000003',
    'Show the expected value formula.',
    reply,
  );
  const displayForViewport = (mobile: boolean) =>
    mobile
      ? page.locator('[data-slot="sidebar"][data-mobile="true"] .tutor-display-math')
      : assistantMessage.locator('.tutor-display-math');
  const measure = async (viewport: string, mobile = false) => {
    const display = displayForViewport(mobile);
    const geometry = await display.evaluate((element) => {
      const displayRect = element.getBoundingClientRect();
      const messageContent = element.closest('.markdown')?.parentElement;
      const messageRect = messageContent?.getBoundingClientRect();
      const panelRect = element.closest('.bg-sidebar')?.getBoundingClientRect();
      if (!messageContent || !messageRect || !panelRect) {
        throw new Error('Tutor math containers were not found');
      }
      const lineHeight = Number.parseFloat(getComputedStyle(messageContent).lineHeight);
      return {
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
        displayLeft: displayRect.left,
        displayRight: displayRect.right,
        messageContentRight: messageRect.right,
        panelRight: panelRect.right,
        height: displayRect.height,
        lineHeight,
        viewportWidth: window.innerWidth,
      };
    });
    console.log(`tutor math ${viewport}: ${JSON.stringify(geometry)}`);
    expect(geometry.scrollWidth - geometry.clientWidth).toBeLessThanOrEqual(1);
    expect(geometry.displayRight).toBeLessThanOrEqual(geometry.messageContentRight + 0.5);
    expect(geometry.messageContentRight).toBeLessThanOrEqual(geometry.panelRight + 0.5);
    expect(geometry.panelRight).toBeLessThanOrEqual(geometry.viewportWidth + 0.5);
    expect(geometry.height).toBeGreaterThan(geometry.lineHeight);
    return geometry;
  };

  await expect(assistantMessage.locator('.katex-error')).toHaveCount(0);
  await measure('desktop');
  await page.screenshot({ path: `${tutorSidebarScreenshotDir}/default-width.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileTutor = page.locator('[data-slot="sidebar"][data-mobile="true"]');
  await expect(mobileTutor).toBeVisible();
  await waitForTutorSidebarToSettle(page, '[data-slot="sidebar"][data-mobile="true"]');
  await expect(mobileTutor.getByRole('separator', { name: 'Resize tutor' })).toHaveCount(0);
  await measure('mobile', true);
  await page.screenshot({ path: `${tutorSidebarScreenshotDir}/mobile.png` });
});

test('wide tutor fractions stay within their message and panel', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const reply = String.raw`$$\mathrm{MSE}(c)=\frac{(c-23)^2+(c-26)^2+(c-41)^2}{3}$$`;
  const { assistantMessage } = await openMockedTutorReply(
    page,
    '00000000-0000-4000-8000-000000000013',
    'Show the mean squared error formula.',
    reply,
  );
  const displayForViewport = (mobile: boolean) =>
    mobile
      ? page.locator('[data-slot="sidebar"][data-mobile="true"] .tutor-display-math')
      : assistantMessage.locator('.tutor-display-math');
  const measure = async (viewport: string, mobile = false) => {
    const display = displayForViewport(mobile);
    const geometry = await display.evaluate((element) => {
      const displayRect = element.getBoundingClientRect();
      const messageRect = element.closest('.markdown')?.parentElement?.getBoundingClientRect();
      const panelRect = element.closest('.bg-sidebar')?.getBoundingClientRect();
      if (!messageRect || !panelRect) throw new Error('Tutor math containers were not found');
      return {
        displayRight: displayRect.right,
        messageRight: messageRect.right,
        panelRight: panelRect.right,
        viewportWidth: window.innerWidth,
      };
    });
    console.log(`MSE tutor math ${viewport}: ${JSON.stringify(geometry)}`);
    expect(geometry.displayRight).toBeLessThanOrEqual(geometry.messageRight + 0.5);
    expect(geometry.messageRight).toBeLessThanOrEqual(geometry.panelRight + 0.5);
    expect(geometry.panelRight).toBeLessThanOrEqual(geometry.viewportWidth + 0.5);
  };

  await measure('desktop');
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileTutor = page.locator('[data-slot="sidebar"][data-mobile="true"]');
  await expect(mobileTutor).toBeVisible();
  await waitForTutorSidebarToSettle(page, '[data-slot="sidebar"][data-mobile="true"]');
  await measure('mobile', true);
});

test('short tutor display math fits without scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { tutor, assistantMessage } = await openMockedTutorReply(
    page,
    '00000000-0000-4000-8000-000000000004',
    'Show a short equation.',
    '$$x^2+y^2=1$$',
  );
  const display = assistantMessage.locator('.tutor-display-math');
  await expect(assistantMessage.locator('.katex-error')).toHaveCount(0);
  await expect
    .poll(() => display.evaluate((element) => element.scrollWidth - element.clientWidth))
    .toBe(0);
  await tutor.screenshot({
    path: `${tutorMathScreenshotDir}/short-equation.png`,
    animations: 'disabled',
  });
});

test('aligned tutor display math fits at desktop panel width', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const reply = String.raw`Let $S$ be the sum of squared errors.

$$\begin{aligned}
\mathrm{MSE} &= \frac{S}{n}\\
S &= \sum_i e_i^2
\end{aligned}$$`;
  const { tutor, assistantMessage } = await openMockedTutorReply(
    page,
    '00000000-0000-4000-8000-000000000005',
    'Show the mean squared error in two steps.',
    reply,
  );
  const display = assistantMessage.locator('.katex-display');
  await expect(assistantMessage.locator('.katex-error')).toHaveCount(0);
  await expect
    .poll(() => display.evaluate((element) => element.scrollWidth - element.clientWidth))
    .toBe(0);
  await tutor.screenshot({
    path: `${tutorMathScreenshotDir}/aligned-equation.png`,
    animations: 'disabled',
  });
});

test('tutor Context follows the session, lesson, and home pages', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
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
  const contextLine = tutor.getByTestId('tutor-reading-context');
  await expect(contextLine).toHaveText(/^Context: Supervised learning · step 1 of \d+$/);
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
  await expect(contextLine).toHaveText('Context: Supervised learning · full lesson');
  await page.screenshot({ path: `${headerScreenshotDir}/desktop.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileTutor = page.locator('[data-slot="sidebar"][data-mobile="true"]');
  await expect(mobileTutor).toBeVisible();
  await expect(mobileTutor.getByTestId('tutor-conversation-title')).toHaveText(
    'What does this step mean?',
  );
  await page.screenshot({ path: `${headerScreenshotDir}/mobile.png` });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({
    path: `${pageContextScreenshotDir}/tutor-lesson.png`,
    fullPage: true,
  });

  await page.getByRole('link', { name: 'Home' }).click();
  await expect(page).toHaveURL('/');
  await expect(tutor.getByTestId('tutor-reading-context')).toHaveCount(0);
});

test('long tutor drafts keep the composer controls in view on desktop and mobile', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.addInitScript(() => {
    localStorage.setItem('academy.tutor.open', 'true');
  });
  await page.goto('/course');

  const initialTutor = page.getByRole('complementary', { name: 'Tutor' });
  await expect(initialTutor).toBeVisible();
  await initialTutor.getByRole('button', { name: 'New chat' }).first().click();

  const draft = 'x'.repeat(7000);
  for (const viewport of [
    { width: 1280, height: 900, mobile: false },
    { width: 390, height: 844, mobile: true },
  ]) {
    if (viewport.mobile) await page.setViewportSize(viewport);
    const tutor = viewport.mobile
      ? page.locator('[data-slot="sidebar"][data-mobile="true"]')
      : page.getByRole('complementary', { name: 'Tutor' });
    await expect(tutor).toBeVisible();

    const textarea = tutor.getByLabel('Ask the tutor');
    await textarea.fill(draft);
    const sendButton = tutor.getByRole('button', { name: 'Send' });
    const characterCount = tutor.getByTestId('tutor-draft-length');
    await expect(characterCount).toHaveText('7,000 / 8,000');
    await expect(sendButton).toBeEnabled();

    const geometry = await textarea.evaluate((element) => {
      const panel = element.closest('[data-slot="sidebar"]');
      const panelHeight = panel?.getBoundingClientRect().height;
      const controlRects = [
        element.closest('form')?.querySelector('[aria-label="Send"]')?.getBoundingClientRect(),
        element
          .closest('form')
          ?.querySelector('[data-testid="tutor-draft-length"]')
          ?.getBoundingClientRect(),
      ];
      return {
        textareaHeight: element.getBoundingClientRect().height,
        textareaScrollHeight: element.scrollHeight,
        panelHeight: panelHeight ?? 0,
        controlsVisible: controlRects.every(
          (rect) => rect && rect.top >= 0 && rect.bottom <= window.innerHeight,
        ),
      };
    });
    expect(geometry.panelHeight).toBeGreaterThan(0);
    expect(geometry.textareaHeight).toBeLessThanOrEqual(geometry.panelHeight * 0.5);
    expect(geometry.textareaScrollHeight).toBeGreaterThan(geometry.textareaHeight);
    expect(geometry.controlsVisible).toBe(true);
    await sendButton.click({ trial: true });
  }
});
