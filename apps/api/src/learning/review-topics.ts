import type { ContentIndex } from '../content/types.js';

export interface ReviewTopic {
  conceptId: string;
  title: string;
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
