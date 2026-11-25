import { localDateKey } from '@academy/aesop/progress/xp';
import { and, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { drizzleLearnerStore } from '../db/learner-store.js';
import { attempts, sessionActivities } from '../db/schema.js';

interface SessionActivityList {
  activities: Array<{ id: string; idx: number; status: string }>;
}

export async function updateActivityAndAdvance(
  db: Database,
  input: {
    activityId: string;
    completed: boolean;
    now: Date;
    session?: SessionActivityList;
    exerciseIds?: string[];
    progress?: unknown;
    userId?: string;
    timeZone?: string;
    knowledgePointActivity?: boolean;
  },
) {
  await db
    .update(sessionActivities)
    .set({
      ...(input.exerciseIds ? { exerciseIds: input.exerciseIds } : {}),
      ...(input.progress ? { progress: input.progress } : {}),
      status: input.completed ? 'completed' : 'in_progress',
      completedAt: input.completed ? input.now : null,
    })
    .where(eq(sessionActivities.id, input.activityId));
  if (!input.completed) return;
  if (!input.knowledgePointActivity && input.userId && input.timeZone) {
    const [activity] = await db
      .select()
      .from(sessionActivities)
      .where(eq(sessionActivities.id, input.activityId))
      .limit(1);
    const activityAttempts = await db
      .select({ correct: attempts.correct })
      .from(attempts)
      .where(and(eq(attempts.activityId, input.activityId), eq(attempts.userId, input.userId)));
    if (activity && activity.kind !== 'lab' && activityAttempts.length > 0) {
      const meanCorrectness =
        activityAttempts.reduce((total, attempt) => total + attempt.correct, 0) /
        activityAttempts.length;
      await drizzleLearnerStore(db).insertXpEventOnce(input.userId, {
        kind: 'activity',
        sourceKey: `activity:${input.activityId}`,
        conceptId: activity.conceptId,
        amount: Math.round(activity.plannedMinutes * meanCorrectness),
        earnedAt: input.now,
        localDate: localDateKey(input.now, input.timeZone),
      });
    }
  }
  const nextActivity = input.session?.activities
    .filter((activity) => activity.status === 'planned')
    .sort((left, right) => left.idx - right.idx)[0];
  if (!nextActivity) return;
  await db
    .update(sessionActivities)
    .set({ status: 'in_progress', startedAt: input.now })
    .where(eq(sessionActivities.id, nextActivity.id));
}
