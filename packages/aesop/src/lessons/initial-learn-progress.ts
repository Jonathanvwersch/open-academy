import type { IndexedLesson } from '../course/types.js';
import { attemptAllowsRetry } from '../memory/retry.js';
import type { PlannedActivity } from '../planner/scheduler.js';
import type { LessonStore } from '../store/lesson-store.js';

export function isExplainItBeforeQuiz(lesson: IndexedLesson | undefined, exerciseId: string) {
  return Boolean(lesson?.knowledge_points?.length && lesson.final === exerciseId);
}

export async function initialLearnProgress(
  store: LessonStore,
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

  const lessonRun = await store.getLessonRun(userId, { conceptId: activity.conceptId });
  if (!lessonRun) return undefined;

  const previousAttempts = await store.listAttempts(userId, {
    exerciseIds: [finalExerciseId],
    conceptId: activity.conceptId,
    since: lessonRun.startedAt,
    order: 'final_evidence',
  });
  const latestFinalizedAttempt = previousAttempts.find((attempt) => !attemptAllowsRetry(attempt));
  if (!latestFinalizedAttempt) return undefined;

  return {
    completedExerciseIds: [finalExerciseId],
    outcomes: {
      [finalExerciseId]: latestFinalizedAttempt.correct > 0 ? 'correct' : 'incorrect',
    },
  };
}
