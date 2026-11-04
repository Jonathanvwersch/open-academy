import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  use: {
    baseURL: 'http://127.0.0.1:5174',
  },
  webServer: {
    command: 'pnpm dev',
    url: 'http://127.0.0.1:5174',
    reuseExistingServer: false,
    env: {
      ...process.env,
      CONTENT_DIR: 'tests/fixtures/content',
      DATABASE_URL:
        process.env.TEST_DATABASE_URL ?? 'postgres://academy:academy@localhost:5433/academy_test',
      NODE_ENV: 'test',
      NOW_OVERRIDE: '2026-01-01T12:00:00.000Z',
      PORT: '3002',
      VITE_PORT: '5174',
    },
    timeout: 120_000,
  },
});
