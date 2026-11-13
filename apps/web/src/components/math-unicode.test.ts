import katex from 'katex';
import { expect, test } from 'vitest';
import { normalizeUnicodeMath } from './math-unicode.js';

test.each(['y\u0305', 'y\u0305_i', '𝑦\u0305_i', String.raw`\text{y̅}`, 'β̅'])(
  'repairs an unsupported Unicode overline without changing its base or subscript: %s',
  (value) => {
    expect(() => katex.renderToString(value)).toThrow('Unknown accent');
    const repaired = normalizeUnicodeMath(value);
    expect(repaired).toBe(value.replaceAll('\u0305', '\u0304'));
    expect(() => katex.renderToString(repaired)).not.toThrow();
  },
);

test.each([
  String.raw`\hat{y}`,
  String.raw`\hat{y}_i`,
  String.raw`\bar{y}`,
  'y_i',
  'ŷ',
  'ŷ_i',
  'y\u0302_i',
])('preserves valid prediction and target notation: %s', (value) =>
  expect(normalizeUnicodeMath(value)).toBe(value),
);
