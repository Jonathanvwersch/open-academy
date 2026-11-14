import type { ContentIndex } from '../content/types.js';
import type { SchedulerState } from './scheduler.js';
import type { MasteryRecord } from './types.js';

export function hasContentDimension(
  content: ContentIndex,
  conceptId: string,
  dimension: string,
): boolean {
  return (
    content.conceptsById
      .get(conceptId)
      ?.dimensions.includes(dimension as MasteryRecord['dimension']) ?? false
  );
}

export function filterMasteryRecordsForContent(
  content: ContentIndex,
  records: MasteryRecord[],
): MasteryRecord[] {
  return records.filter((record) =>
    hasContentDimension(content, record.conceptId, record.dimension),
  );
}

export function filterSchedulerStateForContent(
  content: ContentIndex,
  state: SchedulerState,
): SchedulerState {
  return {
    ...state,
    activeCourseId: content.coursesById.has(state.activeCourseId ?? '')
      ? state.activeCourseId
      : null,
    mastery: filterMasteryRecordsForContent(content, state.mastery),
    cards: state.cards.filter((card) =>
      hasContentDimension(content, card.conceptId, card.dimension),
    ),
    recentAttempts: state.recentAttempts.filter((attempt) => {
      const exercise = content.exercisesById.get(attempt.exerciseId);
      return (
        hasContentDimension(content, attempt.conceptId, attempt.dimension ?? '') &&
        exercise?.concept === attempt.conceptId
      );
    }),
    remediationFlags: state.remediationFlags.filter(
      (flag) =>
        content.conceptsById.has(flag.conceptId) &&
        (!flag.targetPrereqId || content.conceptsById.has(flag.targetPrereqId)),
    ),
    projectProgress: state.projectProgress.filter((project) =>
      content.projectsById.has(project.projectId),
    ),
    completedPaperIds: state.completedPaperIds.filter((paperId) => content.papersById.has(paperId)),
    lessonRuns: state.lessonRuns?.filter((run) => content.conceptsById.has(run.conceptId)),
    ...(state.currentProjectId && !content.projectsById.has(state.currentProjectId)
      ? { currentProjectId: undefined }
      : {}),
    ...(state.inProgressConceptId && !content.conceptsById.has(state.inProgressConceptId)
      ? { inProgressConceptId: undefined }
      : {}),
    ...(state.usedExerciseIds
      ? {
          usedExerciseIds: state.usedExerciseIds.filter((exerciseId) =>
            content.exercisesById.has(exerciseId),
          ),
        }
      : {}),
  };
}

export function sessionActivityIsInContent(
  content: ContentIndex,
  activity: {
    conceptId?: string | null;
    projectId?: string | null;
    exerciseIds: string[];
  },
): boolean {
  return (
    (!activity.conceptId || content.conceptsById.has(activity.conceptId)) &&
    (!activity.projectId || content.projectsById.has(activity.projectId)) &&
    activity.exerciseIds.every((exerciseId) => content.exercisesById.has(exerciseId))
  );
}
