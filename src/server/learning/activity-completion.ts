import { eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { sessionActivities } from '../db/schema.js';

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
  const nextActivity = input.session?.activities
    .filter((activity) => activity.status === 'planned')
    .sort((left, right) => left.idx - right.idx)[0];
  if (!nextActivity) return;
  await db
    .update(sessionActivities)
    .set({ status: 'in_progress', startedAt: input.now })
    .where(eq(sessionActivities.id, nextActivity.id));
}
