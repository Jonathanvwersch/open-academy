import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src/web', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    fileParallelism: false,
    globalSetup: ['./tests/global-setup.ts'],
    include: ['tests/**/*.test.ts'],
  },
});
