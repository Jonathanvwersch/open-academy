import { expect, test } from 'vitest';
import { repairTutorMarkdown } from '../src/shared/tutor.js';

test('repairs a double-dollar opener paired with a single-dollar closer', () => {
  expect(repairTutorMarkdown('slope is $$\\sigma(z)(1-\\sigma(z))$, so near $0$ or $1$.')).toBe(
    'slope is $\\sigma(z)(1-\\sigma(z))$, so near $0$ or $1$.',
  );
});

test('repairs control-character escapes for Greek symbols', () => {
  expect(repairTutorMarkdown('slope $\u0003c3(z)(1-\u0003c3(z))$')).toBe('slope $σ(z)(1-σ(z))$');
});

test.each([
  '$$a=b$$',
  '$$\n\\begin{aligned} a&=b \\\\ c&=d \\end{aligned}\n$$',
  '$a$ and $b$',
  'costs $5 today',
  'line one\nline two\tend',
])('leaves valid or unrelated Markdown unchanged: %s', (markdown) => {
  expect(repairTutorMarkdown(markdown)).toBe(markdown);
});

test('strips remaining C0 control characters without removing newlines or tabs', () => {
  expect(repairTutorMarkdown('a\u0007b')).toBe('ab');
  expect(repairTutorMarkdown('line one\nline two\tend')).toBe('line one\nline two\tend');
});
