import { describeLearnerStoreContract } from '@academy/aesop/store/learner-store.contract';
import { eq, inArray } from 'drizzle-orm';
import { afterAll } from 'vitest';
import { env } from '../../src/config.js';
import { createDb } from '../../src/db/client.js';
import { drizzleLearnerStore } from '../../src/db/learner-store.js';
import { remediationFlags, users } from '../../src/db/schema.js';

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
