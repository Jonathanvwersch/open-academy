import type { Id } from './core-store.js';
import type { FlowStore } from './flow-store.js';
import type { MasteryEventRecord } from './learner-store.js';
import type { LessonProblem } from './lesson-store.js';
import type { Activity } from './session-store.js';

export type CourseProjectProgress = {
  projectId: Id;
  status: 'not_started' | 'in_progress' | 'completed';
};
export type CourseProjectSubmission = {
  id: Id;
  userId: Id;
  projectId: Id;
  results: unknown;
  passed: number;
  total: number;
  metrics: Record<string, number>;
  createdAt: Date;
};
export type CoursePaperProgress = { paperId: Id; completedAt: Date | null };
export type PaperProgressRecord = {
  userId: Id;
  paperId: Id;
  lastPage: number;
  notes: Record<string, string>;
  summary: string | null;
  summaryJudgement: unknown;
  completedAt: Date | null;
  updatedAt: Date;
};
export type PaperProgressPatch = Pick<PaperProgressRecord, 'paperId' | 'updatedAt'> &
  Partial<
    Pick<PaperProgressRecord, 'lastPage' | 'notes' | 'summary' | 'summaryJudgement' | 'completedAt'>
  >;
export type CourseMasteryEvent = Pick<
  MasteryEventRecord,
  'conceptId' | 'fromState' | 'toState' | 'createdAt'
>;

export interface CourseStore extends FlowStore {
  listProjectProgress(learnerId: Id): Promise<CourseProjectProgress[]>;
  setProjectProgress(
    learnerId: Id,
    input: {
      projectId: Id;
      status: CourseProjectProgress['status'];
      completedAt: Date | null;
    },
  ): Promise<void>;
  listProjectSubmissions(
    learnerId: Id,
    query?: { limit?: number },
  ): Promise<CourseProjectSubmission[]>;
  addProjectSubmission(
    learnerId: Id,
    input: Omit<CourseProjectSubmission, 'id' | 'userId'>,
  ): Promise<CourseProjectSubmission>;
  listPaperProgress(learnerId: Id): Promise<CoursePaperProgress[]>;
  getPaperProgress(learnerId: Id, paperId: Id): Promise<PaperProgressRecord | undefined>;
  savePaperProgress(learnerId: Id, patch: PaperProgressPatch): Promise<PaperProgressRecord>;
  listCompletedActivities(learnerId: Id, since: Date): Promise<Activity[]>;
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
