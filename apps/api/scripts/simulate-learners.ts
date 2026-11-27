import type { SimulatorDriverFactory } from '@open-academy/engine/simulator';
import { runSimulateCli } from '@open-academy/engine/simulator';
import { config } from 'dotenv';
import { resolveContentDirectory } from '../src/content/load.js';
import { repositoryPath } from '../src/paths.js';

async function main() {
  config({ path: repositoryPath('.env'), quiet: true });
  const argv = process.argv.slice(2);
  const driverIndex = argv.lastIndexOf('--driver');
  let httpDriver: SimulatorDriverFactory | undefined;
  let close: (() => Promise<void>) | undefined;
  if (driverIndex >= 0 && argv[driverIndex + 1] === 'http') {
    const [{ env }, { createDb }, { httpPostgresDriver }] = await Promise.all([
      import('../src/config.js'),
      import('../src/db/client.js'),
      import('./learner-simulation-http-driver.js'),
    ]);
    const db = createDb(env.TEST_DATABASE_URL);
    httpDriver = httpPostgresDriver(db);
    close = () => db.$client.end();
  }
  try {
    await runSimulateCli(argv, {
      contentDir: resolveContentDirectory(),
      drivers: httpDriver ? { http: httpDriver } : {},
    });
  } finally {
    await close?.();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
