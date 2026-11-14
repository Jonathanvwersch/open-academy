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
  { implementation: '_solution/gradient_check.py', passed: true, failed: [] },
  {
    implementation: 'starter/gradient_check.py',
    passed: false,
    failed: ['test_derivative', 'test_partial_derivatives', 'test_edge_cases'],
  },
  {
    implementation: '_solution/buggy.py',
    passed: false,
    failed: ['test_analytic_chain_rule', 'test_gradient_checker'],
  },
])('gradient checker verifier checks $implementation', ({ implementation, passed, failed }) => {
  const directory = mkdtempSync(join(tmpdir(), 'academy-lab-gradient-'));
  try {
    const output = join(directory, 'results.json');
    const run = () =>
      execFileSync(
        'python3',
        [
          nnVerifier,
          'gradient-check',
          '--implementation',
          resolve('labs/gradient-check', implementation),
          '--output',
          output,
        ],
        { encoding: 'utf8' },
      );
    if (passed) run();
    else expect(run).toThrow();
    const result = JSON.parse(readFileSync(output, 'utf8')) as {
      project: string;
      tests: Array<{ id: string; passed: boolean; message: string }>;
      metrics: { max_relative_error?: number; final_height?: number };
    };
    expect(result.project).toBe('gradient-check');
    expect(result.tests).toHaveLength(7);
    expect(result.tests.every((check) => check.passed)).toBe(passed);
    for (const id of failed) {
      expect(result.tests.find((check) => check.id === id)?.passed).toBe(false);
    }
    if (passed) {
      expect(result.metrics.max_relative_error).toBeLessThan(1e-5);
      expect(result.metrics.final_height).toBeLessThan(1e-8);
    }
    if (implementation.endsWith('buggy.py')) {
      expect(result.tests.filter((check) => !check.passed).map((check) => check.id)).toEqual(
        failed,
      );
      expect(result.tests.find((check) => check.id === failed[0])?.message).toContain('factor 2');
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
