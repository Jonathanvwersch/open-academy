import { expect, test } from '@playwright/test';
import { eq } from 'drizzle-orm';
import { createDb } from '../../src/server/db/client.js';
import { users } from '../../src/server/db/schema.js';
import { env } from '../../src/server/env.js';

declare global {
  interface Window {
    __paperLayoutShifts: number[];
    __routeSkeletonSeen: boolean;
  }
}

const db = createDb(env.TEST_DATABASE_URL);
let userId = '';

test.beforeEach(async ({ page }) => {
  await page.route('**/api/**', (route) =>
    route.continue({
      headers: { ...route.request().headers(), 'x-now': '2026-01-01T12:00:00.000Z' },
    }),
  );
  await db.delete(users);
  const [user] = await db
    .insert(users)
    .values({
      displayName: 'Paper reader E2E learner',
      timezone: 'UTC',
      startDate: '2026-01-01',
      prefs: { saturdayMinutes: 300 },
    })
    .returning();
  if (!user) throw new Error('Could not create paper reader learner');
  userId = user.id;
});

test.afterAll(async () => {
  await db.delete(users).where(eq(users.id, userId));
  await db.$client.end();
});

test('Course opens a paper reader with PDF pages, persisted notes/summary, tutor selection, and low CLS', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    window.__paperLayoutShifts = [];
    new PerformanceObserver((entries) => {
      for (const entry of entries.getEntries()) {
        const shift = entry as PerformanceEntry & { hadRecentInput: boolean; value: number };
        if (!shift.hadRecentInput) window.__paperLayoutShifts.push(shift.value);
      }
    }).observe({ type: 'layout-shift', buffered: true });
  });
  await page.goto('/course');
  const paperLink = page.getByRole('link', { name: /Fixture Paper One/ }).first();
  await expect(paperLink).toBeVisible();
  await expect(paperLink.locator('[data-slot="badge"]')).toHaveCount(0);
  await paperLink.click();
  await expect(page).toHaveURL(/\/papers\/fixture-paper-one/);
  await expect(page.locator('.react-pdf__Page__canvas').first()).toBeVisible();
  await expect(page.locator('.react-pdf__Page__textContent').first()).toContainText(
    'Fixture page one',
  );
  await expect(page.getByText('Claim', { exact: true })).toBeVisible();
  await expect(page.getByText('Saving…', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Saved', { exact: true })).toHaveCount(0);
  const reader = page.locator('[aria-label="PDF reader"]');
  await expect.poll(() => reader.evaluate((element) => element.clientWidth)).toBeGreaterThan(900);
  expect(await reader.evaluate((element) => element.scrollWidth)).toBeLessThanOrEqual(
    (await reader.evaluate((element) => element.clientWidth)) + 1,
  );
  await page.getByRole('button', { name: 'Zoom in' }).click();
  await expect(page.getByText('110%', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Zoom out' }).click();
  await expect(page.getByText('100%', { exact: true })).toBeVisible();

  const pageTwoSave = page.waitForResponse((response) => {
    const request = response.request();
    const body = request.postDataJSON();
    return (
      response.url().endsWith('/api/papers/fixture-paper-one/progress') &&
      request.method() === 'PUT' &&
      body.lastPage === 2
    );
  });
  await page.locator('[data-page="2"]').scrollIntoViewIfNeeded();
  await expect(page.getByLabel('Go to page')).toHaveValue('2');
  await expect(page.getByLabel('Go to page').locator('..')).toContainText('of 3');
  await pageTwoSave;
  await page.locator('[data-page="2"]').evaluate((page) => {
    const container = page.closest('[aria-label="PDF reader"]');
    if (!(container instanceof HTMLElement)) return;
    const pageRect = page.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    const contentTop = pageRect.top - containerRect.top + container.scrollTop;
    container.scrollTo({
      top: contentTop + pageRect.height / 2 - container.clientHeight / 2,
      behavior: 'instant',
    });
  });
  await expect
    .poll(() =>
      reader.evaluate((element) => {
        const page = element.querySelector<HTMLElement>('[data-page="2"]');
        if (!page) return Number.POSITIVE_INFINITY;
        const pageRect = page.getBoundingClientRect();
        const viewerRect = element.getBoundingClientRect();
        return Math.abs(
          pageRect.top + pageRect.height / 2 - (viewerRect.top + element.clientHeight / 2),
        );
      }),
    )
    .toBeLessThan(10);
  const middleScrollTop = await reader.evaluate((element) => element.scrollTop);
  await page.waitForTimeout(500);
  expect(await reader.evaluate((element) => element.scrollTop)).toBe(middleScrollTop);
  await page.reload();
  await expect(page.getByLabel('Go to page')).toHaveValue('2');

  const savedNote = `The authors claim a useful result ${Date.now()}.`;
  await page.getByLabel('claim note').fill(savedNote);
  const noteStatus = page.getByText('Saving…', { exact: true });
  await noteStatus.scrollIntoViewIfNeeded();
  await expect(noteStatus).toBeVisible({ timeout: 500 });
  const savedStatus = page.getByText('Saved', { exact: true }).first();
  await savedStatus.scrollIntoViewIfNeeded();
  await expect(savedStatus).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('claim note')).toHaveValue(savedNote);
  await page.getByLabel('Paper summary').fill('The paper presents a method and evidence.');
  await page.getByRole('button', { name: 'Submit summary' }).click();
  await expect(page.getByText('Summary saved.', { exact: true })).toBeVisible();
  await expect(page.getByText('E2E summary feedback.', { exact: true }).first()).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Paper summary')).toHaveValue(
    'The paper presents a method and evidence.',
  );
  await expect(page.getByText('E2E summary feedback.', { exact: true }).first()).toBeVisible();

  await page.locator('[data-page="1"]').scrollIntoViewIfNeeded();
  await expect(page.getByLabel('Go to page')).toHaveValue('1');
  const textLayer = page.locator('[data-page="1"] .react-pdf__Page__textContent').first();
  await expect(textLayer).toContainText('Fixture page one');
  const selectPassage = () =>
    textLayer.evaluate((element) => {
      const text = element.querySelector('span')?.firstChild;
      if (!text) return '';
      const range = document.createRange();
      range.selectNodeContents(text);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      return selection?.toString().trim() ?? '';
    });
  const selectedText = await selectPassage();
  const askTutor = page.getByRole('button', { name: 'Ask tutor' });
  await expect(askTutor).toBeVisible();
  const selectionBounds = await askTutor.evaluate((button) => {
    const selection = window.getSelection();
    if (!selection?.rangeCount) return null;
    const selectedRect = selection.getRangeAt(0).getBoundingClientRect();
    const buttonRect = button.getBoundingClientRect();
    return {
      buttonTop: buttonRect.top,
      buttonBottom: buttonRect.bottom,
      selectionTop: selectedRect.top,
      selectionBottom: selectedRect.bottom,
    };
  });
  if (!selectionBounds) throw new Error('The selected passage has no bounding rectangle');
  expect(
    selectionBounds.buttonBottom <= selectionBounds.selectionTop ||
      selectionBounds.buttonTop >= selectionBounds.selectionBottom,
  ).toBe(true);
  await askTutor.click();
  const tutor = page.getByRole('complementary', { name: 'Tutor' });
  await expect(tutor).toBeVisible();
  const viewportHeight = await page.evaluate(() => window.innerHeight);
  expect(
    await tutor.evaluate((element) => element.getBoundingClientRect().height),
  ).toBeGreaterThanOrEqual(viewportHeight * 0.9);
  await expect(page.getByRole('heading', { name: 'Why this paper' })).toHaveCount(0);
  await expect
    .poll(() => reader.evaluate((element) => element.scrollWidth))
    .toBeLessThanOrEqual((await reader.evaluate((element) => element.clientWidth)) + 1);
  await expect(page.locator('[data-slot="sheet-overlay"]')).toHaveCount(0);
  const input = tutor.getByLabel('Ask the tutor');
  await expect(input).toBeVisible();
  await expect(input).toBeFocused();
  const selectedPreview = `${selectedText.slice(0, 120)}${selectedText.length > 120 ? '…' : ''}`;
  const quoteChip = tutor.getByText(`Selected: “${selectedPreview}”`, { exact: true });
  await expect(quoteChip).toBeVisible();
  await expect(tutor.getByText('No chats yet')).toHaveCount(0);
  await expect(tutor.getByTestId('tutor-reading-context')).toHaveText(
    'Reading: Fixture Paper One · page 1 of 3 · selected passage',
  );
  await input.fill('What does this passage mean?');
  const sendButton = tutor.getByRole('button', { name: 'Send' });
  await expect(sendButton).toBeEnabled();
  const sent = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && response.url().includes('/api/tutor/threads'),
    { timeout: 10000 },
  );
  await sendButton.click();
  await expect(tutor.getByTestId('tutor-user-message')).toContainText(
    'What does this passage mean?',
  );
  const response = await sent;
  expect(response.status()).toBe(200);
  await expect(tutor.getByTestId('tutor-assistant-message')).toContainText(
    'Tutor reply to: What does this passage mean?',
  );
  expect(response.request().postDataJSON()).toMatchObject({
    page: 'paper',
    paperId: 'fixture-paper-one',
    selection: selectedText,
  });
  await expect(quoteChip).toHaveCount(0);
  await expect(tutor.getByTestId('tutor-reading-context')).not.toContainText('selected passage');
  const conversationTitle =
    (await tutor.getByTestId('tutor-conversation-title').textContent()) ?? '';
  const continuedSelection = await selectPassage();
  const continuedPreview = `${continuedSelection.slice(0, 120)}${
    continuedSelection.length > 120 ? '…' : ''
  }`;
  await expect(askTutor).toBeVisible();
  await askTutor.click();
  await expect(input).toBeFocused();
  await expect(tutor.getByTestId('tutor-conversation-title')).toHaveText(conversationTitle);
  const continuedChip = tutor.getByText(`Selected: “${continuedPreview}”`, { exact: true });
  await expect(continuedChip).toBeVisible();
  await tutor.getByRole('button', { name: 'Clear selected passage' }).click();
  await expect(continuedChip).toHaveCount(0);
  await expect(tutor.getByTestId('tutor-reading-context')).not.toContainText('selected passage');
  await page.getByRole('link', { name: 'Back to Course' }).click();
  const completedPaperLink = page.getByRole('link', { name: /Fixture Paper One/ }).first();
  await expect(completedPaperLink.locator('[data-slot="badge"]')).toHaveText('Completed');
  await expect(completedPaperLink.locator('[data-slot="badge"]')).toHaveClass(/bg-emerald-50/);
});

test('paper reader layout shift stays below the course threshold', async ({ page }) => {
  await page.addInitScript(() => {
    window.__paperLayoutShifts = [];
    new PerformanceObserver((entries) => {
      for (const entry of entries.getEntries()) {
        const shift = entry as PerformanceEntry & { hadRecentInput: boolean; value: number };
        if (!shift.hadRecentInput) window.__paperLayoutShifts.push(shift.value);
      }
    }).observe({ type: 'layout-shift', buffered: true });
  });
  await page.goto('/papers/fixture-paper-one');
  await expect(page.locator('.react-pdf__Page__canvas').first()).toBeVisible();
  const cls = await page.evaluate(() =>
    window.__paperLayoutShifts.reduce((sum, value) => sum + value, 0),
  );
  expect(cls, 'paper reader CLS').toBeLessThan(0.02);
});

test('scrolling through PDF pages does not show the route loading skeleton', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/papers/fixture-paper-one');
  await expect(page.locator('[data-page="1"] .react-pdf__Page__canvas')).toBeVisible();
  await expect(page.getByLabel('Go to page').locator('..')).toContainText('of 3');

  await page.evaluate(() => {
    window.__routeSkeletonSeen = false;
    const observer = new MutationObserver(() => {
      if (document.querySelector('[data-testid="route-skeleton"]')) {
        window.__routeSkeletonSeen = true;
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });

  const reader = page.getByLabel('PDF reader');
  await reader.scrollIntoViewIfNeeded();
  const readerBounds = await reader.boundingBox();
  if (!readerBounds) throw new Error('The PDF reader has no visible bounds');
  await page.mouse.move(
    readerBounds.x + readerBounds.width / 2,
    readerBounds.y + readerBounds.height / 2,
  );
  const scrollToEdge = async (direction: 1 | -1) => {
    for (let step = 0; step < 20; step += 1) {
      await page.mouse.wheel(0, direction * 400);
      await page.waitForTimeout(150);
      const reachedEdge = await reader.evaluate(
        (element, delta) =>
          delta > 0
            ? element.scrollTop + element.clientHeight >= element.scrollHeight - 1
            : element.scrollTop <= 1,
        direction,
      );
      if (reachedEdge) break;
    }
  };

  await scrollToEdge(1);
  expect(await page.evaluate(() => window.__routeSkeletonSeen)).toBe(false);
  await expect(page.locator('[data-page="3"] .react-pdf__Page__canvas')).toBeVisible();
  await expect(page.getByLabel('Go to page')).toHaveValue('3');
  await scrollToEdge(-1);
  await expect(page.locator('[data-page="1"] .react-pdf__Page__canvas')).toBeVisible();
  await expect(page.getByLabel('Go to page')).toHaveValue('1');

  const pages = reader.locator('[data-page]');
  await expect(pages).toHaveCount(3);
  for (const pageSlot of await pages.all()) {
    await expect(pageSlot).toBeVisible();
  }
  expect(await page.evaluate(() => window.__routeSkeletonSeen)).toBe(false);
});

test('Saturday session offers the current week papers and a skip action', async ({ page }) => {
  const response = await page.request.post('/api/sessions', {
    headers: { 'X-Now': '2026-01-01T12:00:00.000Z' },
    data: { kind: 'saturday', budgetMinutes: 300 },
  });
  expect(response.status()).toBe(201);
  const session = await response.json();
  expect(session.activities.some((activity: { kind: string }) => activity.kind === 'paper')).toBe(
    true,
  );
  const sessionId = session.id as string;
  await page.goto(`/session/${sessionId}`);
  await expect(page.getByRole('heading', { name: 'Paper reading' })).toBeVisible();
  await expect(page.getByText("Pick one of this week's papers to read.")).toBeVisible();
  const sessionPaper = page.getByRole('link', { name: /Fixture Paper One/ });
  await expect(sessionPaper).toBeVisible();
  await expect(sessionPaper).toContainText('Not started');
  await expect(page.getByRole('link', { name: /Fixture Paper Two/ })).toBeVisible();
  await page.getByRole('button', { name: 'Skip for today' }).click();
});
