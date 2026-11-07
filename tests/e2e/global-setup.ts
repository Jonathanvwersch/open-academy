import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { request } from '@playwright/test';
import { e2ePassword, storageStatePath } from './auth-config.js';

export default async function globalSetup() {
  const webPort = process.env.PLAYWRIGHT_WEB_PORT ?? '5174';
  const context = await request.newContext({ baseURL: `http://127.0.0.1:${webPort}` });
  const deadline = Date.now() + 60_000;
  let apiReady = false;
  let lastStatus: number | undefined;
  let lastError: string | undefined;
  while (Date.now() < deadline) {
    try {
      const health = await context.get('/api/health', { timeout: 1_000 });
      lastStatus = health.status();
      apiReady = health.ok();
      await health.dispose();
      if (apiReady) break;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!apiReady) {
    await context.dispose();
    throw new Error(
      `E2E API health check did not become ready within 60 seconds${
        lastStatus === undefined
          ? lastError
            ? ` (${lastError}).`
            : '.'
          : ` (last status ${lastStatus}).`
      }`,
    );
  }
  const response = await context.post('/api/auth/login', {
    data: { password: e2ePassword },
  });
  if (!response.ok()) {
    await context.dispose();
    throw new Error(`E2E login failed with status ${response.status()}.`);
  }
  await mkdir(dirname(storageStatePath), { recursive: true });
  await context.storageState({ path: storageStatePath });
  await context.dispose();
}
