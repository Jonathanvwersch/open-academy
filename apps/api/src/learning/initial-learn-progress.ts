import { and, desc, eq, gte } from 'drizzle-orm';
import type { IndexedLesson } from '../content/types.js';
import type { Database } from '../db/client.js';
import { attempts, lessonRuns } from '../db/schema.js';
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

  const [lessonRun] = await db
    .select({ startedAt: lessonRuns.startedAt })
    .from(lessonRuns)
    .where(and(eq(lessonRuns.userId, userId), eq(lessonRuns.conceptId, activity.conceptId)))
    .limit(1);
  if (!lessonRun) return undefined;

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
        gte(attempts.createdAt, lessonRun.startedAt),
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
