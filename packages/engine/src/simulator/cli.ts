import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadContentFromDirectory } from '../course/load.js';
import type { SimulatorDriverFactory } from './driver.js';
import { directMemoryDriver } from './memory-driver.js';
import {
  renderMarkdownReport,
  type SimulationProfile,
  scriptedScenarioProfiles,
  simulateLearners,
  simulationProfiles,
} from './simulator.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

function argumentsMap(argv: string[]): Map<string, string> {
  const args = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument || argument === '--' || !argument.startsWith('--')) continue;
    const equals = argument.indexOf('=');
    const key = argument.slice(2, equals < 0 ? undefined : equals);
    const inlineValue = equals < 0 ? undefined : argument.slice(equals + 1);
    const value = inlineValue ?? argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${argument}`);
    args.set(key, value);
    if (inlineValue === undefined) index += 1;
  }
  return args;
}

function parseProfiles(
  value: string | undefined,
  defaultProfiles: readonly SimulationProfile[],
): SimulationProfile[] {
  if (!value) return [...defaultProfiles];
  if (value === 'all') return [...defaultProfiles];
  const requested = value.split(',').map((profile) => profile.trim());
  const invalid = requested.filter(
    (profile) => !simulationProfiles.includes(profile as SimulationProfile),
  );
  if (invalid.length > 0) throw new Error(`Unknown profile(s): ${invalid.join(', ')}`);
  return requested as SimulationProfile[];
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1)
    throw new Error(`Expected a positive integer, got ${value}`);
  return parsed;
}

export async function runSimulateCli(
  argv: string[],
  options: {
    contentDir: string;
    drivers: Record<string, SimulatorDriverFactory>;
    scenarioContentDir?: string;
  },
): Promise<void> {
  const args = argumentsMap(argv);
  const requestedDriver = args.get('driver') ?? 'direct';
  const driver =
    options.drivers[requestedDriver] ??
    (requestedDriver === 'direct' ? directMemoryDriver : undefined);
  if (!driver) {
    const names = ['direct', ...Object.keys(options.drivers)];
    throw new Error(`Unknown driver ${requestedDriver}; expected ${names.join(' or ')}`);
  }
  const days = parsePositiveInteger(args.get('days'), 400);
  const scenarioContentDir =
    options.scenarioContentDir ?? resolve(repositoryRoot, 'tests/fixtures/content');
  const hasScenarioContent = await stat(scenarioContentDir)
    .then((stats) => stats.isDirectory())
    .catch(() => false);
  const defaultProfiles = hasScenarioContent
    ? simulationProfiles
    : simulationProfiles.filter(
        (profile) =>
          !scriptedScenarioProfiles.includes(profile as (typeof scriptedScenarioProfiles)[number]),
      );
  const profiles = parseProfiles(args.get('profiles'), defaultProfiles);
  const requestedScenarioProfiles = profiles.filter((profile) =>
    scriptedScenarioProfiles.includes(profile as (typeof scriptedScenarioProfiles)[number]),
  );
  if (!hasScenarioContent && requestedScenarioProfiles.length > 0) {
    const label = requestedScenarioProfiles.length === 1 ? 'Scenario profile' : 'Scenario profiles';
    const verb = requestedScenarioProfiles.length === 1 ? 'requires' : 'require';
    throw new Error(
      `${label} ${requestedScenarioProfiles.join(', ')} ${verb} tests/fixtures/content from the Open Academy source checkout.`,
    );
  }
  const out = resolve(args.get('out') ?? 'simulation-output');
  const courseIds = args
    .get('courses')
    ?.split(',')
    .map((courseId) => courseId.trim());
  const content = await loadContentFromDirectory(options.contentDir);
  const scenarioContent =
    requestedScenarioProfiles.length > 0
      ? await loadContentFromDirectory(scenarioContentDir)
      : undefined;
  const report = await simulateLearners(driver, content, {
    profiles,
    days,
    ...(courseIds ? { courseIds } : {}),
    ...(scenarioContent ? { scenarioContent } : {}),
    onProgress: (message) => {
      const match = message.match(/day (\d+)\/(\d+)/);
      if (!match || Number(match[1]) === 1 || Number(match[1]) % 10 === 0) console.log(message);
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
}
