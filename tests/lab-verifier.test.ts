import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';

const verifier = resolve('labs/linreg-numpy/verify.py');
const solution = resolve('labs/linreg-numpy/_solution/linreg.py');
const buggy = resolve('labs/linreg-numpy/_solution/buggy.py');

test('reference linear regression solution passes deterministic verifier checks', () => {
  const directory = mkdtempSync(join(tmpdir(), 'academy-lab-'));
  try {
    const output = join(directory, 'results.json');
    execFileSync('python3', [verifier, '--implementation', solution, '--output', output], {
      encoding: 'utf8',
    });
    const result = JSON.parse(readFileSync(output, 'utf8')) as {
      tests: Array<{ id: string; passed: boolean }>;
      metrics: { val_mse: number; weight_error: number };
    };
    expect(result.tests.every((check) => check.passed)).toBe(true);
    expect(result.tests.find((check) => check.id === 'test_lr_0_1_converges')?.passed).toBe(true);
    expect(result.tests.find((check) => check.id === 'test_lr_1_diverges')?.passed).toBe(true);
    expect(result.metrics.val_mse).toBeLessThan(0.3);
    expect(result.metrics.weight_error).toBeLessThan(0.1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('verifier rejects an implementation missing the 2/n gradient factor', () => {
  const directory = mkdtempSync(join(tmpdir(), 'academy-lab-bug-'));
  try {
    const output = join(directory, 'results.json');
    expect(() =>
      execFileSync('python3', [verifier, '--implementation', buggy, '--output', output], {
        encoding: 'utf8',
      }),
    ).toThrow();
    const result = JSON.parse(readFileSync(output, 'utf8')) as {
      tests: Array<{ id: string; passed: boolean }>;
    };
    expect(
      result.tests.find((check) => check.id === 'test_gradients_match_finite_differences')?.passed,
    ).toBe(false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
