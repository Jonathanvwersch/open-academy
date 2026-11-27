import type { LessonPayload, LessonRunPayload } from '@open-academy/engine/api/lessons';
import type { SessionActivity } from '@open-academy/engine/api/sessions';

const uncontinuedLesson = (item: SessionActivity) =>
  item.kind === 'learn' &&
  item.status === 'completed' &&
  Boolean(item.conceptId) &&
  !item.progress?.quizContinued;

const completedFinal = (item: SessionActivity) =>
  item.kind === 'learn' &&
  (item.status === 'completed' || item.status === 'in_progress') &&
  item.progress?.lessonRunnerContinued &&
  !item.progress.finalQuestionContinued &&
  (item.progress.completedExerciseIds ?? []).some((id) => item.exerciseIds.includes(id));

function activeActivity(activities: SessionActivity[]) {
  return (
    activities.find((item) => item.status === 'in_progress') ??
    activities.find((item) => item.status === 'planned')
  );
}

/** Only these activities can be displayed on arrival; later planned work must not block them. */
export function sessionActivityCandidates(activities: SessionActivity[], requestedId?: string) {
  const active = activeActivity(activities);
  return activities.filter(
    (item) =>
      item === active ||
      uncontinuedLesson(item) ||
      completedFinal(item) ||
      (active &&
        item.id === requestedId &&
        ['completed', 'in_progress', 'planned'].includes(item.status)),
  );
}

export function usesLessonRunner(
  activity: SessionActivity | undefined,
  lesson: LessonPayload | null,
) {
  return Boolean(
    activity?.kind === 'learn' &&
      activity.conceptId &&
      lesson?.knowledge_points?.length &&
      (!activity.progress?.lessonRunnerContinued ||
        (activity.progress.finalQuestionContinued && !activity.progress.quizContinued)),
  );
}

export function selectSessionActivity(
  activities: SessionActivity[],
  runs: ReadonlyMap<
    string,
    Pick<NonNullable<LessonRunPayload['run']>, 'status'> | null | undefined
  >,
  requestedId?: string,
) {
  const lesson = activities.find((item) => {
    if (!uncontinuedLesson(item) || !item.conceptId) return false;
    const run = runs.get(item.conceptId);
    return (
      run?.status === 'completed' ||
      (run?.status === 'quiz' &&
        (item.progress?.finalQuestionContinued || item.exerciseIds.length === 0))
    );
  });
  const final = activities.find(completedFinal);
  const requestedActivity = activities.find(
    (item) =>
      item.id === requestedId && ['completed', 'in_progress', 'planned'].includes(item.status),
  );
  const requestedCompletedActivity = activities.find(
    (item) => item.id === requestedId && item.status === 'completed',
  );
  const active = activeActivity(activities);
  return {
    activity:
      lesson ?? final ?? (requestedActivity && active ? requestedActivity : undefined) ?? active,
    completedFinal: final,
    requestedCompletedActivity,
  };
}
