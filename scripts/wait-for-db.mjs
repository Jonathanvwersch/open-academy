import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

export async function waitForDatabase() {
  const deadline = Date.now() + 60_000;

  while (Date.now() < deadline) {
    const result = spawnSync(
      'docker',
      [
        'compose',
        'exec',
        '-T',
        'db',
        'pg_isready',
        '-h',
        '127.0.0.1',
        '-U',
        'academy',
        '-d',
        'academy',
      ],
      { stdio: 'ignore' },
    );
    if (result.status === 0) {
      return;
    }
    await delay(1_000);
  }

  throw new Error('PostgreSQL did not become ready within 60 seconds');
}
