import { localDateKey } from '../progress/xp.js';
import type { SessionStore } from '../store/session-store.js';

interface SessionActivityList {
  activities: Array<{ id: string; idx: number; status: string }>;
}

export async function updateActivityAndAdvance(
  store: SessionStore,
  input: {
    activityId: string;
    completed: boolean;
    now: Date;
    session?: SessionActivityList;
    exerciseIds?: string[];
    progress?: unknown;
    userId: string;
    timeZone?: string;
    knowledgePointActivity?: boolean;
  },
) {
  await store.patchActivities(
    input.userId,
    { ids: [input.activityId] },
    {
      ...(input.exerciseIds ? { exerciseIds: input.exerciseIds } : {}),
      ...(input.progress ? { progress: input.progress } : {}),
      status: input.completed ? 'completed' : 'in_progress',
      completedAt: input.completed ? input.now : null,
    },
  );
  if (!input.completed) return;
  if (!input.knowledgePointActivity && input.timeZone) {
    const [activity] = await store.listActivities(input.userId, { ids: [input.activityId] });
    const activityAttempts = await store.listAttempts(input.userId, {
      activityIds: [input.activityId],
    });
    if (activity && activity.kind !== 'lab' && activityAttempts.length > 0) {
      const meanCorrectness =
        activityAttempts.reduce((total, attempt) => total + attempt.correct, 0) /
        activityAttempts.length;
      await store.insertXpEventOnce(input.userId, {
        kind: 'activity',
        sourceKey: `activity:${input.activityId}`,
        conceptId: activity.conceptId,
        amount: Math.round(activity.plannedMinutes * meanCorrectness),
        earnedAt: input.now,
        localDate: localDateKey(input.now, input.timeZone),
      });
    }
  }
  await advanceActivity(store, input.userId, input.session, input.now);
}

export async function advanceActivity(
  store: SessionStore,
  learnerId: string,
  session: SessionActivityList | undefined,
  now: Date,
) {
  const nextActivity = session?.activities
    .filter((activity) => activity.status === 'planned')
    .sort((left, right) => left.idx - right.idx)[0];
  if (nextActivity) {
    await store.patchActivities(
      learnerId,
      { ids: [nextActivity.id] },
      {
        status: 'in_progress',
        startedAt: now,
      },
    );
  }
}
