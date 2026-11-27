import type { ContentIndex } from '../course/types.js';

export interface ReviewTopic {
  conceptId: string;
  title: string;
}

export function reviewActivityReason(reason: unknown) {
  return (reason ?? {}) as Record<string, unknown> & {
    topicIds?: string[];
    removedQuestions?: boolean;
    fireAppliedTopicIds?: string[];
  };
}

export function attemptedExerciseIdsByActivity(
  attempts: readonly { activityId: string | null; exerciseId: string }[],
): Map<string, Set<string>> {
  const attemptedByActivity = new Map<string, Set<string>>();
  for (const attempt of attempts) {
    if (!attempt.activityId) continue;
    const exerciseIds = attemptedByActivity.get(attempt.activityId) ?? new Set();
    exerciseIds.add(attempt.exerciseId);
    attemptedByActivity.set(attempt.activityId, exerciseIds);
  }
  return attemptedByActivity;
}

export function reviewTopicsForActivity(
  activity: { exerciseIds: readonly string[]; status?: string },
  content: ContentIndex,
  attemptedExerciseIds: ReadonlySet<string> = new Set(),
): ReviewTopic[] {
  const exerciseIds =
    activity.status === 'in_progress'
      ? activity.exerciseIds.filter((exerciseId) => !attemptedExerciseIds.has(exerciseId))
      : activity.exerciseIds;
  const seen = new Set<string>();
  return exerciseIds.flatMap((exerciseId) => {
    const conceptId = content.exercisesById.get(exerciseId)?.concept;
    if (!conceptId || seen.has(conceptId)) return [];
    seen.add(conceptId);
    return [{ conceptId, title: content.conceptsById.get(conceptId)?.title ?? conceptId }];
  });
}
