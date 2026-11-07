import { defineConfig, devices } from '@playwright/test';
import { e2ePassword, storageStatePath } from './tests/e2e/auth-config.js';

const apiPort = process.env.PLAYWRIGHT_API_PORT ?? '3002';
const webPort = process.env.PLAYWRIGHT_WEB_PORT ?? '5174';

export default defineConfig({
  testDir: './tests/e2e',
  workers: 1,
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    storageState: storageStatePath,
    viewport: { width: 1280, height: 900 },
  },
  globalSetup: './tests/e2e/global-setup.ts',
  webServer: {
    command: 'pnpm dev',
    url: `http://127.0.0.1:${webPort}`,
    reuseExistingServer: false,
    env: {
      ...process.env,
      CONTENT_DIR: 'tests/fixtures/content',
      PAPER_FIXTURE_DIR: 'tests/fixtures/papers',
      DATABASE_URL:
        process.env.TEST_DATABASE_URL ?? 'postgres://academy:academy@localhost:5433/academy_test',
      NODE_ENV: 'test',
      NOW_OVERRIDE: '2026-01-01T12:00:00.000Z',
      ACADEMY_E2E: '1',
      ACADEMY_PASSWORD: e2ePassword,
      PORT: apiPort,
      VITE_PORT: webPort,
    },
    timeout: 120_000,
  },
});
