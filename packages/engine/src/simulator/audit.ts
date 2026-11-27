import type { Dimension } from '../course/schemas.js';
import type { ContentIndex } from '../course/types.js';
import type { MasteryState } from '../memory/types.js';
import type { applyPlacementGrantOutcome } from '../placement/grant-commands.js';
import type { SchedulerState } from '../planner/scheduler.js';
import type { Attempt } from '../store/core-store.js';
import type { TimedQuizItem } from '../store/flow-store.js';
import type { StoredReviewCard } from '../store/learner-store.js';
import type { LessonQuizAttempt, LessonQuizItem, LessonRun } from '../store/lesson-store.js';
import type { PlacementGrant } from '../store/placement-review-store.js';
import type { Activity, RemediationFlag } from '../store/session-store.js';

export type AuditMasteryRow = {
  userId: string;
  conceptId: string;
  dimension: Dimension;
  state: MasteryState;
  provisional: boolean;
  inferred: boolean;
  evidence: unknown;
  lastAssessedAt: Date | null;
  lastIndependentAt: Date | null;
  firstIndependentAt: Date | null;
};
export type AuditLessonRunRow = LessonRun & { userId: string };
export type AuditPlacementGrantRow = Omit<PlacementGrant, 'evidenceAttemptIds'> & {
  evidenceAttemptIds: unknown;
  userId: string;
};
export type AuditRemediationFlagRow = RemediationFlag & { userId: string };
export type AuditReviewCardRow = Pick<
  StoredReviewCard,
  | 'id'
  | 'conceptId'
  | 'dimension'
  | 'fsrs'
  | 'dueAt'
  | 'lastReviewAt'
  | 'reps'
  | 'lapses'
  | 'suspendedAt'
> & { userId: string };
export type AuditLessonQuizAttemptRow = LessonQuizAttempt;
export type AuditLessonQuizItemRow = LessonQuizItem;
export type AuditQuizItemRow = TimedQuizItem;
export type AuditSessionActivityRow = Activity;
export type AuditAttemptRow = Attempt & { userId: string };
export type AuditMasteryInsert = AuditMasteryRow;
export type AuditReviewCardInsert = Omit<StoredReviewCard, 'id' | 'suspendedAt'> & {
  userId: string;
  suspendedAt?: Date | null;
};

export interface AuditProgressRows {
  mastery: AuditMasteryRow[];
  lessonRuns: AuditLessonRunRow[];
  placements: Array<Pick<AuditPlacementGrantRow, 'conceptId' | 'state'>>;
  openFlags: AuditRemediationFlagRow[];
}

export type AuditActivityReviewLog = {
  id: string;
  cardId: string;
  rating: string;
  conceptId: string;
  dimension: Dimension;
};

export type AuditTimedReviewLog = {
  id: string;
  cardId: string;
  rating: string;
  speed: number | null | undefined;
  rawDueAt: Date | null;
  fsrsLog: unknown;
  conceptId: string;
  dimension: Dimension;
  cardDueAt: Date;
};

export type AuditTimedAttempt = Pick<
  Attempt,
  'id' | 'conceptId' | 'correct' | 'gradedBy' | 'hintsUsed' | 'attemptNo' | 'answer'
> & { tutorHelped: unknown };

export interface AuditAttemptHistory {
  attempts: Map<string, string>;
  xp: Map<string, string>;
}

/**
 * Facts the simulator's invariants read directly from learner state. Each driver answers them
 * from its own storage, so the checks never depend on the engine's own answers. Lists keep
 * the row order the PostgreSQL queries return; implementations must match it.
 */
export interface SimulatorAudit {
  progressRows(userId: string): Promise<AuditProgressRows>;
  schedulerState(userId: string, now: Date, content: ContentIndex): Promise<SchedulerState>;
  /** Review cards ordered by topic, dimension and id. */
  reviewCards(userId: string): Promise<AuditReviewCardRow[]>;
  reviewCardDueDates(
    userId: string,
    conceptIds: string[],
  ): Promise<Array<Pick<AuditReviewCardRow, 'conceptId' | 'dueAt'>>>;
  /** Review cards first reviewed at `now`, ordered by topic and dimension. */
  firstReviewCardsAt(userId: string, now: Date): Promise<AuditReviewCardRow[]>;
  /** Review logs written at `now`, ordered by time, topic, dimension, rating and id. */
  activityReviewLogsAt(userId: string, now: Date): Promise<AuditActivityReviewLog[]>;
  /** Review logs written at `now`, ordered by topic and dimension. */
  timedReviewLogsAt(userId: string, now: Date): Promise<AuditTimedReviewLog[]>;
  /** Logs for the given cards, newest first. */
  reviewLogHistory(
    cardIds: string[],
  ): Promise<Array<{ cardId: string; rating: string; createdAt: Date }>>;
  /** Attempts graded at `now`, ordered by quiz position, topic and id. */
  attemptsAt(userId: string, now: Date): Promise<AuditTimedAttempt[]>;
  latestLessonRun(
    userId: string,
    conceptId: string,
  ): Promise<Pick<AuditLessonRunRow, 'id' | 'status'> | undefined>;
  lessonRunTopics(userId: string): Promise<string[]>;
  completedLessonTopics(userId: string): Promise<string[]>;
  /** Attempts by ascending attempt number: invariants read the last one as the newest. */
  lessonQuizAttempts(runId: string): Promise<AuditLessonQuizAttemptRow[]>;
  /** Items ordered by position and id. */
  lessonQuizItems(quizAttemptId: string): Promise<AuditLessonQuizItemRow[]>;
  lessonQuizItem(itemId: string): Promise<AuditLessonQuizItemRow | undefined>;
  timedQuizRuns(
    userId: string,
  ): Promise<Array<{ finalizedAt: Date | null; retakeOf: string | null }>>;
  /** Items ordered by position. */
  timedQuizItems(runId: string): Promise<AuditQuizItemRow[]>;
  timedQuizHistory(userId: string): Promise<Array<Pick<AuditQuizItemRow, 'question' | 'runId'>>>;
  openTimedQuizActivityIds(userId: string): Promise<string[]>;
  xpAmounts(userId: string, sourceKey: string): Promise<number[]>;
  activityStatus(activityId: string): Promise<string | undefined>;
  /** Activities ordered by position. */
  sessionActivities(sessionId: string): Promise<AuditSessionActivityRow[]>;
  /** Grants ordered by creation time and id. */
  placementGrants(userId: string): Promise<AuditPlacementGrantRow[]>;
  confirmedGrantTopics(userId: string): Promise<string[]>;
  withdrawnGrants(userId: string): Promise<Array<Pick<AuditPlacementGrantRow, 'id' | 'conceptId'>>>;
  lessonRuns(userId: string): Promise<AuditLessonRunRow[]>;
  attempts(userId: string): Promise<AuditAttemptRow[]>;
  remediationFlags(userId: string): Promise<AuditRemediationFlagRow[]>;
  attemptHistory(userId: string): Promise<AuditAttemptHistory>;
  /** A stable text form of placement, mastery, card, flag, attempt and XP state. */
  learnerSnapshot(userId: string): Promise<string>;
  /** The learner store, for replaying engine commands during checks. */
  store(): Parameters<typeof applyPlacementGrantOutcome>[0]['store'];
}

/** Writes test-only starting states for scripted scenarios. */
export interface SimulatorFixtures {
  seedScriptedScenario(input: {
    userId: string;
    now: Date;
    courseId: string;
    masteryRows: AuditMasteryInsert[];
    reviewCards: AuditReviewCardInsert[];
  }): Promise<void>;
  seedCompletedLessons(input: {
    userId: string;
    conceptIds: string[];
    now: Date;
    xp: { sourceKey: string; amount: number; localDate: string };
  }): Promise<void>;
}
