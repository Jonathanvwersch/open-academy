import { mkdirSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { env } from '../../apps/api/src/config.js';
import { createDb } from '../../apps/api/src/db/client.js';
import { sessionActivities, studySessions, users } from '../../apps/api/src/db/schema.js';

const conceptId = 'probability-basics';
const screenshotDir = 'test-results/screenshots/screenshots/probability-lesson';

test.describe('Probability basics real-content rendering', () => {
  test.skip(
    process.env.PLAYWRIGHT_CONTENT_DIR !== 'content',
    'requires the repository content directory',
  );

  test.beforeEach(async () => {
    mkdirSync(screenshotDir, { recursive: true });
    const db = createDb(env.TEST_DATABASE_URL);
    await db.delete(users);
    await db.insert(users).values({
      displayName: 'Probability basics E2E learner',
      timezone: 'UTC',
      startDate: '2026-01-01',
      prefs: { scheduleMinutes: 60 },
    });
    await db.$client.end();
  });

  test('renders each Probability basics explanation and worked example', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/lessons/${conceptId}`);
    await expect(page.getByRole('heading', { name: 'Probability basics' })).toBeVisible();

    const titles = [
      'Measure how likely something is',
      'List the chance of each possible number',
      'Average the results over many tries',
      'Update a chance with new information',
    ];
    const firstHeadings = [
      'Six faces of a die',
      'A number decided by chance',
      'Averaging many spins',
      'Ruling out faces',
    ];
    const points = page.locator('article');
    await expect(points).toHaveCount(titles.length);
    for (const [index, title] of titles.entries()) {
      const point = points.nth(index);
      await expect(point).toContainText(title);
      await expect(point.getByRole('heading', { name: firstHeadings[index] })).toBeVisible();
      await expect(point).toContainText('Be careful');
      await expect(point.getByRole('img')).toHaveCount(1);
      await expect(point.locator('.katex-error')).toHaveCount(0);
      await point.screenshot({
        path: `${screenshotDir}/kp-${index + 1}-${title.toLowerCase().replaceAll(' ', '-')}.png`,
      });
    }
    await expect(page.locator('.katex-error')).toHaveCount(0);
    await expect.poll(async () => hasHorizontalOverflow(page)).toBe(false);
    await page.screenshot({ path: `${screenshotDir}/full-lesson.png`, fullPage: true });

    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(async () => hasHorizontalOverflow(page)).toBe(false);
    await page.screenshot({ path: `${screenshotDir}/full-lesson-mobile.png`, fullPage: true });
  });

  test('shows a basics question and numeric wrong-answer feedback', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const db = createDb(env.TEST_DATABASE_URL);
    const [learner] = await db.select({ id: users.id }).from(users).limit(1);
    if (!learner) throw new Error('Missing E2E learner');
    const [session] = await db
      .insert(studySessions)
      .values({
        userId: learner.id,
        kind: 'weekday',
        plannedMinutes: 20,
        status: 'active',
        startedAt: new Date(),
      })
      .returning();
    if (!session) throw new Error('Could not create practice session');
    await db.insert(sessionActivities).values({
      sessionId: session.id,
      idx: 0,
      kind: 'learn',
      conceptId,
      exerciseIds: ['probability-basics-explain'],
      plannedMinutes: 20,
      status: 'in_progress',
    });
    await db.$client.end();

    await page.goto(`/session/${session.id}`);
    await expect(page.getByTestId('lesson-problem')).toBeVisible();
    await expect(page.getByTestId('lesson-problem-prompt')).toContainText('What is an event?');
    const firstRun = await currentRun(page);
    expect(firstRun.pendingProblem.exercise.id).toBe('pb-events-basics');
    await page.screenshot({ path: `${screenshotDir}/basics-question.png`, fullPage: true });

    const answerPayload = await page.evaluate(async (problemId) => {
      const response = await fetch(`/api/test/lesson-problems/${problemId}/answer`);
      return response.json();
    }, firstRun.pendingProblem.id);
    const correctIds = Array.isArray(answerPayload.answer)
      ? answerPayload.answer
      : [answerPayload.answer];
    const correctOption = firstRun.pendingProblem.exercise.options.find((option: { id: string }) =>
      correctIds.includes(option.id),
    );
    expect(correctOption).toBeDefined();
    await page.locator(`[id="${firstRun.pendingProblem.exercise.id}-${correctOption.id}"]`).click();
    const basicsResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/lessons/${conceptId}/run/answer`) &&
        response.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Submit answer' }).click();
    expect((await basicsResponse).status()).toBe(200);
    await page.reload();
    await expect(page.getByRole('status')).toContainText('Correct');
    await page.getByRole('button', { name: 'Next problem' }).click();
    await expect
      .poll(async () => (await currentRun(page))?.pendingProblem?.exercise.id)
      .toBe('pb-complement-why');

    const selfExplanation = (await currentRun(page)).pendingProblem;
    const equalChancesOption = selfExplanation.exercise.options.find((option: { text: string }) =>
      option.text.includes('equal chances of one half'),
    );
    expect(equalChancesOption).toBeDefined();
    await page.locator(`[id="${selfExplanation.exercise.id}-${equalChancesOption.id}"]`).click();
    const selfExplanationResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/lessons/${conceptId}/run/answer`) &&
        response.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Submit answer' }).click();
    expect((await selfExplanationResponse).status()).toBe(200);
    await page.reload();
    await expect(page.getByRole('status')).toContainText('Not quite');
    await expect(page.getByRole('status')).toContainText(
      'Here 11 of 20 sales were not above asking, so the complement is more likely.',
    );
    await page.getByRole('button', { name: 'Next problem' }).click();
    await expect
      .poll(async () => (await currentRun(page))?.pendingProblem?.exercise.id)
      .toBe('pb-frequency-fixed');

    await expect(page.getByTestId('lesson-problem-prompt')).toContainText(
      'Use the fraction of these sales to estimate the probability that a sale was above asking.',
    );
    await page.getByLabel('Your answer').fill('0.6');
    const calculationResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/lessons/${conceptId}/run/answer`) &&
        response.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Submit answer' }).click();
    expect((await calculationResponse).status()).toBe(200);
    await page.reload();
    const feedback = page.getByRole('status');
    await expect(feedback).toContainText('Not quite');
    await expect(feedback).toContainText(
      'That is the estimated probability of the complement, not of an above-asking sale.',
    );
    await page.screenshot({
      path: `${screenshotDir}/calculation-wrong-feedback.png`,
      fullPage: true,
    });
    await expect(page.locator('.katex-error')).toHaveCount(0);
    await expect.poll(async () => hasHorizontalOverflow(page)).toBe(false);
  });
});

async function currentRun(page: import('@playwright/test').Page) {
  return page.evaluate(async (concept) => {
    const response = await fetch(`/api/lessons/${concept}/run`);
    return (await response.json()).run;
  }, conceptId);
}

async function hasHorizontalOverflow(page: import('@playwright/test').Page) {
  return page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
}
