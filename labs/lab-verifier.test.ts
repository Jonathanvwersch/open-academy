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
  ['reference', '_solution/classifier.py', true],
  ['starter', 'starter/classifier.py', false],
  ['buggy evaluation', '_solution/buggy.py', false],
] as const)(
  'image classifier %s has the expected verifier result',
  (_name, file, passes) => {
    const directory = mkdtempSync(join(tmpdir(), 'academy-lab-image-'));
    try {
      const output = join(directory, 'results.json');
      const run = () =>
        execFileSync(
          'python3',
          [
            nnVerifier,
            'image-classifier',
            '--implementation',
            resolve('labs/image-classifier', file),
            '--output',
            output,
          ],
          { encoding: 'utf8' },
        );
      if (passes) run();
      else expect(run).toThrow();
      const result = JSON.parse(readFileSync(output, 'utf8')) as {
        tests: Array<{ id: string; passed: boolean; message: string }>;
        metrics: {
          validation_accuracy: number;
          test_accuracy: number;
          test_loss: number;
          baseline_overfit_rise: number;
          overfit_rise_ratio: number;
        };
      };
      expect(result.tests).toHaveLength(7);
      expect(result.tests.every((check) => check.passed)).toBe(passes);
      if (passes) {
        expect(result.metrics.validation_accuracy).toBeGreaterThan(0.74);
        expect(result.metrics.test_accuracy).toBeGreaterThan(0.65);
        expect(result.metrics.test_loss).toBeLessThan(0.65);
        expect(result.metrics.baseline_overfit_rise).toBeGreaterThan(0.15);
        expect(result.metrics.overfit_rise_ratio).toBeLessThan(0.3);
      } else if (file.includes('buggy')) {
        const check = result.tests.find((check) => check.id === 'test_evaluation_mode');
        expect(check?.passed).toBe(false);
        expect(check?.message).toContain('Call model.eval() and use torch.no_grad()');
        expect(result.tests.filter((check) => !check.passed).map((check) => check.id)).toEqual([
          'test_evaluation_mode',
        ]);
      } else {
        expect(
          result.tests.find((check) => check.id === 'test_train_only_normalization')?.passed,
        ).toBe(false);
        expect(result.metrics).toEqual({});
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
  30_000,
);

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
