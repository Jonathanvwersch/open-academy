import { repairTutorMarkdown } from '@academy/shared/tutor';
import { expect, test } from 'vitest';

test('repairs a double-dollar opener paired with a single-dollar closer', () => {
  expect(repairTutorMarkdown('slope is $$\\sigma(z)(1-\\sigma(z))$, so near $0$ or $1$.')).toBe(
    'slope is $\\sigma(z)(1-\\sigma(z))$, so near $0$ or $1$.',
  );
});

test('repairs control-character escapes for Greek symbols', () => {
  expect(repairTutorMarkdown('slope $\u0003c3(z)(1-\u0003c3(z))$')).toBe('slope $σ(z)(1-σ(z))$');
});

test.each([
  ['`$28$` is only the `$u$` route', '$28$ is only the $u$ route'],
  ['`$0,1,\\dots,9$`', '$0,1,\\dots,9$'],
])('unwraps backtick-wrapped inline math: %s', (markdown, expected) => {
  expect(repairTutorMarkdown(markdown)).toBe(expected);
});

test.each([
  '$$a=b$$',
  '$$\n\\begin{aligned} a&=b \\\\ c&=d \\end{aligned}\n$$',
  '$a$ and $b$',
  'costs $5 today',
  '`x = 1`',
  'the `$` sign',
  '`cost $5`',
  '``$x$``',
  '```\nprint(1)\n```',
  'line one\nline two\tend',
])('leaves valid or unrelated Markdown unchanged: %s', (markdown) => {
  expect(repairTutorMarkdown(markdown)).toBe(markdown);
});

test('strips remaining C0 control characters without removing newlines or tabs', () => {
  expect(repairTutorMarkdown('a\u0007b')).toBe('ab');
  expect(repairTutorMarkdown('line one\nline two\tend')).toBe('line one\nline two\tend');
});

test.each([
  ['lower $p \u000dightarrow$ more', 'lower $p \\rightarrow$ more'],
  ['a \u000dightarrow b', 'a \\rightarrow b'],
  ['$\u000crac{1}{2}$', '$\\frac{1}{2}$'],
  ['$\u0008eta$', '$\\beta$'],
  ['$\u0009heta + 1$', '$\\theta + 1$'],
  ['$\u000aabla f$', '$\\nabla f$'],
  ['$a \u000aeq b$', '$a \\neq b$'],
])('repairs escaped math commands: %s', (markdown, expected) => {
  expect(repairTutorMarkdown(markdown)).toBe(expected);
});

test.each([
  ['$$\u000ae^x\u000a$$', '$$\u000ae^x\u000a$$'],
  ['$$\u000au_t = 1\u000a$$', '$$\u000au_t = 1\u000a$$'],
  ['$$\u0009x + 1$$', '$$\u0009x + 1$$'],
  ['$\u000au$', '$\\nu$'],
  ['$$\u000aabla f$$', '$$\\nabla f$$'],
  ['$$\u0009heta$$', '$$\\theta$$'],
  ['$$\u0009hetax$$', '$$\u0009hetax$$'],
  ['$\u000aunder$', '$\u000aunder$'],
])('repairs only the specified math control-character escapes: %s', (markdown, expected) => {
  expect(repairTutorMarkdown(markdown)).toBe(expected);
});

test('repairs tabs before letters only inside math', () => {
  expect(repairTutorMarkdown('a \u0009heta')).toBe('a \u0009heta');
});

test.each([
  ['surprise is `\\log_2(1/p)` bits', 'surprise is $\\log_2(1/p)$ bits'],
  ['probabilities `1/2, 1/4, 1/4` here', 'probabilities $1/2, 1/4, 1/4$ here'],
])('converts mathematical backticks to math: %s', (markdown, expected) => {
  expect(repairTutorMarkdown(markdown)).toBe(expected);
});

test.each([
  ['```js\nconst value = `0.5`;\n```', '```js\nconst value = `0.5`;\n```'],
  ['```\n`\\log x` and `$x$`\n```', '```\n`\\log x` and `$x$`\n```'],
  ['see `1/2`\n```\n`1/2`\n```', 'see $1/2$\n```\n`1/2`\n```'],
])('converts backticked math only outside fenced code: %s', (markdown, expected) => {
  expect(repairTutorMarkdown(markdown)).toBe(expected);
});

test.each(['`\\n`', '`np.log2(p)`', '`print(1)`', '`x = 1`'])(
  'leaves non-math backticks unchanged: %s',
  (markdown) => {
    expect(repairTutorMarkdown(markdown)).toBe(markdown);
  },
);
