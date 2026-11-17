import { mkdirSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { eq } from 'drizzle-orm';
import { env } from '../../apps/api/src/config.js';
import { createDb } from '../../apps/api/src/db/client.js';
import { sessionActivities, studySessions, users } from '../../apps/api/src/db/schema.js';

declare global {
  interface Window {
    __layoutShifts: number[];
    __tutorScrollSamples: number[];
    __tutorMessageSamples: string[][];
    __stopTutorMessageSampler: (() => void) | undefined;
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
const tutorSteerScreenshotDir = 'test-results/screenshots/shots/tutor-steer';
mkdirSync(tutorSteerScreenshotDir, { recursive: true });
const chatRaceScreenshotDir = '/home/ubuntu/briefs/chat/shots';
mkdirSync(chatRaceScreenshotDir, { recursive: true });
let sessionId = '';

async function waitForTutorSidebarToSettle(page: Page, panelSelector: string) {
  const panel = page.locator(panelSelector).last();
  const wrapper = page.locator('[data-slot="sidebar-wrapper"]').last();
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

async function startTutorMessageSampler(page: Page) {
  await page.evaluate(() => {
    const panel = document.querySelector('[aria-label="Tutor messages"]');
    if (!panel) throw new Error('Tutor conversation was not found');
    const sample = () => {
      window.__tutorMessageSamples.push(
        Array.from(panel.querySelectorAll('[data-testid="tutor-user-message"]')).map(
          (message) =>
            message.querySelector('.markdown')?.textContent?.trim() ??
            message.textContent?.trim() ??
            '',
        ),
      );
    };
    window.__tutorMessageSamples = [];
    const observer = new MutationObserver(sample);
    observer.observe(panel, { childList: true, characterData: true, subtree: true });
    window.__stopTutorMessageSampler = () => observer.disconnect();
    sample();
  });
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
  let actualThreadId = threadId;
  const messages = [
    {
      id: `${threadId}-user`,
      clientId: '',
      role: 'user',
      content: question,
      createdAt: '2026-01-01T12:00:00.001Z',
    },
    {
      id: `${threadId}-assistant`,
      clientId: null,
      role: 'assistant',
      content: reply,
      createdAt: updatedAt,
    },
  ];
  const thread = () => ({
    id: actualThreadId,
    conceptId: 'supervised-learning',
    title: 'Math display test',
    updatedAt,
  });

  await page.route('**/api/tutor/threads**', async (route) => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as {
        clientMessageId: string;
        threadId?: string;
      };
      requestBody = body;
      actualThreadId = body.threadId ?? actualThreadId;
      const userMessage = messages[0];
      if (userMessage) {
        messages[0] = { ...userMessage, clientId: body.clientMessageId };
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ thread: thread(), messages }),
      });
      return;
    }
    if (route.request().url().endsWith(`/api/tutor/threads/${actualThreadId}`)) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          thread: {
            ...thread(),
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
  clientId: string | null;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function openMockedLongTutorThread(page: Page, threadId: string) {
  const question = 'Open the long tutor thread.';
  const updatedAt = '2026-01-01T12:00:00.002Z';
  let messages: MockedTutorMessage[] = [
    {
      id: `${threadId}-user`,
      clientId: null,
      role: 'user',
      content: question,
      createdAt: '2026-01-01T12:00:00.001Z',
    },
    {
      id: `${threadId}-assistant`,
      clientId: null,
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

  await page.addInitScript((id) => {
    localStorage.removeItem('academy.tutor.width');
    localStorage.setItem('academy.tutor.thread', id);
    localStorage.setItem('academy.tutor.open', 'false');
  }, threadId);
  await page.route('**/api/tutor/threads**', async (route) => {
    const request = route.request();
    const url = request.url();
    if (request.method() === 'POST') {
      postCount += 1;
      const body = request.postDataJSON() as {
        question: string;
        clientMessageId: string;
      };
      const newMessages: MockedTutorMessage[] = [
        {
          id: `${threadId}-follow-up-${postCount}`,
          clientId: body.clientMessageId,
          role: 'user',
          content: body.question,
          createdAt: '2026-01-01T12:01:00.001Z',
        },
        {
          id: `${threadId}-follow-up-reply-${postCount}`,
          clientId: null,
          role: 'assistant',
          content: `Tutor reply to: ${body.question}`,
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
  await page.getByRole('button', { name: 'Open tutor' }).click();
  const tutor = page.getByRole('complementary', { name: 'Tutor' });
  await expect(tutor.getByTestId('tutor-assistant-message').last()).toContainText('Reply 20:');
  await waitForTutorSidebarToSettle(
    page,
    (page.viewportSize()?.width ?? 1440) < 768
      ? '[data-slot="sidebar"][data-mobile="true"]'
      : '[data-slot="sidebar-container"]',
  );
  return { tutor, conversation: tutor.locator('.tutor-message-scroll-area') };
}

test('Course tutor sidebar fills at least 90 percent of the viewport height', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    localStorage.setItem('academy.tutor.open', 'true');
  });
  await page.goto('/courses/fixture-course');
  const tutor = page.getByRole('complementary', { name: 'Tutor' });
  await expect(tutor).toBeVisible();
  const viewportHeight = await page.evaluate(() => window.innerHeight);
  expect(
    await tutor.evaluate((element) => element.getBoundingClientRect().height),
  ).toBeGreaterThanOrEqual(viewportHeight * 0.9);
});

test('tutor chat loading shows thread skeletons and an empty conversation state', async ({
  page,
}, testInfo) => {
  let releaseThreads!: () => void;
  const threadsGate = new Promise<void>((resolve) => {
    releaseThreads = resolve;
  });
  let releaseLesson!: () => void;
  const lessonGate = new Promise<void>((resolve) => {
    releaseLesson = resolve;
  });
  let threadsRequestStarted = false;
  let lessonRequestStarted = false;

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    localStorage.removeItem('academy.tutor.thread');
    localStorage.setItem('academy.tutor.open', 'true');
  });
  await page.route('**/api/tutor/threads**', async (route) => {
    const request = route.request();
    if (request.method() === 'GET' && new URL(request.url()).pathname === '/api/tutor/threads') {
      threadsRequestStarted = true;
      await threadsGate;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: '[]',
      });
      return;
    }
    await route.continue();
  });
  await page.route('**/api/lessons/supervised-learning/review', async (route) => {
    lessonRequestStarted = true;
    await lessonGate;
    await route.continue();
  });

  await page.goto('/lessons/supervised-learning');
  await expect.poll(() => lessonRequestStarted).toBe(true);
  await expect(page.getByTestId('route-skeleton')).toBeVisible();
  const tutor = page.getByRole('complementary', { name: 'Tutor' });
  await expect(tutor).toBeVisible();
  await expect(tutor.getByRole('heading', { name: 'Chats' })).toBeVisible();
  await expect.poll(() => threadsRequestStarted).toBe(true);
  await expect(tutor.getByTestId('tutor-thread-skeleton')).toHaveCount(4);

  const desktopPanelState = await page.evaluate(() => {
    const tutorPanel = document.querySelector<HTMLElement>(
      '[role="complementary"][aria-label="Tutor"]',
    );
    const insets = Array.from(
      document.querySelectorAll<HTMLElement>('[data-slot="sidebar-inset"]'),
    );
    const skeleton = document.querySelector<HTMLElement>('[data-testid="route-skeleton"]');
    const pageFrame = skeleton?.closest<HTMLElement>('[data-page-frame]');
    const pageStyle = pageFrame ? getComputedStyle(pageFrame) : null;
    return {
      mobile: tutorPanel?.getAttribute('data-mobile'),
      overlays: document.querySelectorAll('[data-slot="sheet-overlay"]').length,
      pageOpacity: pageStyle?.opacity,
      pageFilter: pageStyle?.filter,
      insets: insets.map((element) => {
        const style = getComputedStyle(element);
        return { opacity: style.opacity, filter: style.filter };
      }),
    };
  });
  expect(desktopPanelState.mobile).toBeNull();
  expect(desktopPanelState.overlays).toBe(0);
  expect(desktopPanelState.pageOpacity).toBe('1');
  expect(desktopPanelState.pageFilter).toBe('none');
  expect(desktopPanelState.insets.length).toBeGreaterThan(0);
  expect(
    desktopPanelState.insets.every(({ opacity, filter }) => opacity === '1' && filter === 'none'),
  ).toBe(true);

  mkdirSync(testInfo.outputDir, { recursive: true });
  await page.screenshot({
    path: testInfo.outputPath('tutor-threads-loading-1440x900.png'),
    animations: 'disabled',
  });

  releaseLesson();
  await expect(page.getByRole('heading', { name: 'Supervised learning' })).toBeVisible();
  await tutor.getByRole('button', { name: 'New chat', exact: true }).click();
  await expect(tutor.getByText('Loading chats…', { exact: true })).toHaveCount(0);
  await expect(tutor.getByLabel('Ask the tutor')).toBeVisible();
  releaseThreads();
  await expect(tutor.getByTestId('tutor-empty-conversation')).toHaveText(
    'No chats yet. Ask a question below.',
  );
  await tutor.getByRole('button', { name: 'Chats', exact: true }).click();
  await expect(tutor.getByTestId('tutor-empty-thread-list')).toContainText(
    'No chats yet. Ask a question below.',
  );
  await expect(tutor.getByRole('img', { name: 'Academy tortoise' })).toBeVisible();
  await expect(tutor.getByRole('button', { name: 'New chat', exact: true })).toBeVisible();
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

  const navigation = page.goto('/courses/fixture-course');
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
  await page.goto('/courses/fixture-course');

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
  await page.goto('/courses/fixture-course');

  const tutor = page.getByRole('complementary', { name: 'Tutor' });
  const container = tutor.locator('[data-slot="sidebar-container"]');
  const separator = tutor.getByRole('separator', { name: 'Resize tutor' });
  const width = () => container.evaluate((element) => element.getBoundingClientRect().width);
  const inset = page.locator('div[data-slot="sidebar-inset"]');
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
  await page.goto('/courses/fixture-course');
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

test('pending tutor reply shows pulsing Thinking within the mobile conversation', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let releaseReply!: () => void;
  const replyGate = new Promise<void>((resolve) => {
    releaseReply = resolve;
  });
  await page.route('**/api/tutor/threads**', async (route) => {
    if (route.request().method() === 'POST') await replyGate;
    await route.continue();
  });
  await page.goto('/courses/fixture-course');
  await page.getByRole('button', { name: 'Open tutor' }).click();
  const conversation = page.getByLabel('Ask the tutor');
  await page.getByRole('button', { name: 'New chat' }).click();
  try {
    await conversation.fill('Explain this topic');
    await conversation.press('Enter');
    await expect(page.getByTestId('tutor-user-message')).toContainText('Explain this topic');
    const loading = page.getByRole('status', { name: 'Thinking', exact: true });
    await expect(loading).toBeVisible();
    await expect(loading.locator('span').first()).toHaveCSS('animation-name', 'pulse');
    await expect(loading.locator('[data-slot="skeleton"]')).toHaveCount(0);
    const bounds = await loading.boundingBox();
    if (!bounds) throw new Error('Thinking indicator is not visible');
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
  let requestBody: Record<string, unknown> | undefined;
  await page.route('**/api/tutor/threads**', async (route) => {
    if (route.request().method() === 'POST') {
      requestBody = route.request().postDataJSON() as Record<string, unknown>;
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
  const mainContent = page.locator('div[data-slot="sidebar-inset"]');
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
  await tutor.getByRole('button', { name: 'New chat' }).click();
  await expect(tutor.getByTestId('tutor-conversation-title')).toHaveText('New chat');
  await expect(tutor.getByText('Start a conversation')).toHaveCount(0);

  const textarea = tutor.getByLabel('Ask the tutor');
  await textarea.fill('Explain the first step');
  const sendButton = tutor.locator('form button[type="submit"]');
  await textarea.press('Enter');
  await tutorRequestStarted;
  expect(requestBody).toMatchObject({
    page: 'session',
    conceptId: 'supervised-learning',
  });
  expect(requestBody?.knowledgePointId).toBeTruthy();
  await expect(textarea).toHaveValue('');
  await expect(
    tutor.getByTestId('tutor-user-message').filter({ hasText: 'Explain the first step' }),
  ).toHaveCount(1);
  await expect(tutor.getByRole('status', { name: 'Thinking', exact: true })).toBeVisible();
  await expect(tutor.getByTestId('tutor-thinking-bubble')).toBeVisible();
  await expect(
    tutor.getByTestId('tutor-thinking-bubble').locator('[data-slot="skeleton"]'),
  ).toHaveCount(0);
  await expect(
    tutor.getByTestId('tutor-thinking-bubble').getByRole('status', { name: 'Thinking' }),
  ).toBeVisible();
  await expect(tutor.getByTestId('tutor-thinking-bubble').locator('svg')).toHaveAttribute(
    'aria-hidden',
    'true',
  );
  await expect(sendButton).toHaveAttribute('aria-label', 'Stop');
  await expect(sendButton.locator('svg')).toBeVisible();
  await textarea.fill('Draft while waiting');
  await expect(textarea).toHaveValue('Draft while waiting');
  await expect(sendButton).toHaveAttribute('aria-label', 'Send');
  await expect(sendButton).toBeEnabled();
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
  const secondTextarea = restoredTutor.getByLabel('Ask the tutor');
  await secondTextarea.fill('Why are targets useful?');
  const secondResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && response.url().includes('/api/tutor/threads'),
  );
  await restoredTutor.getByRole('button', { name: 'Send' }).click();
  const secondRequest = await secondResponse;
  const secondRequestBody = secondRequest.request().postDataJSON() as Record<string, unknown>;
  expect(secondRequestBody).toMatchObject({
    page: 'session',
    conceptId: 'supervised-learning',
  });
  expect(secondRequestBody.knowledgePointId).toBeTruthy();
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

  const firstThread = restoredTutor
    .locator('[data-testid^="tutor-thread-"]')
    .filter({ hasText: 'Explain the first step' });
  await expect(firstThread).toHaveCount(1);
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
  await expect(restoredTutor.getByTestId('tutor-user-message')).toHaveCount(0);
  await expect(restoredTutor.getByText('Start a conversation')).toHaveCount(0);
  const switchedTextarea = restoredTutor.getByLabel('Ask the tutor');
  await switchedTextarea.fill('How does this step connect to the concept?');
  const switchedResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && response.url().includes('/api/tutor/threads'),
  );
  await restoredTutor.getByRole('button', { name: 'Send' }).click();
  const switchedRequest = await switchedResponse;
  const switchedRequestBody = switchedRequest.request().postDataJSON() as Record<string, unknown>;
  expect(switchedRequestBody).toMatchObject({
    page: 'session',
    conceptId: 'supervised-learning',
  });
  expect(switchedRequestBody.knowledgePointId).toBeTruthy();

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

  await page.goto('/placement');
  await expect(page.getByRole('heading', { name: /Placement check ·/ })).toBeVisible();
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

test('tutor send failure stays in a retryable bubble and retry sends it once', async ({ page }) => {
  let failFirstSend = true;
  let firstThreadId = '';
  await page.route('**/api/tutor/threads**', async (route) => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as { threadId: string };
      if (failFirstSend) {
        failFirstSend = false;
        firstThreadId = body.threadId;
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'The tutor could not respond. Try again.' }),
        });
        return;
      }
      expect(new URL(route.request().url()).pathname).toBe('/api/tutor/threads');
      expect(body.threadId).toBe(firstThreadId);
      await route.continue();
      return;
    }
    await route.continue();
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/session/${sessionId}`);
  await page.getByRole('button', { name: 'Ask the tutor' }).click();
  const tutor = page.getByRole('complementary', { name: 'Tutor' });
  const textarea = tutor.getByLabel('Ask the tutor');
  const question = 'What does the target represent?';
  await textarea.fill(question);
  await textarea.press('Enter');
  const failedBubble = tutor.getByTestId('tutor-failed-message');
  await expect(failedBubble).toHaveCount(1);
  await expect(failedBubble).toContainText(question);
  await expect(failedBubble).toContainText("Didn't send.");
  await expect(failedBubble.getByRole('button', { name: 'Retry' })).toBeVisible();
  await expect(failedBubble.getByRole('button', { name: 'Edit' })).toBeVisible();
  await expect(textarea).toHaveValue('');
  await expect(tutor.getByRole('alert')).toHaveCount(0);
  await expect(tutor.getByTestId('tutor-thinking-bubble')).toHaveCount(0);
  await page.screenshot({ path: `${tutorSteerScreenshotDir}/failed-retry-edit-1440.png` });

  await textarea.fill('new draft');
  await failedBubble.getByRole('button', { name: 'Retry' }).click();
  await expect(textarea).toHaveValue('new draft');
  await expect(
    tutor.getByTestId('tutor-assistant-message').filter({
      hasText: `Tutor reply to: ${question}`,
    }),
  ).toHaveCount(1);
  await expect(tutor.getByTestId('tutor-user-message').filter({ hasText: question })).toHaveCount(
    1,
  );
  await expect(tutor.getByTestId('tutor-failed-message')).toHaveCount(0);
});

test('a failed tutor message can be edited into the draft', async ({ page }) => {
  await page.route('**/api/tutor/threads**', async (route) => {
    if (route.request().method() === 'POST') {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Tutor unavailable' }),
      });
      return;
    }
    await route.continue();
  });
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto(`/session/${sessionId}`);
  await page.getByRole('button', { name: 'Ask the tutor' }).click();
  const tutor = page.getByRole('complementary', { name: 'Tutor' });
  const textarea = tutor.getByLabel('Ask the tutor');
  const question = 'Can you explain this step?';
  await textarea.fill(question);
  await textarea.press('Enter');

  const failedBubble = tutor.getByTestId('tutor-failed-message');
  await expect(failedBubble).toContainText("Didn't send.");
  await expect(failedBubble).not.toContainText('Tutor unavailable');
  await expect(textarea).toHaveValue('');
  await page.screenshot({ path: `${tutorSteerScreenshotDir}/failed-retry-edit-390.png` });

  await failedBubble.getByRole('button', { name: 'Edit' }).click();
  await expect(textarea).toHaveValue(question);
  await expect(tutor.getByTestId('tutor-failed-message')).toHaveCount(0);
  await expect(tutor.getByRole('alert')).toHaveCount(0);
});

test('a failed tutor bubble shows a non-generic server reason', async ({ page }) => {
  await page.route('**/api/tutor/threads**', async (route) => {
    if (route.request().method() === 'POST') {
      await route.fulfill({
        status: 429,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Daily tutor limit reached' }),
      });
      return;
    }
    await route.continue();
  });
  await page.goto(`/session/${sessionId}`);
  await page.getByRole('button', { name: 'Ask the tutor' }).click();
  const tutor = page.getByRole('complementary', { name: 'Tutor' });
  const textarea = tutor.getByLabel('Ask the tutor');
  await textarea.fill('What should I do next?');
  await textarea.press('Enter');

  const failedBubble = tutor.getByTestId('tutor-failed-message');
  await expect(failedBubble).toContainText("Didn't send. Daily tutor limit reached");
  await expect(failedBubble.getByRole('button', { name: 'Retry' })).toBeVisible();
  await expect(failedBubble.getByRole('button', { name: 'Edit' })).toBeVisible();
});

test('two quick messages stay in order through a partial refetch on desktop and mobile', async ({
  page,
}) => {
  const threadId = '21111111-1111-4111-8111-111111111111';
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const messages: MockedTutorMessage[] = [];
    let partialReturned = false;
    const firstStarted = deferred();
    const releaseFirst = deferred();
    const secondStarted = deferred();
    const partialSnapshot = deferred();
    const releaseSecond = deferred();
    const thread = {
      id: threadId,
      conceptId: 'supervised-learning',
      title: 'Quick messages',
      updatedAt: '2026-01-01T12:00:00.004Z',
    };
    const detail = (items = messages) => ({
      thread: {
        ...thread,
        conceptTitle: 'Supervised learning',
        messageCount: items.length,
        lastMessagePreview: items.at(-1)?.content ?? '',
      },
      messages: [...items],
    });

    await page.addInitScript(() => {
      localStorage.removeItem('academy.tutor.open');
      localStorage.removeItem('academy.tutor.thread');
    });
    await page.route('**/api/tutor/status', (route) =>
      route.fulfill({ json: { tutorEnabled: true } }),
    );
    await page.route('**/api/tutor/threads**', async (route) => {
      const url = new URL(route.request().url());
      if (route.request().method() === 'POST') {
        const body = route.request().postDataJSON() as {
          question: string;
          clientMessageId: string;
          earlier: Array<{ clientMessageId: string; question: string }>;
        };
        const user: MockedTutorMessage = {
          id: `user-${body.question}`,
          clientId: body.clientMessageId,
          role: 'user',
          content: body.question,
          createdAt:
            body.question === 'A' ? '2026-01-01T12:00:00.001Z' : '2026-01-01T12:00:00.003Z',
        };
        if (body.question === 'A') {
          messages.push(user);
          firstStarted.resolve();
          await releaseFirst.promise;
          try {
            await route.fulfill({ json: { superseded: true, thread } });
          } catch {}
          return;
        }
        expect(body.earlier).toContainEqual({
          clientMessageId: messages[0]?.clientId,
          question: 'A',
        });
        messages.push(user);
        secondStarted.resolve();
        await releaseSecond.promise;
        const reply: MockedTutorMessage = {
          id: 'assistant-B',
          clientId: null,
          role: 'assistant',
          content: 'Tutor reply to: B',
          createdAt: '2026-01-01T12:00:00.004Z',
        };
        messages.push(reply);
        await route.fulfill({ json: { thread, messages: [...messages] } });
        return;
      }
      if (url.pathname === '/api/tutor/threads') {
        await route.fulfill({ json: [thread] });
        return;
      }
      if (url.pathname === `/api/tutor/threads/${threadId}`) {
        if (messages.length > 0 && !partialReturned) {
          partialReturned = true;
          await route.fulfill({ json: detail(messages.slice(0, 1)) });
          partialSnapshot.resolve();
          return;
        }
        await route.fulfill({ json: detail() });
        return;
      }
      await route.continue();
    });

    await page.goto(`/session/${sessionId}`);
    await page.getByRole('button', { name: 'Open tutor' }).click();
    const tutor = page.getByRole('complementary', { name: 'Tutor' });
    await tutor.getByTestId(`tutor-thread-${threadId}`).click();
    const textarea = tutor.getByLabel('Ask the tutor');
    const userMessages = tutor.getByTestId('tutor-user-message');
    await startTutorMessageSampler(page);
    await textarea.fill('A');
    await textarea.press('Enter');
    await firstStarted.promise;
    await textarea.fill('B');
    await textarea.press('Enter');
    await secondStarted.promise;
    await expect(userMessages).toHaveCount(2);
    const sampleStart = await page.evaluate(() => window.__tutorMessageSamples.length);
    await page.evaluate(() => {
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('visibilitychange'));
    });
    await partialSnapshot.promise;
    await expect(userMessages).toHaveCount(2);
    await expect(userMessages.nth(0)).toContainText('A');
    await expect(userMessages.nth(1)).toContainText('B');
    await page.waitForTimeout(100);
    const samples = await page.evaluate(
      (start) => window.__tutorMessageSamples.slice(start),
      sampleStart,
    );
    expect(samples.length).toBeGreaterThan(0);
    expect(samples.every((sample) => JSON.stringify(sample) === JSON.stringify(['A', 'B']))).toBe(
      true,
    );
    await page.screenshot({ path: `${chatRaceScreenshotDir}/chat-AB-${width}.png` });
    releaseSecond.resolve();
    await expect(tutor.getByTestId('tutor-assistant-message')).toContainText('Tutor reply to: B');
    await expect(userMessages).toHaveCount(2);
    releaseFirst.resolve();
    await page.evaluate(() => window.__stopTutorMessageSampler?.());
    await page.unroute('**/api/tutor/status');
    await page.unroute('**/api/tutor/threads**');
  }
});

test('a repeated tutor question stays visible once while the second reply is pending', async ({
  page,
}) => {
  let threadId = '';
  let sendCount = 0;
  const messages: MockedTutorMessage[] = [];
  const secondRequestStarted = deferred();
  const releaseSecondRequest = deferred();
  const thread = () => ({
    id: threadId,
    conceptId: 'supervised-learning',
    title: 'Repeated question',
    updatedAt: '2026-01-01T12:00:00.004Z',
  });
  const detail = () => ({
    thread: {
      ...thread(),
      conceptTitle: 'Supervised learning',
      messageCount: messages.length,
      lastMessagePreview: messages.at(-1)?.content ?? '',
    },
    messages: [...messages],
  });

  await page.addInitScript(() => {
    localStorage.removeItem('academy.tutor.open');
    localStorage.removeItem('academy.tutor.thread');
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
      expect(body.question).toBe('please');
      sendCount += 1;
      if (sendCount === 1) {
        expect(url.pathname).toBe('/api/tutor/threads');
        expect(body.threadId).toBeTruthy();
        threadId = body.threadId ?? '';
      } else {
        expect(url.pathname).toBe(`/api/tutor/threads/${threadId}/messages`);
      }
      const userMessage: MockedTutorMessage = {
        id: `user-please-${sendCount}`,
        clientId: body.clientMessageId,
        role: 'user',
        content: body.question,
        createdAt: `2026-01-01T12:00:00.00${sendCount * 2 - 1}Z`,
      };
      messages.push(userMessage);
      if (sendCount === 2) {
        secondRequestStarted.resolve();
        await releaseSecondRequest.promise;
      }
      const assistantMessage: MockedTutorMessage = {
        id: `assistant-please-${sendCount}`,
        clientId: null,
        role: 'assistant',
        content: `Tutor reply ${sendCount}`,
        createdAt: `2026-01-01T12:00:00.00${sendCount * 2}Z`,
      };
      messages.push(assistantMessage);
      await route.fulfill({
        json: { thread: thread(), messages: [userMessage, assistantMessage] },
      });
      return;
    }

    if (url.pathname === '/api/tutor/threads') {
      await route.fulfill({ json: threadId ? [detail().thread] : [] });
      return;
    }
    if (url.pathname === `/api/tutor/threads/${threadId}`) {
      await route.fulfill({ json: detail() });
      return;
    }
    await route.continue();
  });

  await page.goto(`/session/${sessionId}`);
  await page.getByRole('button', { name: 'Ask the tutor' }).click();
  const tutor = page.getByRole('complementary', { name: 'Tutor' });
  const textarea = tutor.getByLabel('Ask the tutor');
  await tutor.getByRole('button', { name: 'New chat', exact: true }).click();

  await textarea.fill('please');
  await textarea.press('Enter');
  await expect(tutor.getByTestId('tutor-assistant-message')).toContainText('Tutor reply 1');

  await textarea.fill('please');
  await textarea.press('Enter');
  await secondRequestStarted.promise;
  const userMessages = tutor.getByTestId('tutor-user-message');
  await expect(userMessages).toHaveCount(2);
  await expect(userMessages.nth(0)).toContainText('please');
  await expect(userMessages.nth(1)).toContainText('please');
  await expect(tutor.getByTestId('tutor-thinking-bubble')).toHaveCount(1);
  await expect(tutor.getByTestId('tutor-assistant-message')).toHaveCount(1);

  releaseSecondRequest.resolve();
  await expect(tutor.getByTestId('tutor-assistant-message')).toHaveCount(2);
  await expect(userMessages).toHaveCount(2);
});

test('a saved reply after a lost POST response does not show a failed bubble', async ({ page }) => {
  const threadId = '11111111-1111-4111-8111-111111111111';
  const question = 'Please explain this again.';
  const reply = 'Here is the explanation.';
  let postAborted = false;
  const messages: MockedTutorMessage[] = [];
  const thread = () => ({
    id: threadId,
    conceptId: 'supervised-learning',
    title: 'Lost response',
    updatedAt: '2026-01-01T12:00:00.002Z',
  });
  const detail = () => ({
    thread: {
      ...thread(),
      conceptTitle: 'Supervised learning',
      messageCount: messages.length,
      lastMessagePreview: messages.at(-1)?.content ?? '',
    },
    messages: [...messages],
  });

  await page.addInitScript((id) => {
    localStorage.setItem('academy.tutor.open', 'true');
    localStorage.setItem('academy.tutor.thread', id);
  }, threadId);
  await page.route('**/api/tutor/status', (route) =>
    route.fulfill({ json: { tutorEnabled: true } }),
  );
  await page.route('**/api/tutor/threads**', async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === 'POST') {
      expect(url.pathname).toBe(`/api/tutor/threads/${threadId}/messages`);
      const body = route.request().postDataJSON() as {
        question: string;
        clientMessageId: string;
      };
      expect(body).toMatchObject({ question });
      messages.push(
        {
          id: 'user-saved-before-disconnect',
          clientId: body.clientMessageId,
          role: 'user',
          content: question,
          createdAt: '2026-01-01T12:00:00.001Z',
        },
        {
          id: 'assistant-saved-before-disconnect',
          clientId: null,
          role: 'assistant',
          content: reply,
          createdAt: '2026-01-01T12:00:00.002Z',
        },
      );
      postAborted = true;
      await route.abort('failed');
      return;
    }
    if (url.pathname === '/api/tutor/threads') {
      await route.fulfill({ json: [detail().thread] });
      return;
    }
    if (url.pathname === `/api/tutor/threads/${threadId}`) {
      await route.fulfill({ json: detail() });
      return;
    }
    await route.continue();
  });

  await page.goto(`/session/${sessionId}`);
  const tutor = page.getByRole('complementary', { name: 'Tutor' });
  await expect(tutor).toBeVisible();
  const textarea = tutor.getByLabel('Ask the tutor');
  await textarea.fill(question);
  await textarea.press('Enter');

  await expect(tutor.getByTestId('tutor-failed-message')).toHaveCount(0);
  await expect(tutor.getByTestId('tutor-user-message').filter({ hasText: question })).toHaveCount(
    1,
  );
  await expect(tutor.getByTestId('tutor-assistant-message').filter({ hasText: reply })).toHaveCount(
    1,
  );
  expect(postAborted).toBe(true);
});

test('Stop before persistence leaves a retryable bubble and reuses its client ID', async ({
  page,
}) => {
  let threadId = '';
  let firstClientId = '';
  let attempts = 0;
  let stored: MockedTutorMessage[] = [];
  const requestStarted = deferred();
  const releaseFirst = deferred();
  const thread = () => ({
    id: threadId,
    conceptId: 'supervised-learning',
    title: 'Stopped before save',
    updatedAt: '2026-01-01T12:00:00.002Z',
  });
  const detail = () => ({
    thread: {
      ...thread(),
      conceptTitle: 'Supervised learning',
      messageCount: stored.length,
      lastMessagePreview: stored.at(-1)?.content ?? '',
    },
    messages: [...stored],
  });

  await page.addInitScript(() => {
    localStorage.removeItem('academy.tutor.open');
    localStorage.removeItem('academy.tutor.thread');
  });
  await page.route('**/api/tutor/status', (route) =>
    route.fulfill({ json: { tutorEnabled: true } }),
  );
  await page.route('**/api/tutor/threads**', async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as {
        question: string;
        clientMessageId: string;
        threadId: string;
      };
      threadId = body.threadId;
      attempts += 1;
      if (attempts === 1) {
        firstClientId = body.clientMessageId;
        requestStarted.resolve();
        await releaseFirst.promise;
        try {
          await route.fulfill({ json: { superseded: true, thread: thread() } });
        } catch {}
        return;
      }
      expect(body.clientMessageId).toBe(firstClientId);
      const user: MockedTutorMessage = {
        id: 'saved-after-retry',
        clientId: body.clientMessageId,
        role: 'user',
        content: body.question,
        createdAt: '2026-01-01T12:00:00.001Z',
      };
      const assistant: MockedTutorMessage = {
        id: 'reply-after-retry',
        clientId: null,
        role: 'assistant',
        content: 'Tutor reply after retry',
        createdAt: '2026-01-01T12:00:00.002Z',
      };
      stored = [user, assistant];
      await route.fulfill({ json: { thread: thread(), messages: stored } });
      return;
    }
    if (url.pathname === '/api/tutor/threads') {
      await route.fulfill({ json: threadId ? [detail().thread] : [] });
      return;
    }
    if (url.pathname === `/api/tutor/threads/${threadId}`) {
      await route.fulfill({ json: detail() });
      return;
    }
    await route.continue();
  });

  await page.goto(`/session/${sessionId}`);
  await page.getByRole('button', { name: 'Ask the tutor' }).click();
  const tutor = page.getByRole('complementary', { name: 'Tutor' });
  const textarea = tutor.getByLabel('Ask the tutor');
  await textarea.fill('Save this after retry.');
  await textarea.press('Enter');
  await requestStarted.promise;
  await tutor.getByRole('button', { name: 'Stop' }).click();
  const failed = tutor.getByTestId('tutor-failed-message');
  await expect(failed).toContainText("Didn't send");
  await expect(tutor.getByTestId('tutor-user-message')).toHaveCount(0);
  releaseFirst.resolve();
  await failed.getByRole('button', { name: 'Retry' }).click();
  await expect(tutor.getByTestId('tutor-assistant-message')).toContainText(
    'Tutor reply after retry',
  );
  await expect(tutor.getByTestId('tutor-user-message')).toHaveCount(1);
  expect(attempts).toBe(2);
});

test('switching threads preserves a pending tutor message in its original thread', async ({
  page,
}) => {
  const firstId = '31111111-1111-4111-8111-111111111111';
  const secondId = '32222222-2222-4222-8222-222222222222';
  const firstMessages: MockedTutorMessage[] = [];
  const secondMessages: MockedTutorMessage[] = [
    {
      id: 'existing-user-b',
      clientId: null,
      role: 'user',
      content: 'Question in the other chat.',
      createdAt: '2026-01-01T12:00:00.001Z',
    },
    {
      id: 'existing-reply-b',
      clientId: null,
      role: 'assistant',
      content: 'Reply in the other chat.',
      createdAt: '2026-01-01T12:00:00.002Z',
    },
  ];
  const firstStarted = deferred();
  const releaseFirst = deferred();
  const thread = (id: string) => ({
    id,
    conceptId: 'supervised-learning',
    title: id === firstId ? 'First chat' : 'Second chat',
    updatedAt: '2026-01-01T12:00:00.002Z',
  });
  const detail = (id: string) => {
    const messages = id === firstId ? firstMessages : secondMessages;
    return {
      thread: {
        ...thread(id),
        conceptTitle: 'Supervised learning',
        messageCount: messages.length,
        lastMessagePreview: messages.at(-1)?.content ?? '',
      },
      messages: [...messages],
    };
  };

  await page.addInitScript((id) => {
    localStorage.setItem('academy.tutor.thread', id);
    localStorage.removeItem('academy.tutor.open');
  }, firstId);
  await page.route('**/api/tutor/status', (route) =>
    route.fulfill({ json: { tutorEnabled: true } }),
  );
  await page.route('**/api/tutor/threads**', async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as {
        question: string;
        clientMessageId: string;
      };
      const user: MockedTutorMessage = {
        id: 'pending-in-first-chat',
        clientId: body.clientMessageId,
        role: 'user',
        content: body.question,
        createdAt: '2026-01-01T12:00:00.003Z',
      };
      firstMessages.push(user);
      firstStarted.resolve();
      await releaseFirst.promise;
      const assistant: MockedTutorMessage = {
        id: 'reply-in-first-chat',
        clientId: null,
        role: 'assistant',
        content: 'Reply in the first chat.',
        createdAt: '2026-01-01T12:00:00.004Z',
      };
      firstMessages.push(assistant);
      await route.fulfill({
        json: { thread: thread(firstId), messages: [...firstMessages] },
      });
      return;
    }
    if (url.pathname === '/api/tutor/threads') {
      await route.fulfill({
        json: [detail(firstId).thread, detail(secondId).thread],
      });
      return;
    }
    const id = url.pathname.split('/').at(-1) ?? '';
    if (id === firstId || id === secondId) {
      await route.fulfill({ json: detail(id) });
      return;
    }
    await route.continue();
  });

  await page.goto(`/session/${sessionId}`);
  await page.getByRole('button', { name: 'Open tutor' }).click();
  const tutor = page.getByRole('complementary', { name: 'Tutor' });
  const textarea = tutor.getByLabel('Ask the tutor');
  await textarea.fill('Stay in the first chat.');
  await textarea.press('Enter');
  await firstStarted.promise;
  await expect(tutor.getByTestId('tutor-thinking-bubble')).toBeVisible();
  await tutor.getByRole('button', { name: 'New chat', exact: true }).click();
  await expect(tutor.getByTestId('tutor-user-message')).toHaveCount(0);
  await tutor.getByRole('button', { name: 'Chats', exact: true }).click();
  await tutor.getByTestId(`tutor-thread-${secondId}`).click();
  await expect(tutor.getByTestId('tutor-assistant-message')).toContainText(
    'Reply in the other chat.',
  );
  await tutor.getByRole('button', { name: 'Chats', exact: true }).click();
  await tutor.getByTestId(`tutor-thread-${firstId}`).click();
  await expect(tutor.getByTestId('tutor-user-message')).toContainText('Stay in the first chat.');
  await expect(tutor.getByTestId('tutor-thinking-bubble')).toBeVisible();
  releaseFirst.resolve();
  await expect(tutor.getByTestId('tutor-assistant-message')).toContainText(
    'Reply in the first chat.',
  );
  await tutor.getByRole('button', { name: 'Chats', exact: true }).click();
  await tutor.getByTestId(`tutor-thread-${secondId}`).click();
  await expect(tutor.getByTestId('tutor-assistant-message')).toContainText(
    'Reply in the other chat.',
  );
  await expect(tutor.getByTestId('tutor-assistant-message')).not.toContainText(
    'Reply in the first chat.',
  );
});

test('a failed steered message is rolled back before retrying once', async ({ page }) => {
  const firstQuestion = 'Sorry, can you explain this to me step by step? What is this page about?';
  const steeredQuestion = 'please';
  const threadId = '43333333-3333-4333-8333-333333333333';
  let detailReads = 0;
  let bRequestReceived = false;
  let bFailureCompleted = false;
  const firstRequestStarted = deferred();
  const bRequestStarted = deferred();
  const firstDetailRead = deferred();
  const releaseFirstRequest = deferred();
  const firstResponseFinished = deferred();
  const messages: MockedTutorMessage[] = [];
  const thread = () => ({
    id: threadId,
    conceptId: 'supervised-learning',
    title: 'Eigenvalue decomposition',
    updatedAt: '2026-01-01T12:00:00.005Z',
  });
  const detail = () => ({
    thread: {
      ...thread(),
      conceptTitle: 'Supervised learning',
      messageCount: messages.length,
      lastMessagePreview: messages.at(-1)?.content ?? '',
    },
    messages: [...messages],
  });

  await page.route('**/api/tutor/status', (route) =>
    route.fulfill({ json: { tutorEnabled: true } }),
  );
  await page.route('**/api/tutor/threads**', async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as {
        question: string;
        clientMessageId: string;
        earlier: Array<{ clientMessageId: string; question: string }>;
      };
      expect(url.pathname).toBe(`/api/tutor/threads/${threadId}/messages`);

      if (body.question === firstQuestion) {
        expect(body.earlier).toEqual([]);
        messages.push({
          id: 'user-a',
          clientId: body.clientMessageId,
          role: 'user',
          content: body.question,
          createdAt: '2026-01-01T12:00:00.001Z',
        });
        firstRequestStarted.resolve();
        await releaseFirstRequest.promise;
        try {
          await route.fulfill({ json: { superseded: true, thread: thread() } });
        } catch {
          firstResponseFinished.resolve();
          return;
        }
        firstResponseFinished.resolve();
        return;
      }

      expect(body.question).toBe(steeredQuestion);
      if (!bRequestReceived) {
        const firstMessage = messages.find((message) => message.content === firstQuestion);
        expect(body.earlier).toContainEqual({
          clientMessageId: firstMessage?.clientId,
          question: firstQuestion,
        });
        bRequestReceived = true;
        messages.push({
          id: 'user-b-failed',
          clientId: body.clientMessageId,
          role: 'user',
          content: body.question,
          createdAt: '2026-01-01T12:00:00.002Z',
        });
        bRequestStarted.resolve();
        await firstDetailRead.promise;
        const failedMessageIndex = messages.findIndex((message) => message.id === 'user-b-failed');
        if (failedMessageIndex >= 0) messages.splice(failedMessageIndex, 1);
        bFailureCompleted = true;
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Tutor unavailable' }),
        });
        return;
      }

      const userMessage: MockedTutorMessage = {
        id: 'user-b-retried',
        clientId: body.clientMessageId,
        role: 'user',
        content: body.question,
        createdAt: '2026-01-01T12:00:00.003Z',
      };
      const assistantMessage: MockedTutorMessage = {
        id: 'assistant-b-retried',
        clientId: null,
        role: 'assistant',
        content: `Tutor reply to: ${body.question}`,
        createdAt: '2026-01-01T12:00:00.004Z',
      };
      messages.push(userMessage, assistantMessage);
      await route.fulfill({
        json: { thread: thread(), messages: [userMessage, assistantMessage] },
      });
      return;
    }

    if (url.pathname === '/api/tutor/threads') {
      const snapshot = detail();
      if (bFailureCompleted) {
        expect(snapshot.messages.some((message) => message.id === 'user-b-failed')).toBe(false);
      }
      try {
        await route.fulfill({ json: [snapshot.thread] });
      } catch {
        return;
      }
      return;
    }

    if (url.pathname === `/api/tutor/threads/${threadId}`) {
      if (detailReads === 0 && !bRequestReceived) await bRequestStarted.promise;
      const snapshot = detail();
      if (detailReads === 0) {
        expect(snapshot.messages.some((message) => message.id === 'user-b-failed')).toBe(true);
      } else if (bFailureCompleted) {
        expect(snapshot.messages.some((message) => message.id === 'user-b-failed')).toBe(false);
      }
      detailReads += 1;
      try {
        await route.fulfill({ json: snapshot });
      } catch {
        if (detailReads === 1) firstDetailRead.resolve();
        return;
      }
      if (detailReads === 1) firstDetailRead.resolve();
      return;
    }

    await route.continue();
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript((id) => {
    localStorage.removeItem('academy.tutor.open');
    localStorage.setItem('academy.tutor.thread', id);
  }, threadId);
  await page.goto(`/session/${sessionId}`);
  await page.getByRole('button', { name: 'Open tutor' }).click();
  const tutor = page.getByRole('complementary', { name: 'Tutor' });
  const textarea = tutor.getByLabel('Ask the tutor');
  await textarea.fill(firstQuestion);
  await textarea.press('Enter');
  await firstRequestStarted.promise;
  await expect(tutor.getByTestId('tutor-thinking-bubble')).toBeVisible();

  await textarea.fill(steeredQuestion);
  await textarea.press('Enter');
  await bRequestStarted.promise;

  const failedBubble = tutor.getByTestId('tutor-failed-message');
  await expect(failedBubble).toHaveCount(1);
  await expect(failedBubble).toContainText(steeredQuestion);
  await expect(failedBubble).toContainText("Didn't send.");
  await expect(
    tutor.getByTestId('tutor-user-message').filter({ hasText: steeredQuestion }),
  ).toHaveCount(0);
  await expect(
    tutor.getByTestId('tutor-user-message').filter({ hasText: firstQuestion }),
  ).toHaveCount(1);
  await expect(tutor.getByRole('alert')).toHaveCount(0);
  await expect(textarea).toHaveValue('');
  await page.screenshot({ path: `${tutorSteerScreenshotDir}/failed-retry-edit-1440.png` });

  releaseFirstRequest.resolve();
  await firstResponseFinished.promise;
  await failedBubble.getByRole('button', { name: 'Retry' }).click();
  await expect(
    tutor.getByTestId('tutor-assistant-message').filter({
      hasText: `Tutor reply to: ${steeredQuestion}`,
    }),
  ).toHaveCount(1);
  await expect(
    tutor.getByTestId('tutor-user-message').filter({ hasText: steeredQuestion }),
  ).toHaveCount(1);
  await expect(
    tutor.getByTestId('tutor-user-message').filter({ hasText: firstQuestion }),
  ).toHaveCount(1);
  await expect(tutor.getByTestId('tutor-failed-message')).toHaveCount(0);
});

test('Stop and steering keep tutor messages server-backed at desktop and mobile widths', async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.removeItem('academy.tutor.open');
    localStorage.removeItem('academy.tutor.thread');
  });

  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });

    let threadId = '';
    let firstThreadId = '';
    let messageCount = 0;
    let releaseFirstRequest = () => {};
    let firstRequestReceived = () => {};
    const firstRequestBlocked = new Promise<void>((resolve) => {
      releaseFirstRequest = resolve;
    });
    const firstRequestStarted = new Promise<void>((resolve) => {
      firstRequestReceived = resolve;
    });
    const messages: MockedTutorMessage[] = [];
    const thread = () => ({
      id: threadId,
      conceptId: 'supervised-learning',
      title: 'First question',
      updatedAt: '2026-01-01T12:00:00.003Z',
    });
    const detail = () => ({
      thread: {
        ...thread(),
        conceptTitle: 'Supervised learning',
        messageCount: messages.length,
        lastMessagePreview: messages[0]?.content ?? '',
      },
      messages: [...messages],
    });

    await page.route('**/api/tutor/status', (route) =>
      route.fulfill({ json: { tutorEnabled: true } }),
    );
    await page.route('**/api/tutor/threads**', async (route) => {
      const url = route.request().url();
      if (route.request().method() === 'POST') {
        const body = route.request().postDataJSON() as {
          question: string;
          threadId: string;
          clientMessageId: string;
        };
        expect(url.endsWith('/api/tutor/threads')).toBe(true);
        if (messageCount === 0) firstThreadId = body.threadId;
        else expect(body.threadId).toBe(firstThreadId);
        threadId = body.threadId;
        messageCount += 1;
        const userMessage: MockedTutorMessage = {
          id: `user-${messageCount}`,
          clientId: body.clientMessageId,
          role: 'user',
          content: body.question,
          createdAt: `2026-01-01T12:00:00.00${messageCount}Z`,
        };
        messages.push(userMessage);
        if (messageCount === 1) {
          firstRequestReceived();
          await firstRequestBlocked;
          try {
            await route.fulfill({ json: { thread: thread(), messages: [userMessage] } });
          } catch {
            return;
          }
          return;
        }
        const assistantMessage: MockedTutorMessage = {
          id: `assistant-${messageCount}`,
          clientId: null,
          role: 'assistant',
          content: `Tutor reply to: ${body.question}`,
          createdAt: '2026-01-01T12:00:00.004Z',
        };
        messages.push(assistantMessage);
        await route.fulfill({
          json: { thread: thread(), messages: [userMessage, assistantMessage] },
        });
        return;
      }
      if (url.endsWith('/api/tutor/threads')) {
        await route.fulfill({ json: threadId ? [detail().thread] : [] });
        return;
      }
      if (url.endsWith(`/api/tutor/threads/${threadId}`)) {
        await route.fulfill({ json: detail() });
        return;
      }
      await route.continue();
    });

    await page.goto(`/session/${sessionId}`);
    await page.getByRole('button', { name: 'Ask the tutor' }).click();
    const tutor = page.getByRole('complementary', { name: 'Tutor' });
    await tutor.getByRole('button', { name: 'New chat', exact: true }).click();
    const textarea = tutor.getByLabel('Ask the tutor');
    await textarea.fill('Show me the first step.');
    await textarea.press('Enter');
    await firstRequestStarted;
    await expect(textarea).toBeEnabled();
    const stopButton = tutor.getByRole('button', { name: 'Stop' });
    await expect(stopButton).toBeVisible();
    await expect(stopButton).toHaveClass(/rounded-full/);
    await expect(stopButton).toHaveClass(/bg-primary/);
    await expect(stopButton.locator('svg')).toHaveClass(/fill-current/);
    await page.screenshot({
      path: `${tutorSteerScreenshotDir}/pending-stop-${width}.png`,
    });

    await textarea.fill('Please show the next line.');
    await expect(tutor.getByRole('button', { name: 'Send' })).toBeEnabled();

    if (width === 1440) {
      await textarea.fill('');
      await tutor.getByRole('button', { name: 'Stop' }).click();
      await expect(tutor.getByTestId('tutor-user-message')).toHaveCount(1);
      await expect(tutor.getByTestId('tutor-thinking-bubble')).toHaveCount(0);
      await expect(tutor.getByRole('alert')).toHaveCount(0);
      releaseFirstRequest();
      await textarea.fill('Try again in the same chat.');
      await textarea.press('Enter');
      await expect(
        tutor.getByTestId('tutor-user-message').filter({
          hasText: 'Show me the first step.',
        }),
      ).toHaveCount(1);
      await expect(
        tutor.getByTestId('tutor-user-message').filter({
          hasText: 'Try again in the same chat.',
        }),
      ).toHaveCount(1);
      await expect(
        tutor.getByTestId('tutor-assistant-message').filter({
          hasText: 'Tutor reply to: Try again in the same chat.',
        }),
      ).toHaveCount(1);
    } else {
      await textarea.press('Enter');
      await expect(
        tutor.getByTestId('tutor-user-message').filter({ hasText: 'Show me the first step.' }),
      ).toHaveCount(1);
      await expect(
        tutor.getByTestId('tutor-user-message').filter({ hasText: 'Please show the next line.' }),
      ).toHaveCount(1);
      await expect(
        tutor.getByTestId('tutor-assistant-message').filter({
          hasText: 'Tutor reply to: Please show the next line.',
        }),
      ).toHaveCount(1);
    }
    releaseFirstRequest();
    await page.unroute('**/api/tutor/status');
    await page.unroute('**/api/tutor/threads**');
  }
});

test('three quick tutor messages stay once each while the latest reply is pending', async ({
  page,
}) => {
  const threadId = '41111111-1111-4111-8111-111111111111';
  await page.addInitScript(() => {
    localStorage.removeItem('academy.tutor.open');
    localStorage.removeItem('academy.tutor.thread');
  });

  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });

    const messages: MockedTutorMessage[] = [];
    const thirdMessageStored = deferred();
    const firstRequestStarted = deferred();
    const secondRequestStarted = deferred();
    const thirdRequestStarted = deferred();
    const releaseFirstRequest = deferred();
    const releaseSecondRequest = deferred();
    const releaseThirdRequest = deferred();
    const firstResponseFinished = deferred();
    const secondResponseFinished = deferred();
    const serverSnapshotLoaded = deferred();
    const thread = () => ({
      id: threadId,
      conceptId: 'supervised-learning',
      title: 'Steering sequence',
      updatedAt: '2026-01-01T12:00:00.006Z',
    });
    const detail = () => ({
      thread: {
        ...thread(),
        conceptTitle: 'Supervised learning',
        messageCount: messages.length,
        lastMessagePreview: messages.at(-1)?.content ?? '',
      },
      messages: [...messages],
    });
    const addMessage = (message: MockedTutorMessage) => {
      messages.push(message);
      if (messages.length >= 3) thirdMessageStored.resolve();
    };

    await page.route('**/api/tutor/status', (route) =>
      route.fulfill({ json: { tutorEnabled: true } }),
    );
    await page.route('**/api/tutor/threads**', async (route) => {
      const url = new URL(route.request().url());
      if (route.request().method() === 'POST') {
        const body = route.request().postDataJSON() as {
          question: string;
          clientMessageId: string;
        };
        expect(url.pathname).toBe(`/api/tutor/threads/${threadId}/messages`);
        const index = body.question.charCodeAt(0) - 'A'.charCodeAt(0);
        expect(index).toBeGreaterThanOrEqual(0);
        expect(index).toBeLessThan(3);
        const userMessage: MockedTutorMessage = {
          id: `user-${body.question}`,
          clientId: body.clientMessageId,
          role: 'user',
          content: body.question,
          createdAt: `2026-01-01T12:00:00.00${index + 1}Z`,
        };
        addMessage(userMessage);

        if (index === 0) {
          firstRequestStarted.resolve();
          await releaseFirstRequest.promise;
          try {
            await route.fulfill({ json: { superseded: true, thread: thread() } });
          } catch {
            firstResponseFinished.resolve();
            return;
          }
          firstResponseFinished.resolve();
          return;
        }
        if (index === 1) {
          secondRequestStarted.resolve();
          await releaseSecondRequest.promise;
          try {
            await route.fulfill({ json: { superseded: true, thread: thread() } });
          } catch {
            secondResponseFinished.resolve();
            return;
          }
          secondResponseFinished.resolve();
          return;
        }

        thirdRequestStarted.resolve();
        await releaseThirdRequest.promise;
        const assistantMessage: MockedTutorMessage = {
          id: 'assistant-C',
          clientId: null,
          role: 'assistant',
          content: 'Tutor reply to: C',
          createdAt: '2026-01-01T12:00:00.005Z',
        };
        addMessage(assistantMessage);
        await route.fulfill({
          json: { thread: thread(), messages: [...messages] },
        });
        return;
      }

      if (url.pathname === '/api/tutor/threads') {
        try {
          await route.fulfill({ json: [detail().thread] });
        } catch {
          return;
        }
        return;
      }

      if (url.pathname === `/api/tutor/threads/${threadId}`) {
        if (messages.length > 0 && messages.length < 3) await thirdMessageStored.promise;
        const firstMessage = messages.find((message) => message.content === 'A');
        const snapshot = firstMessage ? { ...detail(), messages: [firstMessage] } : detail();
        try {
          await route.fulfill({ json: snapshot });
        } catch {
          return;
        }
        serverSnapshotLoaded.resolve();
        return;
      }

      await route.continue();
    });

    await page.goto(`/session/${sessionId}`);
    await page.getByRole('button', { name: 'Open tutor' }).click();
    const tutor = page.getByRole('complementary', { name: 'Tutor' });
    await tutor.getByTestId(`tutor-thread-${threadId}`).click();
    const textarea = tutor.getByLabel('Ask the tutor');

    await textarea.fill('A');
    await textarea.press('Enter');
    await firstRequestStarted.promise;
    await expect(tutor.getByRole('button', { name: 'Stop' })).toBeVisible();

    await textarea.fill('B');
    await textarea.press('Enter');
    await secondRequestStarted.promise;

    await textarea.fill('C');
    await textarea.press('Enter');
    await thirdRequestStarted.promise;
    await page.evaluate(() => {
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('visibilitychange'));
    });
    await serverSnapshotLoaded.promise;

    const userMessages = tutor.getByTestId('tutor-user-message');
    await expect(userMessages).toHaveCount(3);
    await expect(userMessages.nth(0)).toContainText('A');
    await expect(userMessages.nth(1)).toContainText('B');
    await expect(userMessages.nth(2)).toContainText('C');
    await expect(tutor.getByTestId('tutor-thinking-bubble')).toHaveCount(1);
    await expect(tutor.getByTestId('tutor-assistant-message')).toHaveCount(0);
    await page.screenshot({
      path: `${tutorSteerScreenshotDir}/steering-three-pending-${width}.png`,
    });

    releaseFirstRequest.resolve();
    releaseSecondRequest.resolve();
    await Promise.all([firstResponseFinished.promise, secondResponseFinished.promise]);
    releaseThirdRequest.resolve();
    await expect(
      tutor.getByTestId('tutor-assistant-message').filter({ hasText: 'Tutor reply to: C' }),
    ).toHaveCount(1);
    await expect(tutor.getByTestId('tutor-thinking-bubble')).toHaveCount(0);
    await expect(tutor.getByTestId('tutor-user-message')).toHaveCount(3);

    await page.unroute('**/api/tutor/status');
    await page.unroute('**/api/tutor/threads**');
  }
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
  let actualThreadId = threadId;
  const reply = String.raw`\[ \frac{\partial f}{\partial w}=2(wx+b-y)x \]

\( x \)`;
  const messages = [
    {
      id: 'math-user-message',
      clientId: '',
      role: 'user',
      content: 'Show me the derivative.',
      createdAt: '2026-01-01T12:00:00.001Z',
    },
    {
      id: 'math-assistant-message',
      clientId: null,
      role: 'assistant',
      content: reply,
      createdAt: updatedAt,
    },
  ];
  const thread = () => ({
    id: actualThreadId,
    conceptId: 'supervised-learning',
    title: 'Derivative question',
    updatedAt,
  });
  await page.route('**/api/tutor/threads**', async (route) => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as {
        clientMessageId: string;
        threadId?: string;
      };
      actualThreadId = body.threadId ?? actualThreadId;
      const userMessage = messages[0];
      if (userMessage) messages[0] = { ...userMessage, clientId: body.clientMessageId };
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ thread: thread(), messages }),
      });
      return;
    }
    if (route.request().url().endsWith(`/api/tutor/threads/${actualThreadId}`)) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          thread: {
            ...thread(),
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

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 375, height: 812 },
]) {
  test(`opening a long tutor conversation jumps directly to the latest message at ${viewport.width}px`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    const { tutor, conversation } = await openMockedLongTutorThread(
      page,
      '00000000-0000-4000-8000-000000000016',
    );
    await tutor.getByRole('button', { name: 'Chats', exact: true }).click();
    await tutor.getByRole('button', { name: 'Close tutor' }).click();
    await page.evaluate(() => {
      window.__tutorScrollSamples = [];
      const sample = () => {
        const element = document.querySelector('.tutor-message-scroll-area');
        if (element && element.clientHeight > 0 && element.scrollHeight > element.clientHeight) {
          const remaining = element.scrollHeight - element.clientHeight - element.scrollTop;
          if (element.scrollTop > 2 && remaining > 2) {
            window.__tutorScrollSamples.push(element.scrollTop);
          }
        }
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    await page.getByRole('button', { name: 'Open tutor' }).click();
    await tutor.getByTestId('tutor-thread-00000000-0000-4000-8000-000000000016').click();
    await expect(tutor.getByTestId('tutor-assistant-message').last()).toContainText('Reply 20:');
    await expect
      .poll(() =>
        conversation.evaluate(
          (element) => element.scrollTop + element.clientHeight >= element.scrollHeight - 2,
        ),
      )
      .toBe(true);
    expect(await page.evaluate(() => window.__tutorScrollSamples)).toEqual([]);
    await page.screenshot({
      path: `${tutorSidebarScreenshotDir}/opens-at-latest-${viewport.width}.png`,
    });
  });
}

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

test('tutor fraction numerators and denominators are not clipped by the scrollport', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { assistantMessage } = await openMockedTutorReply(
    page,
    '00000000-0000-4000-8000-000000000014',
    'Show the mean of 2, 4, and 6.',
    String.raw`The mean is easy to compute as $$\mu=\frac{2+4+6}{3}=4.$$`,
  );

  for (const mobile of [false, true]) {
    if (mobile) {
      await page.setViewportSize({ width: 390, height: 844 });
      await waitForTutorSidebarToSettle(page, '[data-slot="sidebar"][data-mobile="true"]');
    }
    const message = mobile
      ? page.locator(
          '[data-slot="sidebar"][data-mobile="true"] [data-testid="tutor-assistant-message"]',
        )
      : assistantMessage;
    const display = message.locator('.tutor-display-math');
    await expect(display).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    const geometry = await display.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const glyphs = [...element.querySelectorAll('.katex-html .mord')]
        .filter((glyph) => glyph.children.length === 0)
        .map((glyph) => {
          const range = document.createRange();
          range.selectNodeContents(glyph);
          const rect = range.getBoundingClientRect();
          return { top: rect.top, bottom: rect.bottom };
        });
      return { top: box.top, bottom: box.bottom, glyphs };
    });
    expect(geometry.glyphs.length).toBeGreaterThan(0);
    for (const glyph of geometry.glyphs) {
      expect(glyph.top).toBeGreaterThanOrEqual(geometry.top);
      expect(glyph.bottom).toBeLessThanOrEqual(geometry.bottom);
    }
    await message.screenshot({
      path: `${tutorMathScreenshotDir}/fraction-${mobile ? 'mobile' : 'desktop'}.png`,
      animations: 'disabled',
    });
  }
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
    conceptId: 'supervised-learning',
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
  await expect(page.getByRole('button', { name: 'Restart topic' })).toBeVisible();
  const lessonTextarea = tutor.getByLabel('Ask the tutor');
  await lessonTextarea.fill('What does the full lesson explain?');
  const lessonResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && response.url().includes('/api/tutor/threads'),
  );
  await lessonTextarea.press('Enter');
  const lessonRequest = await lessonResponse;
  expect(lessonRequest.request().postDataJSON()).toMatchObject({
    page: 'lesson',
    conceptId: 'supervised-learning',
  });
  expect(lessonRequest.request().postDataJSON()).not.toHaveProperty('pageLabel');
  await expect(tutor.getByTestId('tutor-assistant-message').last()).toContainText(
    'Tutor reply to: What does the full lesson explain?',
  );
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

  await page.getByRole('link', { name: 'Home', exact: true }).click();
  await expect(page).toHaveURL('/');
});

test('long tutor drafts keep the composer controls in view on desktop and mobile', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.addInitScript(() => {
    localStorage.setItem('academy.tutor.open', 'true');
  });
  await page.goto('/courses/fixture-course');

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

test('Unicode-accented predictions render without red errors and preserve code examples', async ({
  page,
}, testInfo) => {
  const reply =
    'Model output: $ŷ$ or $ŷ_i$. Other notation: $y\u0305$ or $y\u0305_i$. Real target: $y$ or $y_i$.\n\n$$y = \\hat{y} + \\text{noise}$$\n\nLiteral code: `y\u0305_i`.';
  const { assistantMessage } = await openMockedTutorReply(
    page,
    '00000000-0000-4000-8000-000000000088',
    'Explain the predicted and real target values.',
    reply,
  );
  await expect(assistantMessage.locator('.katex')).toHaveCount(7);
  await expect(assistantMessage.locator('.katex-error')).toHaveCount(0);
  await expect(assistantMessage.locator('.katex .accent-body')).toHaveCount(5);
  await expect(assistantMessage.locator('code').filter({ hasText: 'y\u0305_i' })).toHaveText(
    'y\u0305_i',
  );
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    const message =
      width === 390
        ? page.locator('[data-mobile="true"] [data-testid="tutor-assistant-message"]').last()
        : assistantMessage;
    await expect(message.locator('.katex')).toHaveCount(7);
    await expect(message.locator('.katex-error')).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath(`prediction-notation-${width}.png`) });
  }
});
