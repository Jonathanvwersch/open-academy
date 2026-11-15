import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';

for (const [project, implementation] of [
  ['linreg-numpy', 'linreg.py'],
  ['nn-from-scratch', 'nn.py'],
] as const) {
  test(`${project} setup preserves learner work unless explicitly forced`, () => {
    const directory = mkdtempSync(join(tmpdir(), 'academy-lab-setup-'));
    try {
      cpSync(resolve('labs', project, 'setup.py'), join(directory, 'setup.py'));
      cpSync(resolve('labs', project, 'starter'), join(directory, 'starter'), { recursive: true });
      const setup = join(directory, 'setup.py');
      const work = join(directory, 'work', implementation);
      execFileSync('python3', [setup]);
      const starter = readFileSync(work, 'utf8');
      writeFileSync(work, '# My completed implementation\n');
      execFileSync('python3', [setup]);
      expect(readFileSync(work, 'utf8')).toBe('# My completed implementation\n');
      execFileSync('python3', [setup, '--force']);
      expect(readFileSync(work, 'utf8')).toBe(starter);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
