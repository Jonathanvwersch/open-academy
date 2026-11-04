import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app.js';
import { createDb } from '../src/server/db/client.js';
import { env } from '../src/server/env.js';

describe('GET /api/health', () => {
  const db = createDb(env.TEST_DATABASE_URL);
  const app = createApp({ db });

  afterAll(async () => {
    await db.$client.end();
  });

  it('returns a healthy database response', async () => {
    const response = await app.request('/api/health');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, db: true });
  });
});
