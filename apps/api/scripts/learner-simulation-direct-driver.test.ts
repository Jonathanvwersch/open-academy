import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';
import { loadContent } from '../src/content/load.js';
import { directMemoryDriver } from './learner-simulation-direct-driver.js';
import { type SimulationProfile, simulateLearners } from './learner-simulator.js';

function stripWallClockFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripWallClockFields);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key]) =>
          !['generatedAt', 'duration', 'durationMs', 'elapsedMs', 'runtimeMs'].includes(key),
      )
      .map(([key, entry]) => [key, stripWallClockFields(entry)]),
  );
}

test('two direct 15-day runs from the same seed produce byte-identical reports', async () => {
  const content = await loadContent();
  const options = {
    profiles: ['average', 'struggling'] as SimulationProfile[],
    days: 15,
    courseIds: ['maths-for-ml'],
  };
  const first = await simulateLearners(directMemoryDriver, content, options);
  const second = await simulateLearners(directMemoryDriver, content, options);

  for (const profile of first.profiles) {
    expect(
      Object.entries(profile.violationCounts).filter(([, count]) => count > 0),
      JSON.stringify(profile.violations.map(({ invariant, details }) => ({ invariant, details }))),
    ).toEqual([]);
    expect(profile.p28.successfulReviewsChecked).toBeGreaterThan(0);
  }
  expect(first.profiles.some((profile) => profile.p28.topicsBelowOne > 0)).toBe(true);
  expect(first.profiles.some((profile) => profile.p28.topicsAboveOne > 0)).toBe(true);
  expect(first.profiles.some((profile) => profile.p28.slowTargetsGated > 0)).toBe(true);
  expect(JSON.stringify(stripWallClockFields(second))).toBe(
    JSON.stringify(stripWallClockFields(first)),
  );
}, 120_000);

test('direct simulator modules do not load the app, the database or its config', async () => {
  const forbidden =
    /^(?:hono|drizzle-orm|postgres|pg)(?:\/|$)|\/src\/(?:app|config|db|http|features)\b|learner-simulation-http-driver/;
  const visited = new Set<string>();
  const reached: string[] = [];
  const visit = async (file: URL) => {
    if (visited.has(file.href)) return;
    visited.add(file.href);
    const source = await readFile(file, 'utf8');
    const specifiers = [
      ...source.matchAll(/^(?:import|export)\s+(?!type\s)(?:[^;]*?\sfrom\s+)?'([^']+)'/gms),
      ...source.matchAll(/\bimport\(\s*'([^']+)'\s*\)/g),
    ].map((match) => match[1] ?? '');
    for (const specifier of specifiers) {
      if (forbidden.test(specifier)) reached.push(`${file.pathname} -> ${specifier}`);
      if (specifier.startsWith('.')) {
        await visit(new URL(specifier.replace(/\.js$/, '.ts'), file));
      }
    }
  };
  await visit(new URL('learner-simulation-direct-driver.ts', import.meta.url));
  await visit(new URL('learner-simulator.ts', import.meta.url));
  expect(visited.size).toBeGreaterThan(5);
  expect(reached).toEqual([]);
});

test('the simulator CLI runs in direct mode by default without database config', async () => {
  const out = await mkdtemp(join(tmpdir(), 'simulate-direct-'));
  try {
    await promisify(execFile)(
      process.execPath,
      [
        '--import',
        'tsx',
        'scripts/simulate-learners.ts',
        '--days',
        '1',
        '--profiles',
        'average',
        '--out',
        out,
      ],
      {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        env: { ...process.env, DATABASE_URL: 'invalid', TEST_DATABASE_URL: 'invalid' },
      },
    );
    const report = JSON.parse(await readFile(join(out, 'report.json'), 'utf8'));
    expect(report.profiles.map((profile: { profile: string }) => profile.profile)).toEqual([
      'average',
    ]);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
}, 60_000);

test('direct scripted scenarios and the timed quiz scenario pass every invariant', async () => {
  const content = await loadContent();
  const scenarioContent = await loadContent('tests/fixtures/content');
  const report = await simulateLearners(directMemoryDriver, content, {
    profiles: [
      'scenario-p14-fallback',
      'scenario-p17-fallback',
      'scenario-p17-covering',
      'scenario-quizzes',
    ],
    days: 2,
    timeZone: 'UTC',
    scenarioContent,
  });
  expect(report.profiles).toHaveLength(4);
  for (const profile of report.profiles) {
    expect(
      Object.entries(profile.violationCounts).filter(([, count]) => count > 0),
      `${profile.profile}: ${JSON.stringify(profile.violations.map(({ invariant, details }) => ({ invariant, details })))}`,
    ).toEqual([]);
  }
  const quizzes = report.profiles.find((profile) => profile.profile === 'scenario-quizzes');
  expect(quizzes?.checkedCounts.P25).toBeGreaterThanOrEqual(2);
  expect(quizzes?.checkedCounts.P27).toBeGreaterThanOrEqual(2);
}, 120_000);
