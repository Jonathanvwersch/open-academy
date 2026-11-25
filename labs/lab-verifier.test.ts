import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';
import { parse } from 'yaml';

const verifier = resolve('labs/linreg-numpy/verify.py');
const solution = resolve('labs/linreg-numpy/_solution/linreg.py');
const buggy = resolve('labs/linreg-numpy/_solution/buggy.py');
const nnVerifier = resolve('labs/verify.py');
const nnSolution = resolve('labs/nn-from-scratch/_solution/nn.py');

const failureCases = [
  { project: 'gaussian-mle', verifier: resolve('labs/gaussian-mle/verify.py') },
  { project: 'classifier-numpy', verifier: resolve('labs/classifier-numpy/verify.py') },
  { project: 'nn-from-scratch', verifier: resolve('labs/nn-from-scratch/verify.py') },
  { project: 'pca-numpy', verifier: resolve('labs/pca-numpy/verify.py') },
  { project: 'gradient-check', verifier: resolve('labs/gradient-check/verify.py') },
  { project: 'linreg-numpy', verifier: resolve('labs/linreg-numpy/verify.py') },
] as const;

const verifierIdsScript = [
  'import importlib.util, json, sys',
  'spec = importlib.util.spec_from_file_location("lab_verifier", sys.argv[1])',
  'module = importlib.util.module_from_spec(spec)',
  'spec.loader.exec_module(module)',
  'print(json.dumps(module.FAILURE_TEST_IDS))',
].join('; ');

test.each(failureCases)(
  '$project verifier reports declared failures when implementation has a syntax error',
  ({ project, verifier }) => {
    const projectYaml = parse(readFileSync(`content/projects/${project}.yaml`, 'utf8')) as {
      tests: Array<{ id: string }>;
    };
    const declaredIds = projectYaml.tests.map(({ id }) => id);
    const failureIds = JSON.parse(
      execFileSync('python3', ['-c', verifierIdsScript, verifier], { encoding: 'utf8' }),
    ) as string[];
    expect(failureIds.sort()).toEqual([...declaredIds].sort());

    const directory = mkdtempSync(join(tmpdir(), 'academy-lab-load-failure-'));
    try {
      const broken = join(directory, 'broken.py');
      const output = join(directory, 'results.json');
      writeFileSync(broken, 'def broken(:\n');
      const process = spawnSync(
        'python3',
        [verifier, '--implementation', broken, '--output', output],
        { encoding: 'utf8' },
      );
      expect(process.error).toBeUndefined();
      expect(process.status, process.stdout + process.stderr).toBe(1);

      const result = JSON.parse(readFileSync(output, 'utf8')) as {
        tests: Array<{ id: string; passed: boolean; message: string }>;
        metrics: Record<string, number>;
      };
      const resultIds = result.tests.map(({ id }) => id);
      expect(resultIds.sort()).toEqual([...declaredIds].sort());
      expect(new Set(resultIds).size).toBe(resultIds.length);
      expect(resultIds.every((id) => declaredIds.includes(id))).toBe(true);
      expect(
        result.tests.every(({ passed, message }) => !passed && message.includes('SyntaxError')),
      ).toBe(true);
      expect(result.metrics).toEqual({});
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

// PyTorch labs are skipped where torch isn't installed (see each lab's requirements.txt).
const hasTorch = spawnSync('python3', ['-c', 'import torch']).status === 0;

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

test.each([
  { implementation: '_solution/classifier.py', passed: true, failures: [] },
  {
    implementation: 'starter/classifier.py',
    passed: false,
    failures: ['test_sigmoid', 'test_precision_recall'],
  },
  { implementation: '_solution/buggy.py', passed: false, failures: ['test_precision_recall'] },
])('classifier verifier checks $implementation', ({ implementation, passed, failures }) => {
  const directory = mkdtempSync(join(tmpdir(), 'academy-lab-classifier-'));
  try {
    const output = join(directory, 'results.json');
    const run = () =>
      execFileSync(
        'python3',
        [
          nnVerifier,
          'classifier-numpy',
          '--implementation',
          resolve('labs/classifier-numpy', implementation),
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
      metrics: { binary_accuracy: number; multiclass_accuracy: number };
    };
    expect(result.project).toBe('classifier-numpy');
    expect(result.tests).toHaveLength(9);
    expect(result.tests.every((check) => check.passed)).toBe(passed);
    for (const id of failures) {
      expect(result.tests.find((check) => check.id === id)?.passed).toBe(false);
    }
    if (implementation === '_solution/buggy.py') {
      expect(result.tests.filter((check) => !check.passed).map((check) => check.id)).toEqual(
        failures,
      );
      expect(result.tests.find((check) => check.id === 'test_precision_recall')?.message).toContain(
        'Precision uses column totals',
      );
    }
    if (passed) {
      expect(result.metrics.binary_accuracy).toBeGreaterThan(0.85);
      expect(result.metrics.binary_accuracy).toBeLessThanOrEqual(0.92);
      expect(result.metrics.multiclass_accuracy).toBeGreaterThan(0.83);
      expect(result.metrics.multiclass_accuracy).toBeGreaterThanOrEqual(0.85);
      expect(result.metrics.multiclass_accuracy).toBeLessThanOrEqual(0.92);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test.skipIf(!hasTorch).each([
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
