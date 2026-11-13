import { resolve } from 'node:path';

export const e2ePassword = 'test-password-123';
export const storageStatePath = resolve(
  process.env.PLAYWRIGHT_STORAGE_STATE_PATH ?? 'tests/e2e/.auth/authenticated.json',
);
