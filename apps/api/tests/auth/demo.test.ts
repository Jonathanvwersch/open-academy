import { afterAll, beforeEach, expect, test } from 'vitest';
import { createApp } from '../../src/app.js';
import { env, productionAuth } from '../../src/config.js';
import { createDb } from '../../src/db/client.js';
import { users } from '../../src/db/schema.js';

const db = createDb(env.TEST_DATABASE_URL);
let now = new Date('2026-01-01T12:00:00Z');
const app = () =>
  createApp({ db, demo: { ttlHours: 24 }, tutorProvider: null, authClock: () => now });
const cookie = (response: Response) => response.headers.get('set-cookie')?.split(';')[0] ?? '';
beforeEach(async () => {
  now = new Date('2026-01-01T12:00:00Z');
  await db.delete(users);
});
afterAll(async () => {
  await db.$client.end();
});

test('me creates a learner and a secure HTTP-only cookie with seed preferences', async () => {
  const response = await app().request('https://academy.example/api/auth/me', {
    headers: { 'X-Time-Zone': 'America/New_York' },
  });
  expect(await response.json()).toEqual({
    authenticated: false,
    authRequired: false,
    demo: { ttlHours: 24 },
  });
  expect(cookie(response)).toMatch(/^academy_demo=[\da-f-]+$/);
  expect(response.headers.get('set-cookie')).toContain('HttpOnly');
  expect(response.headers.get('set-cookie')).toContain('Secure');
  expect(response.headers.get('set-cookie')).toContain('SameSite=Lax');
  expect(response.headers.get('set-cookie')).toContain('Max-Age=86400');
  const [user] = await db.select().from(users);
  expect(user).toMatchObject({
    displayName: 'Learner',
    timezone: 'America/New_York',
    startDate: '2026-01-01',
    prefs: { scheduleMinutes: 60 },
  });
});

test('a returning browser reuses its learner', async () => {
  const target = app();
  const first = await target.request('/api/auth/me');
  now = new Date(now.getTime() + 3600_000);
  const second = await target.request('/api/auth/me', { headers: { cookie: cookie(first) } });
  expect(second.status).toBe(200);
  expect(second.headers.get('set-cookie')).toBeNull();
  const rows = await db.select().from(users);
  expect(rows).toHaveLength(1);
  expect(cookie(first)).toBe(`academy_demo=${rows[0]?.id}`);
});

test('separate browsers have isolated settings and tutor disabled', async () => {
  const target = app();
  const first = cookie(await target.request('/api/auth/me'));
  const second = cookie(await target.request('/api/auth/me'));
  expect(first).not.toBe(second);
  const update = await target.request('/api/settings', {
    method: 'PUT',
    headers: { cookie: first, 'content-type': 'application/json' },
    body: JSON.stringify({ scheduleMinutes: 120 }),
  });
  expect(update.status).toBe(200);
  const settings = await target.request('/api/settings', { headers: { cookie: second } });
  expect(await settings.json()).toMatchObject({
    tutorEnabled: false,
    dailyMinutes: { monday: 60 },
  });
  expect(await db.select().from(users)).toHaveLength(2);
});

test('expired learner is replaced and cleaned up', async () => {
  const target = app();
  const first = cookie(await target.request('/api/auth/me'));
  now = new Date(now.getTime() + 25 * 3600_000);
  const response = await target.request('/api/auth/me', { headers: { cookie: first } });
  expect(cookie(response)).not.toBe(first);
  const rows = await db.select().from(users);
  expect(rows).toHaveLength(1);
  expect(first).not.toBe(`academy_demo=${rows[0]?.id}`);
});

test('garbage or missing learner cookies create learners and invalid timezones fall back', async () => {
  const target = app();
  for (const value of ['garbage', '00000000-0000-4000-8000-000000000001']) {
    const response = await target.request('/api/auth/me', {
      headers: { cookie: `academy_demo=${value}`, 'X-Time-Zone': 'invalid' },
    });
    expect(response.status).toBe(200);
    expect(cookie(response)).not.toBe('');
  }
  expect((await db.select().from(users)).every((user) => user.timezone === 'Europe/London')).toBe(
    true,
  );
});

test('31st creation is capped per IP and allowance resets after an hour', async () => {
  const target = app();
  for (let index = 0; index < 30; index++)
    expect((await target.request('/api/auth/me')).status).toBe(200);
  const blocked = await target.request('/api/auth/me');
  expect(blocked.status).toBe(429);
  expect(await blocked.json()).toEqual({ error: 'Too many new demo learners, try again later' });
  expect(
    (await target.request('/api/auth/me', { headers: { 'x-forwarded-for': '203.0.113.2' } }))
      .status,
  ).toBe(200);
  now = new Date(now.getTime() + 3600_000);
  expect((await target.request('/api/auth/me')).status).toBe(200);
});

test('non-demo uses the first learner and reports demo null', async () => {
  await db.insert(users).values({ displayName: 'First', prefs: { scheduleMinutes: 90 } });
  const target = createApp({ db, demo: null, tutorProvider: null });
  expect(await (await target.request('/api/auth/me')).json()).toEqual({
    authenticated: false,
    authRequired: false,
    demo: null,
  });
  expect(await (await target.request('/api/settings')).json()).toMatchObject({
    dailyMinutes: { monday: 90 },
  });
  expect(await db.select().from(users)).toHaveLength(1);
});

test('startup rejects ambiguous demo and password configuration', () => {
  expect(() => productionAuth(true, 'password-12345')).toThrow('cannot both be set');
  expect(productionAuth(true)).toBeNull();
  expect(() => productionAuth(false)).toThrow('at least 12 characters');
});

test('demo cleanup and cookies cannot delete or adopt a permanent learner', async () => {
  const [permanent] = await db
    .insert(users)
    .values({
      displayName: 'Permanent',
      createdAt: new Date('2025-01-01T00:00:00Z'),
    })
    .returning();
  if (!permanent) throw new Error('Missing permanent learner');
  const response = await app().request('/api/auth/me', {
    headers: { cookie: `academy_demo=${permanent.id}` },
  });
  const rows = await db.select().from(users);
  expect(rows).toHaveLength(2);
  expect(rows.some((row) => row.id === permanent.id)).toBe(true);
  expect(cookie(response)).not.toBe(`academy_demo=${permanent.id}`);
});

test('new demo learners start on their local date', async () => {
  now = new Date('2026-01-01T02:00:00Z');
  await app().request('/api/auth/me', { headers: { 'X-Time-Zone': 'America/Los_Angeles' } });
  const [user] = await db.select().from(users);
  expect(user?.startDate).toBe('2025-12-31');
});
