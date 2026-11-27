import type { CoreStore } from '../store/core-store.js';
import { countHintsSincePreviousAttempt } from './hints.js';

export async function hintsSincePreviousAttempt(
  store: CoreStore,
  userId: string,
  exerciseId: string,
  activityId?: string,
): Promise<number> {
  const { attempts, hints } = await store.readHintEvidence(
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
