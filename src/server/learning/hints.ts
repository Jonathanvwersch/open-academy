export interface HintAttemptBoundary {
  userId: string;
  exerciseId: string;
  activityId: string | null;
  createdAt: Date;
}

export interface HintEventBoundary extends HintAttemptBoundary {
  level?: number;
}

export function countHintsSincePreviousAttempt(input: {
  userId: string;
  exerciseId: string;
  activityId?: string;
  attempts: HintAttemptBoundary[];
  hints: HintEventBoundary[];
}): number {
  const matchesScope = (item: HintAttemptBoundary) =>
    item.userId === input.userId &&
    item.exerciseId === input.exerciseId &&
    (!input.activityId || item.activityId === input.activityId);
  const previousAttempt = input.attempts
    .filter(matchesScope)
    .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0];
  const hintsSinceAttempt = input.hints.filter(
    (hint) =>
      matchesScope(hint) &&
      (!previousAttempt || hint.createdAt.getTime() > previousAttempt.createdAt.getTime()),
  );
  return hintsSinceAttempt.some((hint) => hint.level === 5) ? 5 : hintsSinceAttempt.length;
}
