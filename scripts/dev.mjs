import { spawn, spawnSync } from 'node:child_process';
import 'dotenv/config';
import { waitForDatabase } from './wait-for-db.mjs';

if (!process.env.ACADEMY_PASSWORD) {
  console.warn('Warning: ACADEMY_PASSWORD is unset; authentication is off.');
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

run('docker', ['compose', 'up', '-d']);
await waitForDatabase();

run('pnpm', ['run', 'db:migrate']);
run('pnpm', ['run', 'db:seed']);

const children = ['dev:api', 'dev:web'].map((script) =>
  spawn('pnpm', ['run', script], { stdio: 'inherit' }),
);
const exitedChildren = new Set();
let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  for (const child of children) {
    child.kill(signal);
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => shutdown(signal));
}

for (const child of children) {
  child.on('exit', (code) => {
    exitedChildren.add(child);
    if (!shuttingDown) {
      process.exitCode = code || 1;
      shutdown('SIGTERM');
    }
    if (exitedChildren.size === children.length) {
      process.exit();
    }
  });
}
