import { readFile } from 'node:fs/promises';
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
  const modules = [
    'learner-simulator.ts',
    'learner-simulation-audit.ts',
    'learner-simulation-driver.ts',
    'learner-simulation-placement.ts',
    'learner-simulation-support.ts',
    'learner-simulation-direct-driver.ts',
    'learner-simulation-direct-lessons.ts',
    'learner-simulation-direct-ops.ts',
    'learner-simulation-direct-repo.ts',
  ];
  const forbidden =
    /^(?:hono|drizzle-orm|postgres|pg)(?:\/|$)|\/src\/(?:app|config|db|http|features)\b|learner-simulation-http-driver/;
  for (const module of modules) {
    const source = await readFile(new URL(module, import.meta.url), 'utf8');
    const runtimeImports = [
      ...source.matchAll(/^import\s+(?!type\s)[^;]*?from\s+'([^']+)'/gms),
    ].map((match) => match[1] ?? '');
    expect(
      runtimeImports.filter((specifier) => forbidden.test(specifier)),
      module,
    ).toEqual([]);
  }
});

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
