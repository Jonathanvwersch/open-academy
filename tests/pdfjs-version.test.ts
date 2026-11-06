import { createRequire } from 'node:module';
import { expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const reactPdfRequire = createRequire(require.resolve('react-pdf/package.json'));

test('pdfjs-dist version matches the one used by react-pdf', () => {
  expect(require('pdfjs-dist/package.json').version).toBe(
    reactPdfRequire('pdfjs-dist/package.json').version,
  );
});
