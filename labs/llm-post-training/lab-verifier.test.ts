import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';
import { parse } from 'yaml';

type Results = {
  project: string;
  version: number;
  tests: Array<{ id: string; passed: boolean; message: string }>;
  metrics: Record<string, number>;
  generated_at: string;
};

const root = resolve('labs/llm-post-training');
const project = parse(readFileSync('labs/llm-post-training/project.yaml', 'utf8')) as {
  tests: Array<{ id: string }>;
  metrics: Array<{ id: string; threshold: number; direction: 'above' | 'below' }>;
};

function verify(implementation: string, assert: (result: Results, status: number | null) => void) {
  const directory = mkdtempSync(join(tmpdir(), 'academy-post-training-'));
  try {
    const output = join(directory, 'results.json');
    const process = spawnSync(
      'python3',
      [
        resolve('labs/verify.py'),
        'llm-post-training',
        '--implementation',
        implementation,
        '--output',
        output,
      ],
      { encoding: 'utf8', timeout: 20_000 },
    );
    expect(process.error).toBeUndefined();
    const result = JSON.parse(readFileSync(output, 'utf8')) as Results;
    expect(result.project).toBe('llm-post-training');
    expect(result.version).toBe(1);
    expect(Number.isNaN(Date.parse(result.generated_at))).toBe(false);
    expect(result.tests.map(({ id }) => id).sort()).toEqual(
      project.tests.map(({ id }) => id).sort(),
    );
    expect(
      Object.keys(result.metrics).every((id) => project.metrics.some((metric) => metric.id === id)),
    ).toBe(true);
    assert(result, process.status);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('tiny post-training reference passes every declared check and metric', () => {
  verify(join(root, '_solution/post_training.py'), (result, status) => {
    expect(status).toBe(0);
    expect(result.tests).toHaveLength(10);
    expect(result.tests.every(({ passed }) => passed)).toBe(true);
    expect(Object.keys(result.metrics).sort()).toEqual(project.metrics.map(({ id }) => id).sort());
    for (const metric of project.metrics) {
      const actual = result.metrics[metric.id];
      expect(Number.isFinite(actual)).toBe(true);
      if (metric.direction === 'above') expect(actual).toBeGreaterThan(metric.threshold);
      else expect(actual).toBeLessThan(metric.threshold);
    }
  });
});

test('untouched post-training starter fails with actionable TODO messages', () => {
  verify(join(root, 'starter/post_training.py'), (result, status) => {
    expect(status).toBe(1);
    expect(result.tests.every(({ passed }) => !passed)).toBe(true);
    expect(result.tests.every(({ message }) => message.includes('TODO:'))).toBe(true);
    expect(result.metrics).toEqual({});
  });
});

test('checker catches averaging masked losses over prompt positions', () => {
  verify(join(root, '_solution/buggy.py'), (result, status) => {
    expect(status).toBe(1);
    const failed = result.tests.filter(({ passed }) => !passed);
    expect(failed.map(({ id }) => id)).toEqual([
      'test_masked_loss_and_gradient',
      'test_sft_step_and_frozen_base',
    ]);
    expect(failed[0].message).toContain('Divide by mask.sum()');
  });
});

test('a broken implementation still writes failures accepted by the project schema', () => {
  const directory = mkdtempSync(join(tmpdir(), 'academy-post-training-syntax-'));
  try {
    const broken = join(directory, 'broken.py');
    writeFileSync(broken, 'def broken(:\n');
    verify(broken, (result, status) => {
      expect(status).toBe(1);
      expect(
        result.tests.every(({ passed, message }) => !passed && message.includes('SyntaxError')),
      ).toBe(true);
      expect(result.metrics).toEqual({});
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
