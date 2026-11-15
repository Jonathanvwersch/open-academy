import { readFileSync } from 'node:fs';
import type { LessonReviewPayload } from '@academy/contracts/lessons';
import { expect, type Locator, test } from '@playwright/test';
import { env } from '../../apps/api/src/config.js';
import { createDb } from '../../apps/api/src/db/client.js';
import { users } from '../../apps/api/src/db/schema.js';

const db = createDb(env.TEST_DATABASE_URL);
const source = readFileSync(
  new URL('../../content/lessons/logistic-regression.yaml', import.meta.url),
  'utf8',
);
const slopeParagraph = source.match(/^\s+At score 0, where .+$/m)?.[0].trim();
if (!slopeParagraph) throw new Error('The logistic regression slope paragraph was not found.');
const longSum = Array.from({ length: 20 }, (_, index) => `x_{${index + 1}}`).join('+');

test.beforeEach(async ({ page }) => {
  await db.delete(users);
  await db
    .insert(users)
    .values({ displayName: 'Math punctuation learner', timezone: 'UTC', startDate: '2026-01-01' });
  const payload: LessonReviewPayload = {
    course: null,
    canRestart: false,
    conceptTitle: 'Math rendering regression',
    checkAnswers: {},
    checks: {},
    runStatus: null,
    lesson: {
      blocks: [
        { kind: 'intuition', md: slopeParagraph },
        { kind: 'intuition', md: `Long inline sum: $${longSum}$.` },
        { kind: 'math', md: `$$\n${longSum}=0\n$$` },
      ],
    },
  };
  await page.route('**/api/lessons/vectors/review', (route) => route.fulfill({ json: payload }));
});

test.afterAll(async () => {
  await db.$client.end();
});

async function punctuationPositions(paragraph: Locator) {
  return paragraph.evaluate((element) => {
    return [...element.querySelectorAll('.katex')].flatMap((math) => {
      const punctuationSpan = math.querySelector('.math-trailing-punctuation');
      if (!punctuationSpan) return [];
      const range = document.createRange();
      range.selectNodeContents(punctuationSpan);
      const punctuation = range.getBoundingClientRect();
      const lastBase = [...math.querySelectorAll('.katex-html > .katex-base')].at(-1);
      if (!lastBase) throw new Error('Expected visible KaTeX output.');
      const glyph = lastBase.getBoundingClientRect();
      return [
        {
          punctuationTop: punctuation.top,
          punctuationBottom: punctuation.bottom,
          mathTop: glyph.top,
          mathBottom: glyph.bottom,
        },
      ];
    });
  });
}

test('the logistic regression paragraph keeps punctuation beside its equations at mobile and desktop widths', async ({
  page,
}) => {
  await page.goto('/lessons/vectors');
  const paragraph = page.locator('p').filter({ hasText: 'At score 0, where' });
  await expect(paragraph).toBeVisible();
  for (const width of [320, 375, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => document.fonts.ready);
    const positions = await punctuationPositions(paragraph);
    expect(positions, `Expected all six punctuation marks at ${width}px`).toHaveLength(6);
    for (const position of positions) {
      expect(
        position.punctuationTop,
        `Punctuation wrapped away from math at ${width}px`,
      ).toBeLessThan(position.mathBottom);
      expect(position.punctuationBottom).toBeGreaterThan(position.mathTop);
    }
    await paragraph.screenshot({
      path: `test-results/screenshots/math-punctuation/logistic-paragraph-${width}.png`,
    });
  }
});

test('punctuation attachment preserves inline equation wrapping and display equation scrolling', async ({
  page,
}) => {
  await page.goto('/lessons/vectors');
  const inline = page.locator('p').filter({ hasText: 'Long inline sum:' });
  const display = page.locator('.katex-display');
  for (const width of [320, 375, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => document.fonts.ready);
    const geometry = await inline.evaluate((element) => ({
      width: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }));
    expect(geometry.scrollWidth, `Long inline math overflows at ${width}px`).toBeLessThanOrEqual(
      geometry.width + 1,
    );
    const positions = await punctuationPositions(inline);
    expect(positions).toHaveLength(1);
    expect(positions[0]?.punctuationTop).toBeLessThan(positions[0]?.mathBottom ?? 0);
    await expect(display).toHaveCount(1);
    expect(await display.evaluate((element) => getComputedStyle(element).overflowX)).toBe('auto');
    expect(await display.evaluate((element) => element.scrollWidth)).toBeGreaterThan(
      await display.evaluate((element) => element.clientWidth),
    );
    const pageWidth = await page.evaluate(() => ({
      actual: document.documentElement.scrollWidth,
      available: window.innerWidth,
    }));
    expect(pageWidth.actual).toBeLessThanOrEqual(pageWidth.available);
  }
});
