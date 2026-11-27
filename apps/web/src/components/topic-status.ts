import type { CourseTopicStatus } from '@academy/aesop/api/course';

export const topicStatusLabels: Record<CourseTopicStatus, string> = {
  not_started: 'Not started',
  in_progress: 'In progress',
  quiz: 'Quiz not passed',
  complete: 'Complete',
  locked: 'Locked',
};

export function topicStatusClasses(status: CourseTopicStatus) {
  return status === 'complete'
    ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
    : status === 'quiz'
      ? 'bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300'
      : 'bg-secondary text-secondary-foreground';
}

export const completeTopicNodeClasses =
  'border-emerald-700 bg-emerald-50 text-emerald-700 dark:border-emerald-300 dark:bg-emerald-950/40 dark:text-emerald-300';
