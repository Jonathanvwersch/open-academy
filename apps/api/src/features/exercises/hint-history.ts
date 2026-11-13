import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { attempts, hintEvents } from '../../db/schema.js';
import { countHintsSincePreviousAttempt } from '../../learning/hints.js';
export async function hintsSincePreviousAttempt(
  db: Database,
  userId: string,
  exerciseId: string,
  activityId?: string,
): Promise<number> {
  const scope = activityId ? eq(attempts.activityId, activityId) : sql`true`;
  const hintScope = activityId ? eq(hintEvents.activityId, activityId) : sql`true`;
  const [attemptRows, hintRows] = await Promise.all([
    db
      .select({
        userId: attempts.userId,
        exerciseId: attempts.exerciseId,
        activityId: attempts.activityId,
        createdAt: attempts.createdAt,
      })
      .from(attempts)
      .where(and(eq(attempts.userId, userId), eq(attempts.exerciseId, exerciseId), scope)),
    db
      .select({
        userId: hintEvents.userId,
        exerciseId: hintEvents.exerciseId,
        activityId: hintEvents.activityId,
        createdAt: hintEvents.createdAt,
        level: hintEvents.level,
      })
      .from(hintEvents)
      .where(and(eq(hintEvents.userId, userId), eq(hintEvents.exerciseId, exerciseId), hintScope)),
  ]);
  return countHintsSincePreviousAttempt({
    userId,
    exerciseId,
    activityId,
    attempts: attemptRows,
    hints: hintRows,
  });
}
