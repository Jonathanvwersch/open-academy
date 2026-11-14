import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';

const verifier = resolve('labs/linreg-numpy/verify.py');
const solution = resolve('labs/linreg-numpy/_solution/linreg.py');
const buggy = resolve('labs/linreg-numpy/_solution/buggy.py');
const nnVerifier = resolve('labs/verify.py');
const nnSolution = resolve('labs/nn-from-scratch/_solution/nn.py');

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

test('linear regression verifier rejects validation examples leaked from training', () => {
  const directory = mkdtempSync(join(tmpdir(), 'academy-lab-leak-'));
  try {
    const implementation = join(directory, 'leaky.py');
    writeFileSync(
      implementation,
      `import runpy\nglobals().update(runpy.run_path(${JSON.stringify(solution)}))\ndef train_val_split(X, y, val_frac=0.2, seed=42):\n    split = int(len(y) * (1 - val_frac))\n    return X[:split], X[:len(y)-split], y[:split], y[:len(y)-split]\n`,
    );
    const output = join(directory, 'results.json');
    expect(() =>
      execFileSync('python3', [verifier, '--implementation', implementation, '--output', output]),
    ).toThrow();
    const result = JSON.parse(readFileSync(output, 'utf8')) as {
      tests: Array<{ id: string; passed: boolean }>;
    };
    expect(
      result.tests.find((check) => check.id === 'test_split_is_disjoint_and_seeded')?.passed,
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
