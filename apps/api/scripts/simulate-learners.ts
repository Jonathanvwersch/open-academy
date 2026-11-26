import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { env } from '../src/config.js';
import { loadContent } from '../src/content/load.js';
import { createDb } from '../src/db/client.js';
import { httpPostgresDriver } from './learner-simulation-http-driver.js';
import {
  renderMarkdownReport,
  type SimulationProfile,
  scriptedScenarioProfiles,
  simulateLearners,
  simulationProfiles,
} from './learner-simulator.js';

function argumentsMap(argv: string[]): Map<string, string> {
  const args = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument || argument === '--') continue;
    if (!argument.startsWith('--')) continue;
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for ${argument}`);
    }
    args.set(argument.slice(2), value);
    index += 1;
  }
  return args;
}

function parseProfiles(value: string | undefined): SimulationProfile[] {
  if (!value || value === 'all') return [...simulationProfiles];
  const requested = value.split(',').map((profile) => profile.trim());
  const invalid = requested.filter(
    (profile) => !simulationProfiles.includes(profile as SimulationProfile),
  );
  if (invalid.length > 0) {
    throw new Error(`Unknown profile(s): ${invalid.join(', ')}`);
  }
  return requested as SimulationProfile[];
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Expected a positive integer, got ${value}`);
  }
  return parsed;
}

async function main() {
  const args = argumentsMap(process.argv.slice(2));
  const days = parsePositiveInteger(args.get('days'), 400);
  const profiles = parseProfiles(args.get('profiles'));
  const out = resolve(args.get('out') ?? 'simulation-output');
  const courseIds = args
    .get('courses')
    ?.split(',')
    .map((courseId) => courseId.trim());
  const db = createDb(env.TEST_DATABASE_URL);
  try {
    const content = await loadContent();
    const scenarioContent = profiles.some((profile) =>
      scriptedScenarioProfiles.includes(profile as (typeof scriptedScenarioProfiles)[number]),
    )
      ? await loadContent('tests/fixtures/content')
      : undefined;
    const report = await simulateLearners(httpPostgresDriver(db), content, {
      profiles,
      days,
      ...(courseIds ? { courseIds } : {}),
      ...(scenarioContent ? { scenarioContent } : {}),
      onProgress: (message) => {
        const match = message.match(/day (\d+)\/(\d+)/);
        if (!match || Number(match[1]) === 1 || Number(match[1]) % 10 === 0) {
          console.log(message);
        }
      },
    });
    await mkdir(out, { recursive: true });
    await Promise.all([
      writeFile(resolve(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`),
      writeFile(resolve(out, 'report.md'), renderMarkdownReport(report)),
    ]);
    console.log(`Wrote ${resolve(out, 'report.json')}`);
    console.log(`Wrote ${resolve(out, 'report.md')}`);
    console.log(`Simulation runtime: ${(report.runtimeMs / 1_000).toFixed(1)}s`);
  } finally {
    await db.$client.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
