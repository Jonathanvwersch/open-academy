import { mkdirSync } from 'node:fs';
import { expect, test } from '@playwright/test';
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
  await expect(tutor.getByRole('heading', { name: 'Chats' })).toBeVisible();
  await expect(page.locator('[data-slot="sheet-overlay"]')).toHaveCount(0);
  const mainWidthAfter = await mainContent.evaluate(
    (element) => element.getBoundingClientRect().width,
  );
  expect(mainWidthAfter, 'tutor sidebar reduces the main page width').toBeLessThan(mainWidthBefore);
  await expect(tutor.getByText('No chats yet')).toBeVisible();
  await tutor.getByRole('button', { name: 'New chat' }).first().click();
  await expect(tutor.getByTestId('tutor-conversation-title')).toHaveText('New chat');
  await expect(tutor.getByText('Supervised learning', { exact: true })).toBeVisible();
  await expect(tutor.getByText('Start a conversation')).toBeVisible();

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
  await tutor.getByRole('button', { name: 'New chat' }).first().click();
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
