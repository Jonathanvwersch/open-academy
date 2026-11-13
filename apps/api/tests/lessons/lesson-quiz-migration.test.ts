import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

const migration = readFileSync(
  new URL('../../drizzle/0009_even_ozymandias.sql', import.meta.url),
  'utf8',
);

test('lesson quiz migration grandfathers completed runs and reopens legacy retries', () => {
  expect(migration).toContain(
    `UPDATE "lesson_runs" SET "quiz_passed_at" = "completed_at" WHERE "status" = 'completed';`,
  );
  expect(migration).toContain(
    `UPDATE "lesson_runs" SET "status" = 'in_progress' WHERE "status" = 'needs_retry';`,
  );
  expect(migration).toContain(`CHECK ("score" IS NULL OR ("score" >= 0 AND "score" <= 1))`);
});
