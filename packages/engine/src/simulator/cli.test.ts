import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { runSimulateCli } from './cli.js';
import { scriptedScenarioProfiles } from './simulator.js';

const contentDir = fileURLToPath(new URL('../../../../tests/fixtures/content', import.meta.url));

test('defaults omit scripted scenarios without repository fixtures', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'academy-simulator-cli-'));
  try {
    const out = join(directory, 'out');
    await runSimulateCli(['--days', '1', '--out', out], {
      contentDir,
      drivers: {},
      scenarioContentDir: join(directory, 'missing-fixtures'),
    });
    const report = JSON.parse(await readFile(join(out, 'report.json'), 'utf8')) as {
      profiles: Array<{ profile: string }>;
    };
    const profiles = new Set(report.profiles.map(({ profile }) => profile));
    expect(scriptedScenarioProfiles.some((profile) => profiles.has(profile))).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

test('explicit scripted scenarios require repository fixtures', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'academy-simulator-cli-'));
  try {
    await expect(
      runSimulateCli(['--profiles', 'scenario-p14-fallback'], {
        contentDir,
        drivers: {},
        scenarioContentDir: join(directory, 'missing-fixtures'),
      }),
    ).rejects.toThrow('tests/fixtures/content');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('accepts equals-form simulator options', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'academy-simulator-cli-'));
  try {
    const out = join(directory, 'out');
    await runSimulateCli([`--days=1`, `--out=${out}`], {
      contentDir,
      drivers: {},
      scenarioContentDir: join(directory, 'missing-fixtures'),
    });
    const report = JSON.parse(await readFile(join(out, 'report.json'), 'utf8')) as {
      profiles: Array<{ profile: string }>;
    };
    expect(report.profiles.length).toBeGreaterThan(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
