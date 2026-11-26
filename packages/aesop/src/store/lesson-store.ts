import type { IndexedExercise } from '../course/types.js';
import type { GradeResult } from '../lessons/grading/types.js';
import type { Id, NewRow } from './core-store.js';
import type { ReviewLogRecord } from './learner-store.js';
import type { RemediationFlag, RowEdit, SessionStore } from './session-store.js';

export type { RemediationFlag } from './session-store.js';

export type LessonRun = {
  id: Id;
  conceptId: Id;
  status: 'in_progress' | 'needs_retry' | 'quiz' | 'completed';
  startedAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
  quizPassedAt: Date | null;
  attempt: number;
  haltedAt: Date | null;
  retryAfter: Date | null;
  haltedPointIndex: number | null;
  haltCount: number;
};

export type LessonProblem = {
  id: Id;
  runId: Id;
  knowledgePointId: Id;
  round: number;
  position: number;
  exerciseId: Id;
  seed: number | null;
  practiceOnly: boolean;
  assisted: boolean;
  servedAt: Date;
  answeredAt: Date | null;
  correct: number | null;
  attemptId: Id | null;
};

export type LessonQuizAttempt = {
  id: Id;
  runId: Id;
  attemptNo: number;
  startedAt: Date;
  submittedAt: Date | null;
  score: number | null;
  passed: boolean | null;
};

export type LessonQuizEvidence = {
  exercise: Pick<
    IndexedExercise,
    'id' | 'concept' | 'dimension' | 'role' | 'contentVersion' | 'target_seconds'
  >;
  grade: Extract<GradeResult, { status: 'graded' }>;
};

export type LessonQuizItem = {
  id: Id;
  quizAttemptId: Id;
  position: number;
  knowledgePointId: Id;
  exerciseId: Id;
  seed: number | null;
  answer: unknown;
  evidence: LessonQuizEvidence | null;
  correct: number | null;
  durationMs: number | null;
  attemptId: Id | null;
  answeredAt: Date | null;
};

export type LessonKey = { conceptId: Id; quizItemId?: Id } | { runId: Id };
export type LessonQuiz = { quizAttempts: LessonQuizAttempt[]; quizItems: LessonQuizItem[] };
export type FlagQuery = {
  conceptId?: Id;
  targetPrereqIds?: readonly Id[];
  status?: RemediationFlag['status'];
  excludeOpenedByActivityId?: Id;
};
export type ReviewLogEntry = Omit<ReviewLogRecord, 'attemptId'> & {
  id: Id;
  cardId: Id;
  conceptId: Id;
  attemptId: Id | null;
};

export interface LessonStore extends SessionStore {
  listLessonRuns(learnerId: Id): Promise<LessonRun[]>;
  getLessonRun(
    learnerId: Id,
    key: LessonKey,
    options?: { forUpdate?: boolean },
  ): Promise<LessonRun | undefined>;
  lockLessonProblem(
    learnerId: Id,
    conceptId: Id,
    problemId: Id,
  ): Promise<{ run: LessonRun; problem: LessonProblem } | undefined>;
  insertLessonRunIfAbsent(learnerId: Id, run: NewRow<LessonRun>): Promise<LessonRun | undefined>;
  patchLessonRun(
    learnerId: Id,
    runId: Id,
    patch: RowEdit<LessonRun, 'conceptId'>,
  ): Promise<LessonRun>;
  listLessonProblems(learnerId: Id, runId: Id): Promise<LessonProblem[]>;
  insertLessonProblem(
    learnerId: Id,
    runId: Id,
    problem: NewRow<Omit<LessonProblem, 'runId'>>,
  ): Promise<LessonProblem>;
  patchLessonProblem(
    learnerId: Id,
    runId: Id,
    problemId: Id,
    patch: RowEdit<LessonProblem, 'runId'>,
  ): Promise<void>;
  deleteLessonProblems(learnerId: Id, runId: Id, ids: readonly Id[]): Promise<void>;
  readLessonQuiz(learnerId: Id, runId: Id): Promise<LessonQuiz>;
  insertLessonQuiz(
    learnerId: Id,
    runId: Id,
    attempt: NewRow<Omit<LessonQuizAttempt, 'runId'>>,
    items: readonly NewRow<Omit<LessonQuizItem, 'quizAttemptId'>>[],
  ): Promise<LessonQuizAttempt>;
  patchLessonQuizAttempt(
    learnerId: Id,
    runId: Id,
    attemptId: Id,
    patch: RowEdit<LessonQuizAttempt, 'runId'>,
  ): Promise<void>;
  patchLessonQuizItem(
    learnerId: Id,
    runId: Id,
    itemId: Id,
    patch: RowEdit<LessonQuizItem, 'quizAttemptId'> & { replacementId?: Id },
    expected?: { unanswered: true },
  ): Promise<LessonQuizItem | undefined>;
  deleteLessonQuizRows(
    learnerId: Id,
    runId: Id,
    rows: { itemIds?: readonly Id[]; attemptIds?: readonly Id[] },
  ): Promise<void>;
  listRemediationFlags(learnerId: Id, query: FlagQuery): Promise<RemediationFlag[]>;
  insertRemediationFlags(learnerId: Id, flags: readonly NewRow<RemediationFlag>[]): Promise<void>;
  resolveRemediationFlags(learnerId: Id, query: FlagQuery, now: Date): Promise<void>;
  clearTopicProgress(learnerId: Id, conceptId: Id): Promise<void>;
}
