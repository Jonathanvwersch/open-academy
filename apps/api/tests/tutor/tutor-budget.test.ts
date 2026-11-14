import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, expect, test } from 'vitest';
import { env } from '../../src/config.js';
import { loadContent } from '../../src/content/load.js';
import { createDb } from '../../src/db/client.js';
import { llmCalls, users } from '../../src/db/schema.js';
import { FakeProvider } from '../../src/features/tutor/provider.js';
import { TutorService } from '../../src/features/tutor/service.js';

const db = createDb(env.TEST_DATABASE_URL);
const content = await loadContent('tests/fixtures/content');
const userId = '00000000-0000-4000-8000-000000000097';

beforeEach(async () => {
  await db.delete(users).where(eq(users.id, userId));
  await db.insert(users).values({ id: userId, displayName: 'Budget test', timezone: 'UTC' });
});

afterAll(async () => {
  await db.delete(users).where(eq(users.id, userId));
  await db.$client.end();
});

test('concurrent requests reserve calls before the provider runs', async () => {
  let calls = 0;
  let release: () => void = () => {};
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const provider = new FakeProvider();
  const respond = provider.respond.bind(provider);
  provider.respond = async (...args) => {
    calls += 1;
    await blocked;
    return respond(...args);
  };
  const services = Array.from(
    { length: 8 },
    () => new TutorService(db, provider, userId, 2, 'UTC'),
  );
  const pending = services.map((service) => service.respond({} as never, 'hint', content));
  // Wait for all reservations to commit while the accepted provider calls are blocked.
  const reservations = await new Promise<(typeof llmCalls.$inferSelect)[]>((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const inspect = async () => {
      const rows = await db.select().from(llmCalls).where(eq(llmCalls.userId, userId));
      if (rows.length === services.length) return resolve(rows);
      if (Date.now() > deadline) return reject(new Error('Tutor reservations did not settle'));
      setTimeout(() => void inspect().catch(reject), 10);
    };
    void inspect().catch(reject);
  }).finally(release);
  const results = await Promise.all(pending);
  expect(calls).toBe(2);
  expect(reservations.filter((row) => row.status === 'pending')).toHaveLength(2);
  expect(results.filter((result) => result.status === 'ok')).toHaveLength(2);
  expect(results.filter((result) => result.status === 'budget_exceeded')).toHaveLength(6);
});

test('failed provider requests consume the daily allowance', async () => {
  const provider = new FakeProvider(undefined, undefined, new Error('offline'));
  const service = new TutorService(db, provider, userId, 1, 'UTC');
  expect((await service.respond({} as never, 'hint', content)).status).toBe('fallback');
  expect((await service.respond({} as never, 'hint', content)).status).toBe('budget_exceeded');
  const rows = await db.select().from(llmCalls).where(eq(llmCalls.userId, userId));
  expect(rows.map((row) => row.status).sort()).toEqual(['budget_exceeded', 'fallback']);
});
