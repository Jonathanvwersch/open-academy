import type { ContentIndex } from '../course/types.js';
import type { MasteryRecord } from '../memory/types.js';
import type { SchedulerState } from '../planner/scheduler.js';

export function filterMasteryRecordsForContent(
  content: ContentIndex,
  records: MasteryRecord[],
): MasteryRecord[] {
  return records.filter((record) => content.conceptsById.has(record.conceptId));
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
    studyCourseIds: state.studyCourseIds.filter((courseId) => content.coursesById.has(courseId)),
    recentLearnMinutesByConcept: Object.fromEntries(
      Object.entries(state.recentLearnMinutesByConcept).filter(([conceptId]) =>
        content.conceptsById.has(conceptId),
      ),
    ),
    mastery: filterMasteryRecordsForContent(content, state.mastery),
    cards: state.cards.filter((card) => content.conceptsById.has(card.conceptId)),
    reviewedTodayConceptIds: state.reviewedTodayConceptIds.filter((conceptId) =>
      content.conceptsById.has(conceptId),
    ),
    completedReviewRatingsToday: state.completedReviewRatingsToday?.filter(({ conceptId }) =>
      content.conceptsById.has(conceptId),
    ),
    recentAttempts: state.recentAttempts.filter((attempt) => {
      const exercise = content.exercisesById.get(attempt.exerciseId);
      return content.conceptsById.has(attempt.conceptId) && exercise?.concept === attempt.conceptId;
    }),
    exerciseLastSeen: new Map(
      [...state.exerciseLastSeen].filter(([id]) => content.exercisesById.has(id)),
    ),
    ...(state.recallAttempts
      ? {
          recallAttempts: state.recallAttempts.filter(
            (attempt) => content.exercisesById.get(attempt.exerciseId)?.role === 'recall',
          ),
        }
      : {}),
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
