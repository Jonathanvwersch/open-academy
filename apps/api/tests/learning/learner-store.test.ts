import { newReviewCard } from '@academy/aesop/memory/fsrs';
import { describeLearnerStoreContract } from '@academy/aesop/store/learner-store.contract';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, expect, test } from 'vitest';
import { env } from '../../src/config.js';
import { createDb } from '../../src/db/client.js';
import { drizzleLearnerStore } from '../../src/db/learner-store.js';
import { remediationFlags, reviewCards, users } from '../../src/db/schema.js';

const db = createDb(env.TEST_DATABASE_URL);
const learners: string[] = [];

afterAll(async () => {
  try {
    await db.delete(users).where(inArray(users.id, learners));
  } finally {
    await db.$client.end();
  }
});

describeLearnerStoreContract('drizzleLearnerStore', async () => {
  const [{ id: learnerId }] = await db
    .insert(users)
    .values({ displayName: 'Store test' })
    .returning();
  learners.push(learnerId);
  return {
    store: drizzleLearnerStore(db),
    learnerId,
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
