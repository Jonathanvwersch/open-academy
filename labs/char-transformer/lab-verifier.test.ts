import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';

for (const variant of ['solution', 'starter', 'buggy'] as const) {
  test(`character transformer verifier: ${variant}`, () => {
    const directory = mkdtempSync(join(tmpdir(), 'academy-char-'));
    try {
      const implementation =
        variant === 'starter'
          ? 'starter/model.py'
          : `_solution/${variant === 'buggy' ? 'buggy' : 'model'}.py`;
      const output = join(directory, 'results.json');
      const process = spawnSync(
        'python3',
        [
          'labs/verify.py',
          'char-transformer',
          '--implementation',
          resolve('labs/char-transformer', implementation),
          '--output',
          output,
        ],
        { encoding: 'utf8' },
      );
      const result = JSON.parse(readFileSync(output, 'utf8')) as {
        project: string;
        tests: Array<{ id: string; passed: boolean; message: string }>;
        metrics: { final_loss?: number; loss_ratio?: number };
      };
      expect(result.project).toBe('char-transformer');
      expect(result.tests).toHaveLength(9);
      expect(process.status, process.stdout + process.stderr).toBe(variant === 'solution' ? 0 : 1);
      if (variant === 'solution') {
        expect(result.tests.every((check) => check.passed)).toBe(true);
        expect(result.metrics.final_loss).toBeLessThan(2.1);
        expect(result.metrics.loss_ratio).toBeLessThan(0.7);
      } else if (variant === 'starter') {
        expect(result.tests.every((check) => !check.passed)).toBe(true);
      } else {
        const mask = result.tests.find((check) => check.id === 'test_causal_mask');
        expect(mask?.passed).toBe(false);
        expect(mask?.message).toContain('Future weights must be exactly zero');
        expect(result.tests.find((check) => check.id === 'test_decoder_shapes')?.passed).toBe(
          false,
        );
        expect(result.tests.find((check) => check.id === 'test_head_split_merge')?.passed).toBe(
          true,
        );
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
}
