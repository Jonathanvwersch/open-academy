import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { expect, test } from 'vitest';
import { createApp } from '../app.js';
import type { Database } from '../db/client.js';

test('the Node adapter accepts empty POST bodies and rejects malformed nonempty JSON', async () => {
  // These auth-disabled routes never touch the database, so this exercises the
  // real HTTP adapter and request middleware without a PostgreSQL prerequisite.
  const app = createApp({ db: {} as Database, tutorProvider: null });
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  try {
    if (!server.listening) await once(server, 'listening');
    const { port } = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}/api/auth/logout`;
    for (const body of [undefined, '']) {
      const response = await fetch(url, { method: 'POST', body });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
    }
    for (const body of ['{', ' ']) {
      const response = await fetch(url, { method: 'POST', body });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'Invalid JSON request body.' });
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
