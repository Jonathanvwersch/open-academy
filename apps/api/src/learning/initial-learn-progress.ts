import { and, desc, eq } from 'drizzle-orm';
import type { IndexedLesson } from '../content/types.js';
import type { Database } from '../db/client.js';
import { attempts } from '../db/schema.js';
import { attemptAllowsRetry } from './retry.js';
import type { PlannedActivity } from './scheduler.js';

export async function initialLearnProgress(
  db: Database,
  userId: string,
  activity: Pick<PlannedActivity, 'kind' | 'conceptId' | 'exerciseIds'>,
  lesson: IndexedLesson | undefined,
) {
  const finalExerciseId = lesson?.final;
  if (
    activity.kind !== 'learn' ||
    !activity.conceptId ||
    !lesson?.knowledge_points?.length ||
    !finalExerciseId ||
    !activity.exerciseIds.includes(finalExerciseId)
  ) {
    return undefined;
  }

  const previousAttempts = await db
    .select({
      mode: attempts.mode,
      attemptNo: attempts.attemptNo,
      correct: attempts.correct,
      feedback: attempts.feedback,
      createdAt: attempts.createdAt,
    })
    .from(attempts)
    .where(
      and(
        eq(attempts.userId, userId),
        eq(attempts.exerciseId, finalExerciseId),
        eq(attempts.conceptId, activity.conceptId),
      ),
    )
    .orderBy(desc(attempts.createdAt), desc(attempts.attemptNo));
  const latestFinalizedAttempt = previousAttempts.find((attempt) => !attemptAllowsRetry(attempt));
  if (!latestFinalizedAttempt) return undefined;

  return {
    completedExerciseIds: [finalExerciseId],
    outcomes: {
      [finalExerciseId]: latestFinalizedAttempt.correct > 0 ? 'correct' : 'incorrect',
    },
  };
}
