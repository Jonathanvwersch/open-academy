import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

function fixture(run) {
  const root = mkdtempSync(path.join(tmpdir(), 'academy-tooling-'));
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('the database readiness CLI retries until Docker reports a ready database', () => {
  fixture((root) => {
    const calls = path.join(root, 'calls');
    const docker = path.join(root, 'docker');
    writeFileSync(
      docker,
      `#!${process.execPath}
import { appendFileSync, readFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + '\\n');
process.exit(readFileSync(${JSON.stringify(calls)}, 'utf8').trim().split('\\n').length < 2 ? 1 : 0);
`,
      { mode: 0o755 },
    );
    execFileSync(process.execPath, [fileURLToPath(new URL('./wait-for-db.mjs', import.meta.url))], {
      env: { ...process.env, PATH: `${root}${path.delimiter}${process.env.PATH}` },
      timeout: 10_000,
    });
    const attempts = readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(attempts.length, 2);
    assert.deepEqual(attempts[0].slice(0, 5), ['compose', 'exec', '-T', 'db', 'pg_isready']);
  });
});

test('the database readiness CLI fails immediately when Docker is unavailable', () => {
  fixture((root) => {
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          [fileURLToPath(new URL('./wait-for-db.mjs', import.meta.url))],
          {
            env: { ...process.env, PATH: root },
            timeout: 5_000,
            stdio: 'pipe',
          },
        ),
      (error) => error.status !== null && error.stderr.toString().includes('ENOENT'),
    );
  });
});

for (const source of ['local', 'global', 'unset']) {
  test(`bootstrap preserves ${source} Git hooks without failing installation`, () => {
    fixture((root) => {
      const env = {
        ...process.env,
        GIT_CONFIG_GLOBAL: path.join(root, 'global-config'),
        GIT_CONFIG_NOSYSTEM: '1',
      };
      const git = (...args) => execFileSync('git', args, { cwd: root, env, encoding: 'utf8' });
      git('init', '--quiet');
      if (source !== 'unset') git('config', `--${source}`, 'core.hooksPath', '/custom-hooks');
      mkdirSync(path.join(root, 'scripts'));
      copyFileSync(
        fileURLToPath(new URL('./install-hooks.mjs', import.meta.url)),
        path.join(root, 'scripts/install-hooks.mjs'),
      );
      execFileSync(process.execPath, [path.join(root, 'scripts/install-hooks.mjs')], {
        cwd: root,
        env,
        stdio: 'pipe',
      });
      assert.equal(
        git('config', '--get', 'core.hooksPath').trim(),
        source === 'unset' ? '.githooks' : '/custom-hooks',
      );
    });
  });
}
