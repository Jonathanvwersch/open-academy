import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const setting = spawnSync('git', ['config', '--local', '--get', 'core.hooksPath'], {
  cwd: root,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'ignore'],
});
if (setting.error || ![0, 1].includes(setting.status))
  throw setting.error ?? new Error('Could not read local Git hook configuration.');
const current = setting.stdout;
if (current.trim() && current.trim() !== '.githooks') {
  throw new Error(
    `This checkout already uses ${current.trim()} for Git hooks; integrate .githooks/pre-commit there.`,
  );
}
execFileSync('git', ['config', '--local', 'core.hooksPath', '.githooks'], { cwd: root });
console.log('Installed repository-local Git hooks.');
