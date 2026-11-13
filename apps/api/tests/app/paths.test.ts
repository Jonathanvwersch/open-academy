import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { findRepositoryRoot } from '../../src/paths.js';

test('locates curriculum from nested source, compiled, and flattened serverless locations', () => {
  const directory = mkdtempSync(join(tmpdir(), 'academy-layout-'));
  try {
    mkdirSync(join(directory, 'content'));
    writeFileSync(join(directory, 'content/curriculum.yaml'), 'weeks: []');
    for (const entry of ['apps/api/src', 'apps/api/dist', '.']) {
      expect(findRepositoryRoot(join(directory, entry))).toBe(directory);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('does not mistake an unrelated directory for an Academy deployment', () => {
  const directory = mkdtempSync(join(tmpdir(), 'academy-unrelated-'));
  try {
    expect(findRepositoryRoot(directory)).toBeUndefined();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
