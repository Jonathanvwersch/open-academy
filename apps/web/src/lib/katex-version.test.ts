import { createRequire } from 'node:module';
import { expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const rehypeRequire = createRequire(require.resolve('rehype-katex'));
const appKatexVersion = require('katex/package.json').version;
const rendererKatexVersion = rehypeRequire('katex/package.json').version;

test('KaTeX CSS and renderer versions match', () => {
  expect(appKatexVersion, 'katex CSS and rehype-katex renderer versions must match').toBe(
    rendererKatexVersion,
  );
});
