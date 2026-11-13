import { readFile } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { env } from '../../src/config.js';
import { loadContent } from '../../src/content/load.js';
import type { ContentIndex } from '../../src/content/types.js';
import { createDb } from '../../src/db/client.js';
import {
  paperFiles,
  paperPages,
  paperProgress,
  sessionActivities,
  studySessions,
  users,
  xpEvents,
} from '../../src/db/schema.js';
import type { PaperFetcher } from '../../src/features/papers/fetcher.js';
import { extractPaperPages } from '../../src/features/papers/service.js';
import { FakeProvider } from '../../src/features/tutor/provider.js';

const db = createDb(env.TEST_DATABASE_URL);
const userId = '00000000-0000-4000-8000-000000000199';
const headers = { 'content-type': 'application/json', 'X-Now': '2026-01-01T12:00:00.000Z' };
let content: ContentIndex;
let fetchCount = 0;
let pdfBytes = new Uint8Array();
const fetcher: PaperFetcher = {
  async fetch() {
    fetchCount += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return pdfBytes;
  },
};
const judgement = { criteria: [], feedback_md: 'The summary is clear.' };
let app: ReturnType<typeof createApp>;
let noTutorApp: ReturnType<typeof createApp>;
let failingTutorApp: ReturnType<typeof createApp>;

beforeAll(async () => {
  content = await loadContent('tests/fixtures/content');
  app = createApp({
    db,
    content,
    tutorProvider: new FakeProvider(undefined, judgement),
    paperFetcher: fetcher,
  });
  noTutorApp = createApp({ db, content, tutorProvider: null, paperFetcher: fetcher });
  failingTutorApp = createApp({
    db,
    content,
    tutorProvider: new FakeProvider(undefined, undefined, new Error('provider offline')),
    paperFetcher: fetcher,
  });
  pdfBytes = new Uint8Array(await readFile('tests/fixtures/papers/fixture-paper-one.pdf'));
});

beforeEach(async () => {
  fetchCount = 0;
  await db.delete(users);
  await db.delete(paperFiles);
  await db.delete(paperPages);
  await db.insert(users).values({
    id: userId,
    displayName: 'Paper test learner',
    timezone: 'UTC',
    startDate: '2026-01-01',
  });
});

afterAll(async () => {
  await db.delete(users).where(eq(users.id, userId));
  await db.$client.end();
});

test('sequential PDF requests fetch once and cache the PDF', async () => {
  const first = await app.request('/api/papers/fixture-paper-one/pdf');
  const second = await app.request('/api/papers/fixture-paper-one/pdf');
  expect(first.status).toBe(200);
  expect(second.status).toBe(200);
  expect(first.headers.get('content-type')).toBe('application/pdf');
  expect(first.headers.get('cache-control')).toBe('private, max-age=86400');
  expect(fetchCount).toBe(1);
});

test('concurrent PDF cache misses share one upstream fetch', async () => {
  const [first, second] = await Promise.all([
    app.request('/api/papers/fixture-paper-one/pdf'),
    app.request('/api/papers/fixture-paper-one/pdf'),
  ]);
  expect(first.status).toBe(200);
  expect(second.status).toBe(200);
  expect(fetchCount).toBe(1);
});

test('PDF route returns 502 for non-PDF and over-cap fetches', async () => {
  pdfBytes = new TextEncoder().encode('not a PDF');
  expect((await app.request('/api/papers/fixture-paper-one/pdf')).status).toBe(502);
  await db.delete(paperFiles);
  pdfBytes = new Uint8Array(40 * 1024 * 1024 + 1);
  pdfBytes.set(new TextEncoder().encode('%PDF'));
  expect((await app.request('/api/papers/fixture-paper-one/pdf')).status).toBe(502);
});

test('paper page extraction skips PDF parsing when pages are already stored', async () => {
  const fixtureBytes = new Uint8Array(
    await readFile('tests/fixtures/papers/fixture-paper-one.pdf'),
  );
  await extractPaperPages(db, 'fixture-paper-one', fixtureBytes);
  const rows = await db
    .select()
    .from(paperPages)
    .where(eq(paperPages.paperId, 'fixture-paper-one'));
  expect(rows).toHaveLength(3);
  const loader = vi.fn(async (_bytes: Uint8Array) => {
    throw new Error('Cached paper pages should skip PDF parsing.');
  });
  await extractPaperPages(db, 'fixture-paper-one', fixtureBytes, loader);
  expect(loader).not.toHaveBeenCalled();
});

test('paper progress rejects question IDs not in the guide', async () => {
  const response = await app.request('/api/papers/fixture-paper-one/progress', {
    method: 'PUT',
    headers,
    body: JSON.stringify({ notes: { invented: 'note' } }),
  });
  expect(response.status).toBe(400);
});

test('paper list and detail expose progress state and unknown papers return 404', async () => {
  const initialList = await app.request('/api/papers');
  expect(initialList.status).toBe(200);
  const initialWeek = (await initialList.json()).weeks.find(
    (week: { week: number }) => week.week === 1,
  );
  expect(
    initialWeek?.papers.find((paper: { id: string }) => paper.id === 'fixture-paper-one'),
  ).toMatchObject({ status: 'not_started' });

  const saved = await app.request('/api/papers/fixture-paper-one/progress', {
    method: 'PUT',
    headers,
    body: JSON.stringify({ lastPage: 2, notes: { claim: 'A useful claim.' } }),
  });
  expect(saved.status).toBe(200);
  const detail = await app.request('/api/papers/fixture-paper-one');
  const detailBody = await detail.json();
  expect(detailBody).toMatchObject({
    paper: { summary: { prompt: 'Summarize the paper.' } },
    progress: { lastPage: 2, notes: { claim: 'A useful claim.' } },
  });
  expect(detailBody.paper.summary).not.toHaveProperty('exemplar');
  expect(detailBody.paper.summary).not.toHaveProperty('rubric');
  const readingList = await app.request('/api/papers');
  const readingWeek = (await readingList.json()).weeks.find(
    (week: { week: number }) => week.week === 1,
  );
  expect(
    readingWeek?.papers.find((paper: { id: string }) => paper.id === 'fixture-paper-one'),
  ).toMatchObject({ status: 'reading' });
  expect((await app.request('/api/papers/unknown-paper')).status).toBe(404);
});

test('summary grading stores judgement, completes a linked activity, and disabled grading saves without judgement', async () => {
  const [session] = await db
    .insert(studySessions)
    .values({
      userId,
      plannedMinutes: 60,
      status: 'active',
      startedAt: new Date('2026-01-01T12:00:00.000Z'),
    })
    .returning();
  if (!session) throw new Error('Could not create paper session');
  const [activity] = await db
    .insert(sessionActivities)
    .values({
      sessionId: session.id,
      idx: 0,
      kind: 'paper',
      plannedMinutes: 60,
      status: 'in_progress',
    })
    .returning();
  if (!activity) throw new Error('Could not create paper activity');
  const graded = await app.request('/api/papers/fixture-paper-one/summary', {
    method: 'POST',
    headers,
    body: JSON.stringify({ summary: 'A concise summary.', activityId: activity.id }),
  });
  expect(graded.status).toBe(200);
  const gradedBody = await graded.json();
  expect(gradedBody.judgement).toEqual(judgement);
  expect(gradedBody.rubric).toHaveLength(3);
  const completedDetail = await app.request('/api/papers/fixture-paper-one');
  const completedPaper = (await completedDetail.json()).paper;
  expect(completedPaper.summary).not.toHaveProperty('exemplar');
  expect(completedPaper.summary.rubric).toHaveLength(3);
  const [saved] = await db
    .select()
    .from(paperProgress)
    .where(eq(paperProgress.paperId, 'fixture-paper-one'));
  expect(saved?.summaryJudgement).toEqual(judgement);
  expect(saved?.completedAt).toBeInstanceOf(Date);
  const [completedActivity] = await db
    .select()
    .from(sessionActivities)
    .where(eq(sessionActivities.id, activity.id));
  expect(completedActivity?.status).toBe('completed');
  expect(await db.select().from(xpEvents).where(eq(xpEvents.userId, userId))).toHaveLength(0);

  const unavailable = await noTutorApp.request('/api/papers/fixture-paper-two/summary', {
    method: 'POST',
    headers,
    body: JSON.stringify({ summary: 'Still saved.' }),
  });
  expect(unavailable.status).toBe(200);
  expect(await unavailable.json()).toMatchObject({ judgement: null, reason: expect.any(String) });

  const failed = await failingTutorApp.request('/api/papers/fixture-paper-two/summary', {
    method: 'POST',
    headers,
    body: JSON.stringify({ summary: 'Saved despite a grading failure.' }),
  });
  expect(failed.status).toBe(200);
  expect(await failed.json()).toMatchObject({
    judgement: null,
    reason: 'Tutor grading failed.',
  });
});
