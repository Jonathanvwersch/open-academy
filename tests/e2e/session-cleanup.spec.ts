import { mkdirSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { createDb } from '../../src/server/db/client.js';
import { sessionActivities, studySessions, users } from '../../src/server/db/schema.js';
import { env } from '../../src/server/env.js';

const db = createDb(env.TEST_DATABASE_URL);
const screenshotDir = '/home/ubuntu/screenshots/shadcn';
const lessonCardScreenshotDir = '/home/ubuntu/screenshots/lesson-cards';
const questionDotsScreenshotDir = '/home/ubuntu/screenshots/question-dots';
mkdirSync(screenshotDir, { recursive: true });
mkdirSync(lessonCardScreenshotDir, { recursive: true });
mkdirSync(questionDotsScreenshotDir, { recursive: true });
let userId = '';

test.beforeEach(async () => {
  await db.delete(users);
  const [user] = await db
    .insert(users)
    .values({
      displayName: 'Session cleanup E2E learner',
      timezone: 'UTC',
      startDate: '2026-01-01',
      prefs: { scheduleMinutes: 60 },
    })
    .returning();
  if (!user) throw new Error('Could not create E2E learner');
  userId = user.id;
});

test.afterAll(async () => {
  await db.$client.end();
});

async function createActivity(
  conceptId: string,
  exerciseIds: string | string[],
  kind: 'practice' | 'learn' = 'practice',
  progress?: Record<string, unknown>,
) {
  const [session] = await db
    .insert(studySessions)
    .values({
      userId,
      kind: 'weekday',
      plannedMinutes: 20,
      status: 'active',
      startedAt: new Date('2026-01-01T12:00:00.000Z'),
    })
    .returning();
  if (!session) throw new Error('Could not create E2E session');
  await db.insert(sessionActivities).values({
    sessionId: session.id,
    idx: 0,
    kind,
    conceptId,
    exerciseIds: Array.isArray(exerciseIds) ? exerciseIds : [exerciseIds],
    plannedMinutes: 10,
    status: 'in_progress',
    ...(progress ? { progress } : {}),
  });
  return session.id;
}

async function openExplainActivity(page: Page) {
  const sessionId = await createActivity('supervised-learning', 'sl-explain-setup', 'learn', {
    lessonRunnerContinued: true,
  });
  await page.goto(`/session/${sessionId}`);
  await expect(page.getByRole('heading', { name: 'Supervised learning' })).toBeVisible();
  return sessionId;
}

test('legacy session header links to a read-only lesson and returns with the result intact', async ({
  page,
}) => {
  const sessionId = await createActivity('vectors', 'vectors-magnitude');
  await page.goto(`/session/${sessionId}`);
  await expect(page.getByRole('heading', { name: 'Vectors' })).toBeVisible();
  await expect(page.getByText('Practice · Activity 1 of 1 today')).toBeVisible();
  await expect(page.getByRole('list', { name: 'Session timeline' })).toHaveCount(0);
  await expect(page.getByText(/About \d+ minutes remaining/)).toHaveCount(0);
  await expect(page.getByText('Review', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'View lesson' })).toBeVisible();
  await page.screenshot({
    path: `${screenshotDir}/legacy-practice-header.png`,
    fullPage: true,
  });

  await page.getByLabel('Your answer').fill('0');
  await page.getByRole('button', { name: 'Submit answer' }).click();
  await expect(page.getByText('Not quite', { exact: true })).toBeVisible();
  const questionText = (await page.getByTestId('exercise-prompt').textContent()) ?? '';
  expect(questionText.trim()).not.toBe('');
  await page.getByRole('link', { name: 'View lesson' }).click();
  await expect(page).toHaveURL(new RegExp(`/lessons/vectors\\?from=${sessionId}`));
  await expect(page.getByRole('heading', { name: 'Vectors' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Show answer' }).first()).toBeVisible();
  await page.screenshot({ path: `${screenshotDir}/legacy-lesson.png`, fullPage: true });
  await page.getByRole('link', { name: 'Back to session' }).click();
  await expect(page.getByRole('heading', { name: 'Vectors' })).toBeVisible();
  await expect(page.getByText('Not quite', { exact: true })).toBeVisible();
  await expect(page.getByTestId('exercise-prompt')).toContainText(questionText);
});

test('wrong numeric answers offer one persisted retry', async ({ page }) => {
  const sessionId = await createActivity('vectors', 'vectors-magnitude');
  await page.goto(`/session/${sessionId}`);
  await page.getByLabel('Your answer').fill('0');
  await page.getByRole('button', { name: 'Submit answer' }).click();
  await expect(page.getByText('Not quite', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again · 1 try left' })).toBeVisible();
  await page.screenshot({ path: `${screenshotDir}/wrong-numeric-retry.png`, fullPage: true });
  await page.reload();
  await expect(page.getByRole('button', { name: 'Try again · 1 try left' })).toBeVisible();
});

test('practice question progress shows outcomes, current question, and wraps on mobile', async ({
  page,
}) => {
  const sessionId = await createActivity('vectors', [
    'vectors-magnitude',
    'vectors-component-sum',
    'vectors-dot-product',
  ]);
  await page.goto(`/session/${sessionId}`);

  await expect(page.getByText('Practice · Activity 1 of 1 today')).toBeVisible();
  const progress = page.getByTestId('question-progress');
  const dots = progress.getByRole('list', { name: 'Questions' }).locator('li');
  await expect(progress).toContainText('Question 1 of 3');
  await expect(dots).toHaveCount(3);
  await expect(dots.nth(0)).toHaveAttribute('data-state', 'current');
  await expect(dots.nth(1)).toHaveAttribute('data-state', 'upcoming');
  await expect(dots.nth(2)).toHaveAttribute('data-state', 'upcoming');

  await page.getByLabel('Your answer').fill('5');
  await page.getByRole('button', { name: 'Submit answer' }).click();
  await expect(page.getByText('Correct', { exact: true })).toBeVisible();
  await expect(dots.nth(0)).toHaveAttribute('data-state', 'correct');

  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByTestId('exercise-prompt')).toContainText('sum of the coordinates');
  await expect(progress).toContainText('Question 2 of 3');
  await expect(dots.nth(0)).toHaveAttribute('data-state', 'correct');
  await expect(dots.nth(1)).toHaveAttribute('data-state', 'current');
  await expect(dots.nth(2)).toHaveAttribute('data-state', 'upcoming');

  await page.getByLabel('Your answer').fill('0');
  await page.getByRole('button', { name: 'Submit answer' }).click();
  await expect(page.getByText('Not quite', { exact: true })).toBeVisible();
  await expect(progress).toContainText('Question 2 of 3');
  await expect(dots.nth(0)).toHaveAttribute('data-state', 'correct');
  await expect(dots.nth(1)).toHaveAttribute('data-state', 'incorrect');
  await expect(dots.nth(2)).toHaveAttribute('data-state', 'upcoming');
  await page.screenshot({
    path: `${questionDotsScreenshotDir}/practice-desktop.png`,
    fullPage: true,
  });

  await page.setViewportSize({ width: 390, height: 844 });
  const pageWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(pageWidth).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: `${questionDotsScreenshotDir}/practice-mobile.png`,
    fullPage: true,
  });
});

test('knowledge-point lesson review shows explanations, final check and summary without practice problems', async ({
  page,
}) => {
  await page.goto('/lessons/supervised-learning');
  await expect(page.getByRole('heading', { name: 'Supervised learning' })).toBeVisible();
  await expect(page.getByText('Worked example').first()).toBeVisible();
  await expect(page.getByTestId('lesson-problem')).toHaveCount(0);
  await expect(page.getByText(/Pick any real problem you care about/)).toBeVisible();
  const finalCheck = page.getByRole('heading', { name: 'Check yourself', exact: true });
  const finalCheckCard = finalCheck.locator('xpath=../..');
  const summary = page.getByRole('heading', { name: 'Key takeaways', exact: true });
  await expect(finalCheck).toBeVisible();
  await expect(finalCheckCard.getByRole('button', { name: 'Show answer' })).toBeVisible();
  await finalCheckCard.getByRole('button', { name: 'Show answer' }).click();
  await expect(
    finalCheckCard.getByText('No answer is available for this check.', { exact: true }),
  ).toBeVisible();
  await expect(summary).toBeVisible();
  expect(
    await page.evaluate(() => {
      const headings = [...document.querySelectorAll('h1, h2, h3, h4, h5, h6')];
      const check = headings.find((heading) => heading.textContent?.trim() === 'Check yourself');
      const takeaways = headings.find((heading) => heading.textContent?.trim() === 'Key takeaways');
      const points = [...document.querySelectorAll('article h2')];
      const lastPoint = points.at(-1);
      return Boolean(
        lastPoint &&
          check &&
          takeaways &&
          (lastPoint.compareDocumentPosition(check) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0 &&
          (check.compareDocumentPosition(takeaways) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
      );
    }),
  ).toBe(true);
  await page.screenshot({ path: `${screenshotDir}/knowledge-point-lesson.png`, fullPage: true });
});

test('legacy lesson review presents labelled blocks as cards with checks inside', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.route('**/api/lessons/train-test-split/review', (route) =>
    route.fulfill({
      json: {
        lesson: {
          blocks: [
            {
              kind: 'objective',
              md: '**Goal:** explain what training, validation and test sets are each for.',
            },
            {
              kind: 'intuition',
              md: 'A model that has seen the answers will look better than it is.',
            },
            {
              kind: 'example',
              md: 'Keep copies of one sale together in the same split.',
            },
            {
              kind: 'faded',
              md: '```svg\n<svg viewBox="0 0 10 10" aria-label="Data split diagram"><rect x="1" y="1" width="8" height="8" fill="#abc"/></svg>\n```',
            },
            {
              kind: 'math',
              md: 'The test error estimates future error when the split is representative.',
            },
            { kind: 'check', exercise: 'tts-check-purpose' },
            { kind: 'faded', md: 'Fit preprocessing statistics on the training set only.' },
            { kind: 'summary', md: 'Train to fit, validate to choose, test once to report.' },
          ],
        },
        checkAnswers: {
          'tts-check-purpose': 'Hyperparameter selection uses validation data.',
        },
        conceptTitle: 'Training and evaluation splits',
      },
    }),
  );
  await page.route('**/api/exercises/tts-check-purpose', (route) =>
    route.fulfill({
      json: {
        id: 'tts-check-purpose',
        type: 'mc',
        prompt: 'You try 20 hyperparameter settings and keep the one with the best score.',
        options: [
          { id: 'validation', text: 'Validation' },
          { id: 'test', text: 'Test' },
        ],
      },
    }),
  );
  await page.goto('/lessons/train-test-split');
  await expect(page.getByRole('heading', { name: 'Training and evaluation splits' })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Data split diagram' })).toBeVisible();
  for (const [label, count] of [
    ['Goal', 1],
    ['Example', 1],
    ['Key formula', 1],
    ['Check yourself', 1],
    ['Fill in the steps', 2],
    ['Key takeaways', 1],
  ] as const) {
    const title = page.getByRole('heading', { name: label, exact: true });
    await expect(title).toHaveCount(count);
    for (const heading of await title.all()) {
      await expect(heading).toBeVisible();
      await expect(heading.locator('xpath=../..')).toHaveAttribute('data-slot', 'card');
    }
  }
  const intuition = page.getByText(
    'A model that has seen the answers will look better than it is.',
    { exact: true },
  );
  await expect(intuition.locator('xpath=ancestor::*[@data-slot="card"]')).toHaveCount(0);
  const checkCard = page
    .getByRole('heading', { name: 'Check yourself', exact: true })
    .locator('xpath=../..');
  await expect(checkCard.getByRole('button', { name: 'Show answer' })).toBeVisible();
  await page.screenshot({
    path: `${lessonCardScreenshotDir}/legacy-train-test-split.png`,
    fullPage: true,
  });
  await checkCard.getByRole('button', { name: 'Show answer' }).click();
  await expect(
    checkCard.getByText('Hyperparameter selection uses validation data.', { exact: true }),
  ).toBeVisible();
});

test('explain tutor feedback shows rubric and model answer, and survives reload', async ({
  page,
}) => {
  await openExplainActivity(page);
  await expect(page.getByRole('checkbox')).toHaveCount(0);
  await expect(page.getByLabel('Your answer')).toBeVisible();
  await page.getByLabel('Your answer').fill('Inputs go in and a target comes out.');
  await page.getByRole('button', { name: 'Submit answer' }).click();
  await expect(page.getByText('Rubric', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Model answer', { exact: true })).toBeVisible();
  await expect(page.getByText('Your answer:', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Predict delivery time in minutes', { exact: false })).toBeVisible();
  await expect(
    page.getByText('Inputs and targets are clearly identified', { exact: false }),
  ).toBeVisible();
  const rubricList = page.getByRole('status').locator('ul');
  await expect(rubricList.locator('.katex')).toBeVisible();
  await expect(rubricList).not.toContainText('$');
  await page.screenshot({ path: `${screenshotDir}/explain-rubric-feedback.png`, fullPage: true });
  await page.reload();
  await expect(page.getByText('Model answer', { exact: true })).toBeVisible();
  await expect(page.getByText('Your answer:', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Your answer')).toHaveAttribute('readonly', '');
  await expect(
    page.getByText('Inputs and targets are clearly identified', { exact: false }),
  ).toBeVisible();
});

test('fallback explain flow reveals the model answer before the self-check step', async ({
  page,
}) => {
  await openExplainActivity(page);
  let submissions = 0;
  await page.route('**/api/attempts', async (route) => {
    submissions += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(
        submissions === 1
          ? {
              status: 'self_check_required',
              graded_by: 'self',
              feedback: 'Read the model answer, then review your response.',
              yourAnswer: 'A model predicts an answer.',
              rubric: [
                { id: 'r1', criterion: 'A key idea is named.', required: true },
                { id: 'r2', criterion: 'A second idea is named.', required: false },
              ],
              exemplar: 'A model maps inputs to a target.',
            }
          : {
              status: 'graded',
              correct: 0.5,
              credit: 0.5,
              graded_by: 'self',
              feedback: 'Compare your explanation with the criteria.',
              rubric: [
                {
                  id: 'norms',
                  criterion: 'States $a\\cdot b = \\|a\\|\\|b\\|\\cos\\theta$.',
                  judgement: 'met',
                },
              ],
              exemplar: 'A model maps inputs to a target.',
            },
      ),
    });
  });
  await page.getByLabel('Your answer').fill('A model predicts an answer.');
  await page.getByRole('button', { name: 'Submit answer' }).click();
  await expect(page.getByText('Model answer', { exact: true })).toBeVisible();
  await expect(page.getByText('Your answer:', { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole('status').getByText('A model predicts an answer.', { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByLabel('Your answer')).toHaveCount(1);
  await expect(page.getByLabel('Your answer')).toHaveAttribute('readonly', '');
  await expect(page.getByLabel('Your answer')).toHaveValue('A model predicts an answer.');
  await expect(page.getByText('Which of these did your answer include?')).toBeVisible();
  await expect(page.getByText('key point', { exact: true })).toHaveCount(2);
  await expect(page.getByRole('checkbox')).toHaveCount(3);
  await page.screenshot({
    path: `${screenshotDir}/explain-fallback-step-2.png`,
    fullPage: true,
  });
  await page.getByRole('checkbox').nth(1).click();
  await expect(page.getByRole('checkbox').nth(1)).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('button', { name: 'Submit self-check' }).click();
  await expect(page.getByText('Partly correct', { exact: true })).toBeVisible();
  await expect(page.getByText('Your answer:', { exact: true })).toHaveCount(0);
  const rubricList = page.getByRole('status').locator('ul');
  await expect(rubricList.locator('.katex')).toBeVisible();
  await expect(rubricList).not.toContainText('$');
  await expect(rubricList.locator('.katex-html')).toContainText('∥');
  await expect(page.getByRole('button', { name: 'Continue' })).toBeVisible();
});
