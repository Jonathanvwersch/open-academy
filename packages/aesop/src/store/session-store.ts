import type { TopicSpeedEvidence } from '../memory/speed.js';
import type { MasteryRecord } from '../memory/types.js';
import type { ActivityKind, SchedulerState } from '../planner/scheduler.js';
import type { SessionKind } from '../planner/session-budget.js';
import type { Attempt, CoreStore, Id, NewRow } from './core-store.js';
import type { StoredReviewCard } from './learner-store.js';

export type RowEdit<T, K extends keyof T = never> = Partial<Omit<T, 'id' | K>>;

export type Session = {
  id: Id;
  kind: SessionKind;
  plannedMinutes: number;
  startedAt: Date | null;
  endedAt: Date | null;
  status: 'planned' | 'active' | 'completed' | 'abandoned';
  plan: unknown;
  activeSeconds: number;
};

export type Activity = {
  id: Id;
  sessionId: Id;
  idx: number;
  kind: ActivityKind;
  conceptId: Id | null;
  projectId: Id | null;
  exerciseIds: Id[];
  plannedMinutes: number;
  status: 'planned' | 'in_progress' | 'completed' | 'skipped';
  progress: unknown;
  reason: unknown;
  startedAt: Date | null;
  completedAt: Date | null;
};

export type RemediationFlag = {
  id: Id;
  conceptId: Id;
  targetPrereqId: Id | null;
  status: 'open' | 'resolved';
  openedByAttemptId: Id | null;
  createdAt: Date;
  resolvedAt: Date | null;
};

export type SessionQuery = { ids?: readonly Id[]; status?: Session['status'] };
export type ActivityQuery = {
  ids?: readonly Id[];
  sessionIds?: readonly Id[];
  statuses?: readonly Activity['status'][];
  conceptId?: Id;
};
export type ActivityExpected = {
  statuses?: readonly Activity['status'][];
  exerciseIds?: readonly Id[];
  reason?: unknown;
};
export type SchedulerRead = {
  now: Date;
  recallExerciseIds: readonly Id[];
  skip?: readonly ('mastery' | 'lessonRuns' | 'projectProgress')[];
};
export type SchedulerFacts = {
  mastery?: MasteryRecord[];
  lessonRuns?: SchedulerState['lessonRuns'];
  projectProgress?: SchedulerState['projectProgress'];
  cards: StoredReviewCard[];
  topicSpeeds: TopicSpeedEvidence[];
  recentAttempts: Attempt[];
  exerciseLastSeen: Array<{ exerciseId: string; lastAt: Date }>;
  flags: RemediationFlag[];
  paperProgress: { paperId: Id; completedAt: Date | null }[];
  learnMinutes: { conceptId: Id | null; plannedMinutes: number }[];
  reviewLogFacts: { conceptId: Id; createdAt: Date }[];
  completedReviewLogFacts: {
    activityId: Id | null;
    conceptId: Id;
    rating: string;
    createdAt: Date;
  }[];
  recallAttempts: Pick<Attempt, 'exerciseId' | 'correct' | 'createdAt'>[];
};

export interface SessionStore extends CoreStore {
  listSessions(learnerId: Id, query: SessionQuery): Promise<Session[]>;
  lockSession(learnerId: Id, sessionId: Id): Promise<Session | undefined>;
  insertSession(learnerId: Id, session: NewRow<Session>): Promise<Session>;
  patchSessions(learnerId: Id, query: SessionQuery, patch: RowEdit<Session>): Promise<void>;
  listActivities(learnerId: Id, query: ActivityQuery): Promise<Activity[]>;
  insertActivities(
    learnerId: Id,
    sessionId: Id,
    rows: readonly NewRow<Omit<Activity, 'sessionId'>>[],
  ): Promise<Activity[]>;
  patchActivities(
    learnerId: Id,
    query: ActivityQuery,
    patch: RowEdit<Activity, 'sessionId'>,
    expected?: ActivityExpected,
  ): Promise<Activity[]>;
  deleteActivities(learnerId: Id, query: ActivityQuery): Promise<void>;
  readSchedulerFacts(learnerId: Id, query: SchedulerRead): Promise<SchedulerFacts>;
}
