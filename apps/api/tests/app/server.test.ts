import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { env } from '../../src/config.js';
import { createDb } from '../../src/db/client.js';

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

describe('API request boundaries', () => {
  const db = createDb(env.TEST_DATABASE_URL);
  const app = createApp({ db });

  afterAll(async () => {
    await db.$client.end();
  });

  it('rejects cross-origin browser writes before performing any mutation', async () => {
    for (const headers of <HeadersInit[]>[
      { origin: 'https://attacker.example' },
      { origin: 'null' },
      { 'sec-fetch-site': 'cross-site' },
      { 'sec-fetch-site': 'same-site' },
    ]) {
      const response = await app.request('/api/auth/login', {
        method: 'POST',
        headers,
        body: '{}',
      });
      expect(response.status).toBe(403);
    }
  });

  it('allows same-origin browsers and non-browser clients', async () => {
    for (const headers of <HeadersInit[]>[
      { origin: 'http://localhost', 'sec-fetch-site': 'same-origin' },
      {},
    ]) {
      const response = await app.request('/api/auth/login', {
        method: 'POST',
        headers,
        body: '{}',
      });
      expect(response.status).toBe(200);
    }
  });

  it('allows Vite proxy writes using browser fetch metadata or the original Host', async () => {
    for (const metadata of <Record<string, string>[]>[{}, { 'sec-fetch-site': 'same-origin' }]) {
      const response = await app.request('http://localhost:3002/api/auth/login', {
        method: 'POST',
        headers: { origin: 'http://localhost:5174', host: 'localhost:5174', ...metadata },
        body: '{}',
      });
      expect(response.status).toBe(200);
    }
  });

  it('allows same-origin browser writes behind HTTPS termination', async () => {
    for (const metadata of <Record<string, string>[]>[{}, { 'sec-fetch-site': 'same-origin' }]) {
      const response = await app.request('http://academy.example/api/auth/login', {
        method: 'POST',
        headers: { origin: 'https://academy.example', 'x-forwarded-proto': 'https', ...metadata },
        body: '{}',
      });
      expect(response.status).toBe(200);
    }
  });

  it('rejects malformed JSON before a route can apply defaults', async () => {
    const response = await app.request('/api/auth/login', { method: 'POST', body: '{' });
    expect(response.status).toBe(400);
  });

  it('bounds JSON requests before parsing', async () => {
    const response = await app.request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ password: 'x'.repeat(1024 * 1024) }),
    });
    expect(response.status).toBe(413);
  });
});
