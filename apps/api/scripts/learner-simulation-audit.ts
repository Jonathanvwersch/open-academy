import type { ContentIndex } from '@academy/aesop/course/types';
import type { applyPlacementGrantOutcome } from '@academy/aesop/placement/grant-commands';
import type { SchedulerState } from '@academy/aesop/planner/scheduler';
import type {
  attempts,
  lessonQuizAttempts,
  lessonQuizItems,
  lessonRuns,
  mastery,
  placementGrants,
  quizItems,
  remediationFlags,
  reviewCards,
  reviewLogs,
  sessionActivities,
  xpEvents,
} from '../src/db/schema.js';

export type AuditMasteryRow = typeof mastery.$inferSelect;
export type AuditLessonRunRow = typeof lessonRuns.$inferSelect;
export type AuditPlacementGrantRow = typeof placementGrants.$inferSelect;
export type AuditRemediationFlagRow = typeof remediationFlags.$inferSelect;
export type AuditReviewCardRow = typeof reviewCards.$inferSelect;
export type AuditLessonQuizAttemptRow = typeof lessonQuizAttempts.$inferSelect;
export type AuditLessonQuizItemRow = typeof lessonQuizItems.$inferSelect;
export type AuditQuizItemRow = typeof quizItems.$inferSelect;
export type AuditSessionActivityRow = typeof sessionActivities.$inferSelect;
export type AuditAttemptRow = typeof attempts.$inferSelect;
export type AuditXpEventRow = typeof xpEvents.$inferSelect;
type ReviewLogRow = typeof reviewLogs.$inferSelect;
export type AuditMasteryInsert = typeof mastery.$inferInsert;
export type AuditReviewCardInsert = typeof reviewCards.$inferInsert;

export interface AuditProgressRows {
  mastery: AuditMasteryRow[];
  lessonRuns: AuditLessonRunRow[];
  placements: Array<Pick<AuditPlacementGrantRow, 'conceptId' | 'state'>>;
  openFlags: AuditRemediationFlagRow[];
}

export type AuditActivityReviewLog = Pick<ReviewLogRow, 'id' | 'cardId' | 'rating'> &
  Pick<AuditReviewCardRow, 'conceptId' | 'dimension'>;

export type AuditTimedReviewLog = Pick<
  ReviewLogRow,
  'id' | 'cardId' | 'rating' | 'speed' | 'rawDueAt' | 'fsrsLog'
> &
  Pick<AuditReviewCardRow, 'conceptId' | 'dimension'> & { cardDueAt: Date };

export type AuditTimedAttempt = Pick<
  AuditAttemptRow,
  'id' | 'conceptId' | 'correct' | 'gradedBy' | 'hintsUsed' | 'attemptNo' | 'answer'
> & { tutorHelped: unknown };

export interface AuditAttemptHistory {
  attempts: Map<string, string>;
  xp: Map<string, string>;
}

/**
 * Facts the simulator's invariants read directly from learner state. Each driver answers them
 * from its own storage, so the checks never depend on the engine's own answers.
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
  ): Promise<Array<Pick<ReviewLogRow, 'cardId' | 'rating' | 'createdAt'>>>;
  /** Attempts graded at `now`, ordered by quiz position, topic and id. */
  attemptsAt(userId: string, now: Date): Promise<AuditTimedAttempt[]>;
  latestLessonRun(
    userId: string,
    conceptId: string,
  ): Promise<Pick<AuditLessonRunRow, 'id' | 'status'> | undefined>;
  lessonRunTopics(userId: string): Promise<string[]>;
  completedLessonTopics(userId: string): Promise<string[]>;
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
