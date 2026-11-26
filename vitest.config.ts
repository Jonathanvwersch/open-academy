import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./apps/web/src', import.meta.url)) } },
  test: {
    environment: 'node',
    fileParallelism: false,
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: [
            'apps/web/src/**/*.test.ts',
            'apps/api/src/**/*.test.ts',
            'apps/api/scripts/**/*.test.ts',
            'packages/*/src/**/*.test.ts',
            'tests/integration/**/*.test.ts',
            'labs/**/*.test.ts',
          ],
        },
      },
      {
        extends: true,
        test: {
          name: 'api',
          globalSetup: ['./apps/api/tests/setup.ts'],
          include: ['apps/api/tests/**/*.test.ts'],
        },
      },
    ],
  },
});
