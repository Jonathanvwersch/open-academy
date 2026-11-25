import { newReviewCard } from '@academy/aesop/memory/fsrs';
import { describeLearnerStoreContract } from '@academy/aesop/store/learner-store.contract';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, afterEach, expect, test } from 'vitest';
import { env } from '../../src/config.js';
import { createDb } from '../../src/db/client.js';
import { drizzleLearnerStore } from '../../src/db/learner-store.js';
import {
  hintEvents,
  remediationFlags,
  reviewCards,
  sessionActivities,
  studySessions,
  users,
} from '../../src/db/schema.js';

const db = createDb(env.TEST_DATABASE_URL);
const learners: string[] = [];

afterEach(async () => {
  await db.delete(users).where(inArray(users.id, learners.splice(0)));
});

afterAll(async () => {
  await db.$client.end();
});

describeLearnerStoreContract('drizzleLearnerStore', async () => {
  const [{ id: learnerId }, { id: otherLearnerId }] = await db
    .insert(users)
    .values([{ displayName: 'Store test' }, { displayName: 'Other store learner' }])
    .returning();
  learners.push(learnerId, otherLearnerId);
  const [{ id: sessionId }] = await db
    .insert(studySessions)
    .values({ userId: learnerId, plannedMinutes: 5 })
    .returning({ id: studySessions.id });
  const [{ id: activityId }] = await db
    .insert(sessionActivities)
    .values({ sessionId, idx: 0, kind: 'practice', plannedMinutes: 5 })
    .returning({ id: sessionActivities.id });
  const hint = { exerciseId: 'vectors-q1', activityId, text: 'A hint.' };
  await db.insert(hintEvents).values([
    { ...hint, userId: learnerId, level: 5, createdAt: new Date('2026-01-17T12:00:01Z') },
    { ...hint, userId: learnerId, level: 1, createdAt: new Date('2026-01-17T12:00:00Z') },
    { ...hint, userId: otherLearnerId, level: 5, createdAt: new Date('2026-01-19T12:00:00Z') },
  ]);
  return {
    store: drizzleLearnerStore(db),
    learnerId,
    otherLearnerId,
    activityId,
    async addOpenFlag(conceptId, targetPrereqId) {
      await db.insert(remediationFlags).values({ userId: learnerId, conceptId, targetPrereqId });
    },
    async resolveOpenFlag(id) {
      await db
        .update(remediationFlags)
        .set({ status: 'resolved' })
        .where(eq(remediationFlags.id, id));
    },
  };
});

test('the quiz store excludes suspended cards from implicit repetition reads and writes', async () => {
  const [{ id: learnerId }] = await db
    .insert(users)
    .values({ displayName: 'Suspended store test' })
    .returning();
  learners.push(learnerId);
  const dueAt = new Date('2026-01-14T12:00:00.000Z');
  const [{ id }] = await db
    .insert(reviewCards)
    .values({
      userId: learnerId,
      conceptId: 'vectors',
      dimension: 'math',
      fsrs: newReviewCard(dueAt),
      dueAt,
      suspendedAt: dueAt,
    })
    .returning({ id: reviewCards.id });
  const quizStore = drizzleLearnerStore(db, { activeReviewCardsOnly: true });
  const regularStore = drizzleLearnerStore(db);
  const nextDueAt = new Date('2026-01-15T12:00:00.000Z');
  expect(await quizStore.listReviewCards(learnerId, ['vectors'])).toEqual([]);
  expect(await regularStore.listReviewCards(learnerId, ['vectors'])).toHaveLength(1);
  expect(
    await quizStore.updateReviewCardIfDue(learnerId, id, dueAt, {
      fsrs: newReviewCard(nextDueAt),
      dueAt: nextDueAt,
    }),
  ).toBe(false);
  expect((await regularStore.getReviewCard(learnerId, 'vectors', 'math'))?.dueAt).toEqual(dueAt);
});
