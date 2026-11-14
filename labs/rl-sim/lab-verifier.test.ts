import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';
import { parse } from 'yaml';

const root = resolve('labs/rl-sim');
const project = parse(readFileSync('content/projects/rl-sim.yaml', 'utf8')) as {
  tests: Array<{ id: string }>;
  metrics: Array<{ id: string; threshold: number; direction: 'above' | 'below' }>;
};
const ids = [
  'collect-episode',
  'returns-to-go',
  'policy-probabilities',
  'policy-gradient',
  'reinforce-update',
  'ppo-objective',
  'ppo-gradient',
  'reinforce-evaluation',
  'ppo-evaluation',
  'ppo-ratio-clip',
];

type Results = {
  project: string;
  version: number;
  tests: Array<{ id: string; passed: boolean; message: string }>;
  metrics: Record<string, number>;
};

test('failure ids exactly match the project declarations', () => {
  const script = [
    'import json, runpy, sys',
    'module = runpy.run_path(sys.argv[1])',
    'print(json.dumps(module["FAILURE_TEST_IDS"]))',
  ].join('; ');
  const failureIds = JSON.parse(
    execFileSync('python3', ['-c', script, join(root, 'verify.py')], { encoding: 'utf8' }),
  ) as string[];
  expect([...failureIds].sort()).toEqual(project.tests.map(({ id }) => id).sort());
  expect([...ids].sort()).toEqual([...failureIds].sort());
});

test.each([
  ['reference', '_solution/policy.py', []],
  ['starter', 'starter/policy.py', ids],
  ['unclipped', '_solution/buggy.py', ['ppo-objective', 'ppo-ratio-clip']],
  ['undiscounted', '_solution/buggy_no_discount.py', ['returns-to-go']],
] as const)('%s produces diagnostic evidence', (_name, implementation, failures) => {
  const directory = mkdtempSync(join(tmpdir(), 'academy-rl-'));
  try {
    const output = join(directory, 'results.json');
    const process = spawnSync(
      'python3',
      [
        resolve('labs/verify.py'),
        'rl-sim',
        '--implementation',
        join(root, implementation),
        '--output',
        output,
      ],
      { encoding: 'utf8', timeout: 30_000 },
    );
    expect(process.error).toBeUndefined();
    expect(process.status, process.stdout + process.stderr).toBe(failures.length ? 1 : 0);
    const result = JSON.parse(readFileSync(output, 'utf8')) as Results;
    expect(
      Object.keys(result.metrics).every((id) => project.metrics.some((metric) => metric.id === id)),
    ).toBe(true);
    expect(result.project).toBe('rl-sim');
    expect(result.version).toBe(1);
    expect(result.tests.map(({ id }) => id)).toEqual(ids);
    expect(result.tests.filter(({ passed }) => !passed).map(({ id }) => id)).toEqual(failures);
    if (_name === 'starter') {
      expect(result.tests.every(({ message }) => message.includes('TODO:'))).toBe(true);
      expect(result.metrics).toEqual({});
    } else {
      expect(result.metrics['reinforce-return']).toBeGreaterThan(0.5);
      expect(result.metrics['ppo-return']).toBeGreaterThan(0.5);
    }
    if (_name === 'reference') {
      expect(Object.keys(result.metrics).sort()).toEqual(
        project.metrics.map(({ id }) => id).sort(),
      );
      for (const metric of project.metrics) {
        const actual = result.metrics[metric.id];
        expect(Number.isFinite(actual)).toBe(true);
        if (metric.direction === 'above') expect(actual).toBeGreaterThan(metric.threshold);
        else expect(actual).toBeLessThan(metric.threshold);
      }
    }
    if (_name === 'unclipped') {
      expect(result.metrics['ppo-probe-ratio']).toBeGreaterThan(3);
      expect(result.tests.at(-1)?.message).toContain('zero the clipped gradient');
    }
    if (_name === 'undiscounted') {
      expect(result.tests.find(({ id }) => id === 'returns-to-go')?.message).toContain(
        'Did you forget to discount?',
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('load failure emits every public id and setup preserves existing work', () => {
  const directory = mkdtempSync(join(tmpdir(), 'academy-rl-load-'));
  try {
    const broken = join(directory, 'broken.py');
    const output = join(directory, 'results.json');
    writeFileSync(broken, 'def broken(:\n');
    const process = spawnSync(
      'python3',
      [join(root, 'verify.py'), '--implementation', broken, '--output', output],
      { encoding: 'utf8' },
    );
    expect(process.status).toBe(1);
    const result = JSON.parse(readFileSync(output, 'utf8')) as Results;
    expect(result.tests.map(({ id }) => id)).toEqual(ids);
    expect(
      result.tests.every(({ passed, message }) => !passed && message.includes('SyntaxError')),
    ).toBe(true);
    expect(result.metrics).toEqual({});

    const script = [
      'import pathlib, sys',
      'root = pathlib.Path(sys.argv[1])',
      'setup = pathlib.Path(sys.argv[2]).read_text()',
      '(root / "starter").mkdir()',
      '(root / "starter" / "policy.py").write_text("starter")',
      'exec(compile(setup, "<setup>", "exec"), {"__file__": str(root / "setup.py")})',
    ];
    execFileSync('python3', ['-c', script.join('; '), directory, join(root, 'setup.py')]);
    expect(readFileSync(join(directory, 'work/policy.py'), 'utf8')).toBe('starter');
    writeFileSync(join(directory, 'work/policy.py'), 'learner work');
    execFileSync('python3', [
      '-c',
      'import pathlib,sys; exec(compile(pathlib.Path(sys.argv[2]).read_text(), "<setup>", "exec"), {"__file__": sys.argv[1]})',
      join(directory, 'setup.py'),
      join(root, 'setup.py'),
    ]);
    expect(readFileSync(join(directory, 'work/policy.py'), 'utf8')).toBe('learner work');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
