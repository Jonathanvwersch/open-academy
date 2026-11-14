import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';

const verifier = resolve('labs/linreg-numpy/verify.py');
const solution = resolve('labs/linreg-numpy/_solution/linreg.py');
const buggy = resolve('labs/linreg-numpy/_solution/buggy.py');
const nnVerifier = resolve('labs/verify.py');
const nnSolution = resolve('labs/nn-from-scratch/_solution/nn.py');

test.each([
  ['reference', '_solution/pca.py', true, 9],
  ['starter', 'starter/pca.py', false, 0],
  ['uncentred', '_solution/buggy.py', false, 7],
] as const)('PCA %s produces the expected evidence', (_name, implementation, passes, count) => {
  const directory = mkdtempSync(join(tmpdir(), 'academy-lab-pca-'));
  try {
    const output = join(directory, 'results.json');
    const run = () =>
      execFileSync(
        'python3',
        [
          nnVerifier,
          'pca-numpy',
          '--implementation',
          resolve('labs/pca-numpy', implementation),
          '--output',
          output,
        ],
        { encoding: 'utf8' },
      );
    if (passes) run();
    else expect(run).toThrow();
    const result = JSON.parse(readFileSync(output, 'utf8')) as {
      project: string;
      tests: Array<{ id: string; passed: boolean; message: string }>;
      metrics: { reconstruction_error_k3?: number; explained_variance_k3?: number };
    };
    expect(result.project).toBe('pca-numpy');
    expect(result.tests).toHaveLength(9);
    expect(result.tests.filter((check) => check.passed)).toHaveLength(count);
    expect(result.tests.find((check) => check.id === 'test_centre')?.passed).toBe(passes);
    if (passes) {
      expect(result.metrics.reconstruction_error_k3).toBeLessThan(0.0002);
      expect(result.metrics.explained_variance_k3).toBeGreaterThan(0.98);
      expect(result.tests.find((check) => check.id === 'test_svd_sign_invariant')?.passed).toBe(
        true,
      );
    } else {
      expect(result.tests.find((check) => check.id === 'test_centre')?.message).toContain(
        'Subtract column means',
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

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

test('reference two-layer neural network solution passes deterministic verifier checks', () => {
  const directory = mkdtempSync(join(tmpdir(), 'academy-lab-nn-'));
  try {
    const output = join(directory, 'results.json');
    execFileSync(
      'python3',
      [nnVerifier, 'nn-from-scratch', '--implementation', nnSolution, '--output', output],
      { encoding: 'utf8' },
    );
    const result = JSON.parse(readFileSync(output, 'utf8')) as {
      tests: Array<{ id: string; passed: boolean }>;
      metrics: {
        final_train_loss: number;
        validation_accuracy: number;
        max_gradient_check_relative_error: number;
      };
    };
    expect(result.tests).toHaveLength(8);
    expect(result.tests.every((check) => check.passed)).toBe(true);
    expect(
      result.tests.find((check) => check.id === 'test_gradients_match_numerical_differences')
        ?.passed,
    ).toBe(true);
    expect(result.metrics.final_train_loss).toBeLessThan(0.1);
    expect(result.metrics.validation_accuracy).toBeGreaterThanOrEqual(0.9);
    expect(result.metrics.max_gradient_check_relative_error).toBeLessThan(1e-5);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
