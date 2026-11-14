import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const temporaryDirectory = mkdtempSync(join(tmpdir(), 'academy-generated-pack-'));
const contentDirectory = join(temporaryDirectory, 'content');
const subjectTitle = 'Generated Pack';

try {
  const init = spawnSync('pnpm', ['academy', 'init', contentDirectory, '--title', subjectTitle], {
    cwd: root,
    stdio: 'inherit',
  });
  if (init.error) throw init.error;
  if (init.status !== 0) {
    process.exitCode = init.status ?? 1;
  } else {
    const smoke = spawnSync(
      'pnpm',
      ['exec', 'playwright', 'test', 'tests/e2e/generated-pack-smoke.spec.ts'],
      {
        cwd: root,
        env: {
          ...process.env,
          COMPOSE_PROJECT_NAME: process.env.COMPOSE_PROJECT_NAME ?? 'academy',
          PACK_SMOKE_COURSE_TITLE: `${subjectTitle} basics`,
          PLAYWRIGHT_CONTENT_DIR: contentDirectory,
        },
        stdio: 'inherit',
      },
    );
    if (smoke.error) throw smoke.error;
    process.exitCode = smoke.status ?? 1;
  }
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
