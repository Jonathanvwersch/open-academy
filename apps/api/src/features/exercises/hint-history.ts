import { countHintsSincePreviousAttempt } from '@academy/aesop/memory/hints';
import type { Database } from '../../db/client.js';
import { drizzleLearnerStore } from '../../db/learner-store.js';
export async function hintsSincePreviousAttempt(
  db: Database,
  userId: string,
  exerciseId: string,
  activityId?: string,
): Promise<number> {
  const { attempts, hints } = await drizzleLearnerStore(db).readHintEvidence(
    userId,
    exerciseId,
    activityId || undefined,
  );
  const scope = { userId, exerciseId };
  return countHintsSincePreviousAttempt({
    userId,
    exerciseId,
    activityId,
    attempts: attempts.map((row) => ({ ...row, ...scope })),
    hints: hints.map((row) => ({ ...row, ...scope })),
  });
}
