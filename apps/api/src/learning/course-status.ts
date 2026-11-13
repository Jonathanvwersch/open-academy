import type { MasteryState } from './types.js';
import { masteryRank } from './types.js';

export type CourseTopicStatus = 'locked' | 'not_started' | 'in_progress' | 'quiz' | 'complete';

const masteryLabels: Record<MasteryState, string> = {
  not_assessed: 'Not started',
  introduced: 'Attempted',
  assisted: 'Familiar',
  independent: 'Proficient',
  retained: 'Mastered',
};

export function lowestMasteryState(states: readonly MasteryState[]): MasteryState {
  return states.length
    ? states.reduce((lowest, state) => (masteryRank(state) < masteryRank(lowest) ? state : lowest))
    : 'not_assessed';
}

export function masteryLabel(state: MasteryState): string {
  return masteryLabels[state];
}

export function topicIsComplete(
  lessonRunStatus: 'in_progress' | 'needs_retry' | 'quiz' | 'completed' | undefined,
  dimensionStates: readonly MasteryState[],
): boolean {
  if (lessonRunStatus) return lessonRunStatus === 'completed';
  return (
    dimensionStates.length > 0 &&
    dimensionStates.every((state) => masteryRank(state) >= masteryRank('assisted'))
  );
}

export function topicStatus(input: {
  lessonRunStatus?: 'in_progress' | 'needs_retry' | 'quiz' | 'completed';
  dimensionStates: readonly MasteryState[];
  prerequisites: readonly { strength: 'hard' | 'soft'; done: boolean }[];
}): CourseTopicStatus {
  if (topicIsComplete(input.lessonRunStatus, input.dimensionStates)) return 'complete';

  const started =
    input.lessonRunStatus !== undefined ||
    input.dimensionStates.some((state) => state !== 'not_assessed');
  if (
    !started &&
    input.prerequisites.some(
      (prerequisite) => prerequisite.strength === 'hard' && !prerequisite.done,
    )
  ) {
    return 'locked';
  }
  if (input.lessonRunStatus === 'quiz') return 'quiz';
  return started ? 'in_progress' : 'not_started';
}
