import type { Id } from './core-store.js';
import type { FlowStore } from './flow-store.js';
import type { MasteryEventRecord } from './learner-store.js';
import type { LessonProblem } from './lesson-store.js';
import type { Activity } from './session-store.js';

export type CourseProjectProgress = {
  projectId: Id;
  status: 'not_started' | 'in_progress' | 'completed';
};
export type CoursePaperProgress = { paperId: Id; completedAt: Date | null };
export type CourseMasteryEvent = Pick<
  MasteryEventRecord,
  'conceptId' | 'fromState' | 'toState' | 'createdAt'
>;

export interface CourseStore extends FlowStore {
  listProjectProgress(learnerId: Id): Promise<CourseProjectProgress[]>;
  listPaperProgress(learnerId: Id): Promise<CoursePaperProgress[]>;
  listCompletedActivities(learnerId: Id): Promise<Activity[]>;
  listActivityAttemptKeys(
    learnerId: Id,
    activityIds: readonly Id[],
  ): Promise<Array<{ activityId: Id | null; exerciseId: Id }>>;
  listCourseLessonProblems(learnerId: Id, runIds: readonly Id[]): Promise<LessonProblem[]>;
  listCourseMasteryEvents(learnerId: Id, conceptIds: readonly Id[]): Promise<CourseMasteryEvent[]>;
  listDueReviewConcepts(learnerId: Id, before: Date): Promise<Id[]>;
}

type CompletedActivity = { activity: Activity; sessionStartedAt: Date | null };

function compare<T extends number | string>(left: T, right: T) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function compareCompletedActivities(left: CompletedActivity, right: CompletedActivity) {
  const a = left.activity;
  const b = right.activity;
  return (
    compare(a.completedAt?.getTime() ?? Infinity, b.completedAt?.getTime() ?? Infinity) ||
    compare(
      left.sessionStartedAt?.getTime() ?? Infinity,
      right.sessionStartedAt?.getTime() ?? Infinity,
    ) ||
    a.idx - b.idx ||
    compare(a.kind, b.kind) ||
    compare(a.conceptId ?? '', b.conceptId ?? '') ||
    compare(a.projectId ?? '', b.projectId ?? '') ||
    compare(JSON.stringify(a.exerciseIds), JSON.stringify(b.exerciseIds)) ||
    a.plannedMinutes - b.plannedMinutes
  );
}
