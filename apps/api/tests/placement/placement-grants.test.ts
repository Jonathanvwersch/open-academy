import type { ContentIndex, IndexedExercise } from '@open-academy/engine/course/types';
import { EngineLearnerRepository } from '@open-academy/engine/engine/repository';
import { initialMastery, masteryRank } from '@open-academy/engine/memory/types';
import {
  applyPlacementGrantOutcome,
  recordPlacementGrants,
} from '@open-academy/engine/placement/grant-commands';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { env } from '../../src/config.js';
import { loadContent } from '../../src/content/load.js';
import { createDb } from '../../src/db/client.js';
import { drizzleLearnerStore } from '../../src/db/learner-store.js';
import {
  attempts,
  diagnosticRuns,
  lessonRuns,
  mastery,
  placementGrants,
  remediationFlags,
  reviewCards,
  reviewLogs,
  sessionActivities,
  studySessions,
  users,
  xpEvents,
} from '../../src/db/schema.js';
import { fsrsFuzzEnabled } from '../../src/learning/fsrs-fuzz.js';

const db = createDb(env.TEST_DATABASE_URL);
const userId = '00000000-0000-4000-8000-000000000321';
const now = new Date('2026-01-07T12:00:00.000Z');
let content: ContentIndex;
let repo: EngineLearnerRepository;
let runId = '';

beforeAll(async () => {
  content = await loadContent('tests/fixtures/content');
});

beforeEach(async () => {
  await db.delete(users);
  await db.insert(users).values({
    id: userId,
    displayName: 'Placement grant learner',
    timezone: 'UTC',
    startDate: '2026-01-01',
    prefs: { scheduleMinutes: 60 },
  });
  repo = new EngineLearnerRepository(
    drizzleLearnerStore(db),
    userId,
    undefined,
    undefined,
    fsrsFuzzEnabled(),
  );
  const [run] = await db
    .insert(diagnosticRuns)
    .values({
      userId,
      kind: 'placement',
      status: 'completed',
      state: {},
      startedAt: now,
      completedAt: now,
    })
    .returning();
  runId = run?.id ?? '';
});

afterAll(async () => {
  await db.delete(users);
  await db.$client.end();
});

function exerciseFor(conceptId: string): IndexedExercise {
  const exercise = (content.exercisesByConcept.get(conceptId) ?? []).find(
    (candidate) => candidate.type === 'mc' || candidate.type === 'numeric',
  );
  if (!exercise) throw new Error(`No exercise for ${conceptId}`);
  return exercise;
}

async function insertAttempt(conceptId: string, mode: 'diagnostic' | 'review', correct: number) {
  const exercise = exerciseFor(conceptId);
  const [row] = await db
    .insert(attempts)
    .values({
      userId,
      exerciseId: exercise.id,
      exerciseVersion: exercise.contentVersion,
      conceptId,
      dimension: exercise.dimension,
      mode,
      answer: {},
      correct,
      credit: correct,
      gradedBy: 'deterministic',
      createdAt: now,
    })
    .returning();
  if (!row) throw new Error('Could not insert attempt');
  return { attemptId: row.id, exercise };
}

async function seedGrant(
  conceptId: string,
  state: 'conditional' | 'confirmed',
  evidenceAttemptIds: string[] = [],
) {
  await db.insert(placementGrants).values({
    userId,
    runId,
    conceptId,
    origin: evidenceAttemptIds.length ? 'direct' : 'inferred',
    state,
    reason: state === 'confirmed' ? 'on_time' : 'inferred_only',
    evidenceAttemptIds,
    createdAt: now,
    updatedAt: now,
    confirmedAt: state === 'confirmed' ? now : null,
  });
  for (const dimension of content.conceptsById.get(conceptId)?.dimensions ?? []) {
    await repo.store.saveMastery(userId, {
      ...initialMastery(conceptId, dimension),
      state: 'independent',
      provisional: state === 'conditional',
    });
    await db.insert(reviewCards).values({ userId, conceptId, dimension, fsrs: {}, dueAt: now });
  }
}

async function answer(conceptId: string, correct: number) {
  const { attemptId, exercise } = await insertAttempt(conceptId, 'review', correct);
  const input = {
    store: drizzleLearnerStore(db),
    userId,
    content,
    exerciseId: exercise.id,
    attemptId,
    mode: 'review',
    correct,
    hintsUsed: 0,
    attemptNo: 1,
    gradedBy: 'deterministic',
    now,
  };
  return { input, result: await applyPlacementGrantOutcome(input) };
}

function activeCards<T extends { suspendedAt: Date | null }>(cards: T[]): T[] {
  return cards.filter((card) => card.suspendedAt === null);
}

async function snapshot() {
  return {
    grants: await db
      .select()
      .from(placementGrants)
      .where(eq(placementGrants.userId, userId))
      .orderBy(placementGrants.conceptId),
    mastery: await db
      .select()
      .from(mastery)
      .where(eq(mastery.userId, userId))
      .orderBy(mastery.conceptId),
    cards: await db
      .select({ conceptId: reviewCards.conceptId, suspendedAt: reviewCards.suspendedAt })
      .from(reviewCards)
      .where(eq(reviewCards.userId, userId))
      .orderBy(reviewCards.conceptId),
    attempts: await db.select().from(attempts).where(eq(attempts.userId, userId)),
    xp: await db.select().from(xpEvents).where(eq(xpEvents.userId, userId)),
    flags: await db.select().from(remediationFlags).where(eq(remediationFlags.userId, userId)),
  };
}

test('placement grants record inferred credit as conditional and on-time answers as confirmed', async () => {
  const { attemptId, exercise } = await insertAttempt('derivatives', 'diagnostic', 1);
  const grants = await recordPlacementGrants({
    store: drizzleLearnerStore(db),
    userId,
    runId,
    state: {
      courseId: 'fixture-course',
      answers: [{ conceptId: 'derivatives', exerciseId: exercise.id, correct: true, attemptId }],
      known: ['vectors', 'derivatives'],
      unknown: [],
    },
    content,
    now,
  });
  expect(grants).toEqual(
    new Map([
      ['vectors', 'conditional'],
      ['derivatives', 'confirmed'],
    ]),
  );
  const rows = await db.select().from(placementGrants).where(eq(placementGrants.userId, userId));
  expect(rows.find((row) => row.conceptId === 'derivatives')).toMatchObject({
    origin: 'direct',
    reason: 'on_time',
    evidenceAttemptIds: [attemptId],
  });
});

test('resumed pre-upgrade checks use answers without attempt ids as evidence by topic', async () => {
  await recordPlacementGrants({
    store: drizzleLearnerStore(db),
    userId,
    runId,
    state: {
      courseId: 'fixture-course',
      answers: [
        { conceptId: 'vectors', exerciseId: exerciseFor('vectors').id, correct: false },
        { conceptId: 'derivatives', exerciseId: exerciseFor('derivatives').id, correct: true },
      ],
      known: ['derivatives'],
      unknown: ['vectors'],
    },
    content,
    now,
  });
  await recordPlacementGrants({
    store: drizzleLearnerStore(db),
    userId,
    runId,
    state: {
      courseId: 'fixture-course',
      answers: [{ conceptId: 'vectors', exerciseId: exerciseFor('vectors').id, correct: true }],
      known: ['vectors'],
      unknown: [],
    },
    content,
    now,
  });
  const rows = await db
    .select()
    .from(placementGrants)
    .where(eq(placementGrants.userId, userId))
    .orderBy(placementGrants.conceptId);
  expect(
    rows.map((row) => [row.conceptId, row.origin, row.state, row.reason, row.evidenceAttemptIds]),
  ).toEqual([
    ['derivatives', 'direct', 'conditional', 'conflicting', []],
    ['vectors', 'direct', 'confirmed', 'on_time', []],
  ]);
});

test('a direct wrong answer withdraws a conditional grant, cascades, and keeps history', async () => {
  const placementAttempt = await insertAttempt('derivatives', 'diagnostic', 1);
  await seedGrant('vectors', 'conditional');
  await seedGrant('derivatives', 'conditional', [placementAttempt.attemptId]);
  await seedGrant('linear-algebra', 'confirmed');
  await db.insert(xpEvents).values({
    userId,
    kind: 'knowledge_point',
    sourceKey: 'kp:seed',
    amount: 5,
    earnedAt: now,
    localDate: '2026-01-07',
  });
  const { input, result } = await answer('vectors', 0);
  expect(result.withdrawn).toEqual(['vectors', 'derivatives']);
  const after = await snapshot();
  expect(after.grants.map((grant) => [grant.conceptId, grant.state, grant.reason])).toEqual([
    ['derivatives', 'withdrawn', 'cascade'],
    ['linear-algebra', 'confirmed', 'on_time'],
    ['vectors', 'withdrawn', 'direct_failure'],
  ]);
  for (const record of after.mastery.filter((row) => row.conceptId !== 'linear-algebra')) {
    expect(masteryRank(record.state)).toBeLessThan(masteryRank('assisted'));
    expect(record.provisional).toBe(false);
  }
  expect(after.mastery.find((row) => row.conceptId === 'linear-algebra')?.state).toBe(
    'independent',
  );
  expect([...new Set(activeCards(after.cards).map((card) => card.conceptId))]).toEqual([
    'linear-algebra',
  ]);
  expect(after.attempts).toHaveLength(2);
  expect(after.xp).toHaveLength(1);

  expect(await applyPlacementGrantOutcome(input)).toEqual({
    confirmed: [],
    withdrawn: [],
    targetedReviews: [],
  });
  expect(await snapshot()).toEqual(after);
});

test('new placement credit for a withdrawn topic reactivates its review cards', async () => {
  await seedGrant('vectors', 'conditional');
  await answer('vectors', 0);
  expect(activeCards((await snapshot()).cards)).toEqual([]);
  const [secondRun] = await db
    .insert(diagnosticRuns)
    .values({
      userId,
      kind: 'placement',
      status: 'completed',
      state: {},
      startedAt: now,
      completedAt: now,
    })
    .returning();
  const grants = await recordPlacementGrants({
    store: drizzleLearnerStore(db),
    userId,
    runId: secondRun?.id ?? '',
    state: { courseId: 'fixture-course', answers: [], known: ['vectors'], unknown: [] },
    content,
    now,
  });
  expect(grants.get('vectors')).toBe('conditional');
  const cards = (await snapshot()).cards.filter((card) => card.conceptId === 'vectors');
  expect(cards.length).toBeGreaterThan(0);
  expect(activeCards(cards)).toEqual(cards);
});

test('an interrupted withdrawal changes nothing, and a retry completes it', async () => {
  await seedGrant('vectors', 'conditional');
  await seedGrant('derivatives', 'conditional');
  const before = await snapshot();
  await db.execute(
    sql.raw(`
    CREATE OR REPLACE FUNCTION fail_placement_withdrawal() RETURNS trigger AS $$
    BEGIN RAISE EXCEPTION 'interrupted withdrawal'; END $$ LANGUAGE plpgsql;
    CREATE TRIGGER fail_placement_withdrawal BEFORE INSERT ON mastery_events
    FOR EACH ROW WHEN (NEW.user_id = '${userId}') EXECUTE FUNCTION fail_placement_withdrawal();
  `),
  );
  let failed: { input: Parameters<typeof applyPlacementGrantOutcome>[0] } | undefined;
  try {
    const { attemptId, exercise } = await insertAttempt('vectors', 'review', 0);
    const input = {
      store: drizzleLearnerStore(db),
      userId,
      content,
      exerciseId: exercise.id,
      attemptId,
      mode: 'review',
      correct: 0,
      hintsUsed: 0,
      attemptNo: 1,
      gradedBy: 'deterministic',
      now,
    };
    failed = { input };
    await expect(applyPlacementGrantOutcome(input)).rejects.toThrow();
  } finally {
    await db.execute(
      sql.raw(`
      DROP TRIGGER IF EXISTS fail_placement_withdrawal ON mastery_events;
      DROP FUNCTION IF EXISTS fail_placement_withdrawal();
    `),
    );
  }
  const interrupted = await snapshot();
  expect(interrupted.grants).toEqual(before.grants);
  expect(interrupted.mastery).toEqual(before.mastery);
  expect(interrupted.cards).toEqual(before.cards);
  if (!failed) throw new Error('Withdrawal did not run');
  expect((await applyPlacementGrantOutcome(failed.input)).withdrawn).toEqual([
    'vectors',
    'derivatives',
  ]);
});

test('a wrong review on a dependent topic queues a targeted review before any withdrawal', async () => {
  await seedGrant('vectors', 'conditional');
  const downstream = await answer('derivatives', 0);
  expect(downstream.result).toEqual({ confirmed: [], withdrawn: [], targetedReviews: ['vectors'] });
  const [flag] = await db
    .select()
    .from(remediationFlags)
    .where(and(eq(remediationFlags.userId, userId), eq(remediationFlags.status, 'open')));
  expect(flag).toMatchObject({ conceptId: 'derivatives', targetPrereqId: 'vectors' });
  const [grant] = await db.select().from(placementGrants).where(eq(placementGrants.userId, userId));
  expect(grant?.state).toBe('conditional');

  const targeted = await answer('vectors', 1);
  expect(targeted.result.confirmed).toEqual(['vectors']);
  const [confirmed] = await db
    .select()
    .from(placementGrants)
    .where(eq(placementGrants.userId, userId));
  expect(confirmed).toMatchObject({ state: 'confirmed', reason: 'confirmed_by_answer' });
  expect((await repo.store.listMastery(userId)).every((record) => !record.provisional)).toBe(true);
});

test('studied and confirmed topics are never withdrawn', async () => {
  await seedGrant('vectors', 'conditional');
  await seedGrant('linear-algebra', 'confirmed');
  await db.insert(lessonRuns).values({ userId, conceptId: 'vectors', startedAt: now });
  expect((await answer('vectors', 0)).result.withdrawn).toEqual([]);
  expect((await answer('linear-algebra', 0)).result.withdrawn).toEqual([]);
  const grants = await db.select().from(placementGrants).where(eq(placementGrants.userId, userId));
  expect(grants.map((grant) => grant.state).sort()).toEqual(['conditional', 'confirmed']);
});

test('a failed targeted review withdraws the conditional prerequisite, once', async () => {
  await seedGrant('vectors', 'conditional');
  expect((await answer('derivatives', 0)).result.targetedReviews).toEqual(['vectors']);
  const failed = await answer('vectors', 0);
  expect(failed.result.withdrawn).toEqual(['vectors']);
  const after = await snapshot();
  expect(after.grants[0]).toMatchObject({ state: 'withdrawn', reason: 'direct_failure' });
  expect(after.flags.every((flag) => flag.status === 'resolved')).toBe(true);
  await applyPlacementGrantOutcome(failed.input);
  expect(await snapshot()).toEqual(after);
});

test('later answers on a withdrawn topic do not restore credit before its lesson', async () => {
  await seedGrant('vectors', 'conditional');
  await seedGrant('linear-algebra', 'conditional');
  await answer('vectors', 0);
  await db
    .update(reviewCards)
    .set({ suspendedAt: null })
    .where(and(eq(reviewCards.userId, userId), eq(reviewCards.conceptId, 'vectors')));
  for (const record of await repo.store.listMastery(userId)) {
    if (record.conceptId === 'vectors')
      await repo.store.saveMastery(userId, { ...record, state: 'assisted' });
  }
  await answer('vectors', 1);
  const after = await snapshot();
  expect(activeCards(after.cards).some((card) => card.conceptId === 'vectors')).toBe(false);
  expect(
    after.mastery
      .filter((record) => record.conceptId === 'vectors')
      .every((record) => masteryRank(record.state) < masteryRank('assisted') && !record.inferred),
  ).toBe(true);
  expect(after.grants.find((grant) => grant.conceptId === 'vectors')?.state).toBe('withdrawn');
});

test('withdrawal suspends cards, keeps review logs, and skips planned work the topic no longer unlocks', async () => {
  await seedGrant('vectors', 'conditional');
  const [reviewed] = await db
    .select({ id: reviewCards.id })
    .from(reviewCards)
    .where(and(eq(reviewCards.userId, userId), eq(reviewCards.conceptId, 'vectors')))
    .limit(1);
  if (!reviewed) throw new Error('Missing seeded card');
  await db.insert(reviewLogs).values({ cardId: reviewed.id, rating: 'good', fsrsLog: {} });
  const [session] = await db
    .insert(studySessions)
    .values({ userId, plannedMinutes: 30 })
    .returning();
  if (!session) throw new Error('Could not insert session');
  const [activity] = await db
    .insert(sessionActivities)
    .values({
      sessionId: session.id,
      idx: 0,
      kind: 'learn',
      conceptId: 'derivatives',
      plannedMinutes: 20,
    })
    .returning();
  if (!activity) throw new Error('Could not insert activity');

  expect((await answer('vectors', 0)).result.withdrawn).toEqual(['vectors']);
  const cards = await db
    .select({ id: reviewCards.id, suspendedAt: reviewCards.suspendedAt })
    .from(reviewCards)
    .where(and(eq(reviewCards.userId, userId), eq(reviewCards.conceptId, 'vectors')));
  expect(cards.map((card) => card.id)).toContain(reviewed.id);
  expect(cards.every((card) => card.suspendedAt?.getTime() === now.getTime())).toBe(true);
  expect(await db.select().from(reviewLogs).where(eq(reviewLogs.cardId, reviewed.id))).toHaveLength(
    1,
  );
  expect(
    (await repo.store.listReviewCards(userId, ['vectors'], { activeOnly: true })).some(
      (card) => card.conceptId === 'vectors',
    ),
  ).toBe(false);
  const [skipped] = await db
    .select({ status: sessionActivities.status })
    .from(sessionActivities)
    .where(eq(sessionActivities.id, activity.id));
  expect(skipped?.status).toBe('skipped');
});
