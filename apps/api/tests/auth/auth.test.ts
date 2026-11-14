import { createHash } from 'node:crypto';
import { afterAll, beforeEach, expect, test } from 'vitest';
import { createApp } from '../../src/app.js';
import { env } from '../../src/config.js';
import { createDb } from '../../src/db/client.js';
import { authSessions } from '../../src/db/schema.js';

const db = createDb(env.TEST_DATABASE_URL);
const password = 'test-password-123';
let currentTime = new Date('2026-01-01T12:00:00.000Z');

function app() {
  return createApp({
    db,
    auth: { password },
    authClock: () => new Date(currentTime),
  });
}

function hash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function sessionCookie(token: string): string {
  return `academy_session=${token}`;
}

async function login(
  target: ReturnType<typeof app>,
  candidate: string,
  ip = '203.0.113.1',
  forwardedProto?: string,
) {
  const headers = new Headers({ 'content-type': 'application/json', 'x-forwarded-for': ip });
  if (forwardedProto) headers.set('x-forwarded-proto', forwardedProto);
  return target.request('/api/auth/login', {
    method: 'POST',
    headers,
    body: JSON.stringify({ password: candidate }),
  });
}

beforeEach(async () => {
  currentTime = new Date('2026-01-01T12:00:00.000Z');
  await db.delete(authSessions);
});

afterAll(async () => {
  await db.$client.end();
});

test('unauthenticated API requests are rejected while health stays public', async () => {
  const target = app();
  const today = await target.request('/api/today');
  expect(today.status).toBe(401);
  expect(await today.json()).toEqual({ error: 'unauthenticated' });

  const health = await target.request('/api/health');
  expect(health.status).toBe(200);
  expect(await health.json()).toEqual({ ok: true, db: true });
});

test('auth can be disabled for local and existing application use', async () => {
  const response = await createApp({ db }).request('/api/auth/me');
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ authenticated: false, authRequired: false, demo: null });
  expect((await createApp({ db }).request('/api/today')).status).not.toBe(401);
});

test('wrong passwords return 401', async () => {
  const response = await login(app(), 'not-the-password');
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ error: 'Wrong password' });
});

test('the sixth attempt from an IP is blocked before password comparison', async () => {
  const target = app();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    expect((await login(target, 'wrong', '198.51.100.1')).status).toBe(401);
  }
  const response = await login(target, password, '198.51.100.1');
  expect(response.status).toBe(429);
  expect(await response.json()).toEqual({ error: 'Too many attempts, try again later' });
});

test('a successful login resets the IP failure counter', async () => {
  const target = app();
  for (let attempt = 0; attempt < 4; attempt += 1) {
    expect((await login(target, 'wrong', '198.51.100.2')).status).toBe(401);
  }
  expect((await login(target, password, '198.51.100.2')).status).toBe(200);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    expect((await login(target, 'wrong', '198.51.100.2')).status).toBe(401);
  }
  expect((await login(target, password, '198.51.100.2')).status).toBe(429);
});

test('the global failure limit blocks the next attempt across IPs', async () => {
  const target = app();
  for (let ip = 0; ip < 6; ip += 1) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await login(target, 'wrong', `198.51.100.${ip + 1}`)).status).toBe(401);
    }
  }
  expect((await login(target, password, '203.0.113.200')).status).toBe(429);
});

test('login sets a secure one-year cookie and stores only its hash', async () => {
  const target = app();
  const response = await login(target, password, '203.0.113.10', 'https');
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
  const setCookie = response.headers.get('set-cookie') ?? '';
  expect(setCookie).toContain('HttpOnly');
  expect(setCookie).toContain('SameSite=Lax');
  expect(setCookie).toContain('Max-Age=31536000');
  expect(setCookie).toContain('Path=/');
  expect(setCookie).toContain('Secure');

  const cookie = setCookie.split(';', 1)[0] ?? '';
  const token = cookie.slice('academy_session='.length);
  expect(token).toHaveLength(43);
  const [session] = await db.select().from(authSessions);
  expect(session?.tokenHash).toBe(hash(token));
  expect(JSON.stringify(session)).not.toContain(token);

  const me = await target.request('/api/auth/me', { headers: { cookie } });
  expect(me.status).toBe(200);
  expect(await me.json()).toEqual({ authenticated: true, authRequired: true, demo: null });
});

test('expired sessions are rejected', async () => {
  const target = app();
  const token = 'expired-session-token';
  await db.insert(authSessions).values({
    tokenHash: hash(token),
    expiresAt: new Date(currentTime.getTime() - 1),
    lastSeenAt: currentTime,
  });
  const response = await target.request('/api/today', {
    headers: { cookie: sessionCookie(token) },
  });
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ error: 'unauthenticated' });
});

test('sessions renew after a day of inactivity', async () => {
  const target = app();
  const token = 'renewable-session-token';
  const lastSeenAt = new Date(currentTime.getTime() - 2 * 24 * 60 * 60 * 1000);
  await db.insert(authSessions).values({
    tokenHash: hash(token),
    expiresAt: new Date(currentTime.getTime() + 10 * 24 * 60 * 60 * 1000),
    lastSeenAt,
  });

  const response = await target.request('/api/auth/me', {
    headers: { cookie: sessionCookie(token) },
  });
  expect(await response.json()).toEqual({ authenticated: true, authRequired: true, demo: null });
  expect(response.headers.get('set-cookie')).toContain('Max-Age=31536000');
  const [session] = await db.select().from(authSessions);
  expect(session?.lastSeenAt?.toISOString()).toBe(currentTime.toISOString());
  expect(session?.expiresAt.toISOString()).toBe(
    new Date(currentTime.getTime() + 365 * 24 * 60 * 60 * 1000).toISOString(),
  );
});

test('logout-all revokes the current and other sessions', async () => {
  const target = app();
  const tokens = ['first-session-token', 'second-session-token'];
  await db.insert(authSessions).values(
    tokens.map((token) => ({
      tokenHash: hash(token),
      expiresAt: new Date(currentTime.getTime() + 365 * 24 * 60 * 60 * 1000),
      lastSeenAt: currentTime,
    })),
  );

  const logout = await target.request('/api/auth/logout-all', {
    method: 'POST',
    headers: { cookie: sessionCookie(tokens[0] ?? '') },
  });
  expect(logout.status).toBe(200);
  expect(await db.select().from(authSessions)).toHaveLength(0);
  for (const token of tokens) {
    const response = await target.request('/api/today', {
      headers: { cookie: sessionCookie(token) },
    });
    expect(response.status).toBe(401);
  }
});
