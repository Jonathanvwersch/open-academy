import type { LearnerStore } from './learner-store.js';

export type Id = string;
export type DayKey = string;
export type NewRow<T> = Omit<T, 'id'>;
export type LockStrength = 'update' | 'no_key_update';

export type Attempt = {
  id: Id;
  sessionId: Id | null;
  activityId: Id | null;
  exerciseId: Id;
  exerciseVersion: string;
  conceptId: Id;
  dimension: string;
  mode: 'practice' | 'assessment' | 'diagnostic' | 'review';
  answer: unknown;
  correct: number;
  credit: number;
  hintsUsed: number;
  attemptNo: number;
  gradedBy: string;
  feedback: unknown;
  mistakeCategory: string | null;
  durationMs: number | null;
  createdAt: Date;
};

export type AttemptQuery = {
  ids?: readonly Id[];
  activityIds?: readonly Id[];
  exerciseIds?: readonly Id[];
  conceptId?: Id;
  since?: Date;
  through?: Date;
  order?:
    | 'recent'
    | 'scheduler'
    | 'activity_attempt_no'
    | 'unordered'
    | 'review_chronological'
    | 'final_evidence';
  limit?: number;
};

export type XpEvent = {
  id: Id;
  kind: 'activity' | 'knowledge_point' | 'review' | 'quiz' | 'mixed_quiz' | 'project';
  sourceKey: string;
  conceptId: Id | null;
  amount: number;
  earnedAt: Date;
  localDate: DayKey;
};

export type XpQuery = {
  localDate?: DayKey;
  since?: Date;
  through?: Date;
  sourcePrefix?: string;
  sourceKey?: string;
};

export type Settings = {
  activeCourseId: Id | null;
  studySetInitializedAt: Date | null;
  startDate: DayKey;
  timeZone: string;
  prefs: Record<string, unknown>;
};

export type Enrollment = {
  courseId: Id;
  status: 'active' | 'paused' | 'completed';
  startMethod: 'placement' | 'beginning';
  startedAt: Date;
  completedAt: Date | null;
};

export type EnrollmentWrite =
  | { kind: 'insert_missing'; rows: readonly Enrollment[] }
  | { kind: 'start'; row: Enrollment }
  | { kind: 'complete'; courseIds: readonly Id[]; now: Date }
  | {
      kind: 'set_status';
      courseIds: readonly Id[];
      status: Enrollment['status'];
      completedAt: Date | null;
      ifStatus?: Enrollment['status'];
    };

export interface CoreStore extends LearnerStore {
  transaction<T>(fn: (tx: this) => Promise<T>): Promise<T>;
  lockLearner(learnerId: Id, strength: LockStrength): Promise<void>;
  listAttempts(learnerId: Id, query: AttemptQuery): Promise<Attempt[]>;
  insertAttempt(learnerId: Id, attempt: Attempt): Promise<Attempt>;
  readHintEvidence(
    learnerId: Id,
    exerciseId: Id,
    activityId?: Id,
  ): Promise<{
    attempts: Pick<Attempt, 'activityId' | 'createdAt'>[];
    hints: { activityId: Id | null; createdAt: Date; level: number }[];
  }>;
  listXpEvents(learnerId: Id, query: XpQuery): Promise<XpEvent[]>;
  insertXpEventOnce(learnerId: Id, event: NewRow<XpEvent>): Promise<boolean>;
  getSettings(learnerId: Id): Promise<Settings | undefined>;
  patchSettings(learnerId: Id, patch: Partial<Settings>): Promise<void>;
  listEnrollments(learnerId: Id): Promise<Enrollment[]>;
  writeEnrollments(learnerId: Id, change: EnrollmentWrite): Promise<void>;
}
