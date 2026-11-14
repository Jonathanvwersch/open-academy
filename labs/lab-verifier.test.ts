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

const gaussianSolution = resolve('labs/gaussian-mle/_solution/gaussian.py');
const gaussianStarter = resolve('labs/gaussian-mle/starter/gaussian.py');
const gaussianBuggy = resolve('labs/gaussian-mle/_solution/buggy.py');

type VerifierResults = {
  tests: Array<{ id: string; passed: boolean; message: string }>;
  metrics: Record<string, number>;
};

function runGaussianVerifier(implementation: string, expectPass: boolean): VerifierResults {
  const directory = mkdtempSync(join(tmpdir(), 'academy-lab-gaussian-'));
  try {
    const output = join(directory, 'results.json');
    const run = () =>
      execFileSync(
        'python3',
        [nnVerifier, 'gaussian-mle', '--implementation', implementation, '--output', output],
        { encoding: 'utf8' },
      );
    if (expectPass) run();
    else expect(run).toThrow();
    return JSON.parse(readFileSync(output, 'utf8')) as VerifierResults;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('reference Gaussian fitting solution passes every check and metric', () => {
  const result = runGaussianVerifier(gaussianSolution, true);
  expect(result.tests).toHaveLength(11);
  expect(result.tests.every((check) => check.passed)).toBe(true);
  expect(result.metrics.mean_error).toBeLessThan(0.5);
  expect(result.metrics.sigma_error).toBeLessThan(0.3);
  expect(result.metrics.held_out_log_likelihood).toBeGreaterThan(-2.25);
});

test('untouched Gaussian starter fails every check', () => {
  const result = runGaussianVerifier(gaussianStarter, false);
  expect(result.tests).toHaveLength(11);
  expect(result.tests.some((check) => check.passed)).toBe(false);
});

test('Gaussian verifier catches a log density without its front factor', () => {
  const result = runGaussianVerifier(gaussianBuggy, false);
  const failed = result.tests.filter((check) => !check.passed).map((check) => check.id);
  expect(failed).toEqual([
    'test_log_density_matches_formula',
    'test_sigma_search_agrees_with_fit',
    'test_fit_beats_worse_fits_on_held_out',
  ]);
  expect(
    result.tests.find((check) => check.id === 'test_log_density_matches_formula')?.message,
  ).toContain('front factor');
});
