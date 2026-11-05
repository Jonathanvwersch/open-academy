import { expect, test } from 'vitest';
import { sanitizePageContent } from '../src/server/tutor/page-context.js';

test('page content truncation leaves the required suffix within the size bound', () => {
  const content = sanitizePageContent('x'.repeat(12_001));

  expect(content.endsWith('\n…[truncated]')).toBe(true);
  expect(content.length).toBeLessThanOrEqual(12_000 + '\n…[truncated]'.length);
});
