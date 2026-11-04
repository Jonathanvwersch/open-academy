import { expect, test } from '@playwright/test';
import { createDb } from '../../src/server/db/client.js';
import { sessionActivities, studySessions, users } from '../../src/server/db/schema.js';
import { env } from '../../src/server/env.js';

declare global {
  interface Window {
    __layoutShifts: number[];
  }
}

const screenshotDir = '/home/ubuntu/screenshots/tutor-sidebar';
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

test('tutor sidebar saves threads, restores after reload, switches chats, hides on diagnostic, and overlays without CLS', async ({
  page,
}) => {
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
  await page.goto(`/session/${sessionId}`);
  await expect(page.getByRole('heading', { name: 'Supervised learning' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Ask the tutor' })).toBeVisible();
  await page.screenshot({ path: `${screenshotDir}/closed-button.png`, fullPage: true });

  await page.evaluate(() => {
    window.__layoutShifts = [];
  });
  await page.getByRole('button', { name: 'Ask the tutor' }).click();
  await expect(page.getByRole('complementary', { name: 'Tutor sidebar' })).toBeVisible();
  await page.getByLabel('Ask the tutor').fill('Explain the first step');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('Tutor reply to: Explain the first step')).toBeVisible();
  const cls = await page.evaluate(() =>
    window.__layoutShifts.reduce((total, value) => total + value, 0),
  );
  expect(cls, 'opening the tutor sidebar CLS').toBeLessThan(0.02);
  await page.screenshot({ path: `${screenshotDir}/open-conversation.png`, fullPage: true });

  await page.reload();
  await expect(page.getByRole('complementary', { name: 'Tutor sidebar' })).toBeVisible();
  await expect(page.getByText('Tutor reply to: Explain the first step')).toBeVisible();
  await expect(page.getByText('Problem 1 · up to 5')).toBeVisible();
  await page.screenshot({ path: `${screenshotDir}/after-reload.png`, fullPage: true });

  await page.getByRole('button', { name: 'New chat' }).click();
  await page.getByLabel('Ask the tutor').fill('Why are targets useful?');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('Tutor reply to: Why are targets useful?')).toBeVisible();
  await page.getByRole('button', { name: 'Tutor conversation' }).click();
  await expect(page.getByRole('listbox', { name: 'Saved tutor conversations' })).toBeVisible();
  await expect(page.getByRole('option').filter({ hasText: 'Supervised learning' })).toHaveCount(2);
  await page.screenshot({ path: `${screenshotDir}/thread-dropdown.png`, fullPage: true });
  await page.getByRole('option').filter({ hasText: 'Explain the first step' }).click();
  await expect(page.getByText('Tutor reply to: Explain the first step')).toBeVisible();

  await page.goto('/diagnostic');
  await expect(page.getByRole('button', { name: 'Open tutor' })).toHaveCount(0);
  await expect(page.getByRole('complementary', { name: 'Tutor sidebar' })).toHaveCount(0);
});
