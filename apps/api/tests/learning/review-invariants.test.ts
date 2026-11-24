import { and, eq, inArray } from 'drizzle-orm';
import { Rating } from 'ts-fsrs';
import { afterAll, beforeAll, expect, vi, it as vitestIt } from 'vitest';
import {
  answerFor as answerForExercise,
  seededWrongAnswerFor as seededWrongAnswerForExercise,
  wrongAnswerFor as wrongAnswerForExercise,
} from '../../scripts/learner-simulation-support.js';
import { createApp } from '../../src/app.js';
import { env } from '../../src/config.js';
import { subjectForCourse } from '../../src/content/index.js';
import { loadContent } from '../../src/content/load.js';
import { isTemplate } from '../../src/content/templates.js';
import type { ContentIndex } from '../../src/content/types.js';
import { createDb } from '../../src/db/client.js';
import { LearnerRepository } from '../../src/db/repository.js';
import {
  attempts,
  courseEnrollments,
  mastery,
  reviewCards,
  reviewLogs,
  sessionActivities,
  studySessions,
  users,
} from '../../src/db/schema.js';
import { FakeProvider } from '../../src/features/tutor/provider.js';
import { shiftLocalDate } from '../../src/http/request-context.js';
import { filterSchedulerStateForContent } from '../../src/learning/content-filters.js';
import {
  isDueToday,
  newReviewCard,
  reviewActivityRating,
  scheduleReview,
} from '../../src/learning/fsrs.js';
import { courseConceptIds, courseFoundationIds } from '../../src/learning/prerequisites.js';
import * as schedulerModule from '../../src/learning/scheduler.js';
import {
  buildReviewActivityForConcept,
  effectiveFocusSubjectId,
  explainReviewSelection,
  explainReviewSelectionForReplan,
  SCHEDULER_CONFIG,
  sessionBudget,
} from '../../src/learning/scheduler.js';
import { localDateKey, sessionKindForDate } from '../../src/learning/xp.js';

const db = createDb(env.TEST_DATABASE_URL);
const realDataAuditMode = process.env.REVIEW_AUDIT_REALDATA === '1';
const apiBaseUrl = process.env.REVIEW_AUDIT_API_URL?.replace(/\/$/, '');
const it = realDataAuditMode ? vitestIt.skip : vitestIt;
let userId = '00000000-0000-4000-8000-000000000098';
const timezone = process.env.REVIEW_AUDIT_TIMEZONE ?? 'America/Los_Angeles';
const startDate = '2026-02-22';
let app: ReturnType<typeof createApp>;
let content: ContentIndex;
const seededReps = new Map<string, number>();
const seededReviewLogCounts = new Map<string, number>();
const violations = new Map<string, Set<string>>();
const simulationFindings = new Map<string, string[]>();
const auditTrail: string[] = [];
const attemptFailures: string[] = [];
type ApiCall = { method: string; path: string; now: Date };
type SchedulerCall =
  | {
      kind: 'plan';
      args: Parameters<typeof schedulerModule.planSession>;
      request: ApiCall;
    }
  | {
      kind: 'replan';
      args: Parameters<typeof schedulerModule.replan>;
      request: ApiCall;
    };
type PlanningEvidence = {
  request: ApiCall;
  sessionId: string;
  createdActivityIds: string[];
  budget: number;
  coveredReviewConceptIds: string[];
  usedExerciseIds: string[];
  results: ReturnType<typeof explainReviewSelection>;
};
const schedulerCalls: SchedulerCall[] = [];
const activityPlanningEvidence = new Map<string, PlanningEvidence>();
const activityCreationCalls = new Map<string, ApiCall>();
const runCreatedActivityTopics = new Map<string, Set<string>>();
const runCreatedAttemptIds = new Set<string>();
const runCreatedReviewLogIds = new Set<string>();
const preRunEntityIds = new Set<string>();
type BudgetDeferredRecord = {
  checkers: Array<'I3' | 'I6'>;
  conceptId: string;
  dimension: string;
  dueAt: string;
  daysOverdue: number;
};
const checkpointBudgetDeferrals = new Map<string, BudgetDeferredRecord>();
const budgetDeferralsByDay = new Map<string, Map<string, BudgetDeferredRecord>>();
const budgetDeferralStreaks = new Map<string, { since: string; through: string; days: number }>();
const longestBudgetDeferrals = new Map<string, { since: string; through: string; days: number }>();
const morningPlannerSelections = new Map<string, PlannerSelection>();
const legacyAuditFindings = new Map<string, Set<string>>();
const latestAuditStatuses = new Map<string, 'HOLDS' | 'LEGACY' | 'BUDGET-DEFERRED' | 'VIOLATED'>();
const auditCheckpoints: Array<{ label: string; results: Array<Record<string, unknown>> }> = [];
const lowCreditPickedUpCardKeys = new Set<string>();
let currentPlanActivityIds = new Set<string>();
type DueAtEvent = { at: Date; dueAt: Date; cause: string };
const dueAtHistory = new Map<string, DueAtEvent[]>();
let currentApiCall: ApiCall | undefined;
let simulationStepCount = 0;
let simulationAttemptFailures: string[] = [];
let auditRunStartedAt = new Date();

const checkerNames = ['I1', 'I2', 'I3', 'I4', 'I5', 'I6', 'I7', 'I8', 'I9'];
vi.setConfig({ hookTimeout: 300_000, testTimeout: realDataAuditMode ? 900_000 : 60_000 });

function headersAt(now: Date) {
  return {
    'content-type': 'application/json',
    'X-Now': now.toISOString(),
    'X-Time-Zone': timezone,
  };
}

async function readApi(path: string, now: Date): Promise<any> {
  const response =
    realDataAuditMode && apiBaseUrl
      ? await fetch(`${apiBaseUrl}/api${path}`, { headers: headersAt(now) })
      : await app.request(`/api${path}`, { headers: headersAt(now) });
  return response.json() as Promise<Record<string, any>>;
}

type AuditContext = {
  now: Date;
  label: string;
  today: Record<string, any>;
  active: Record<string, any> | null;
  reviews: Record<string, any>;
  selection?: PlannerSelection;
  coverageResults?: PlannerSelection['results'];
};

type PlannerSelection = {
  state: Parameters<typeof explainReviewSelection>[0];
  budget: number;
  results: ReturnType<typeof explainReviewSelection>;
};

type ResumedSelectionSnapshot = {
  day: string;
  dueTopicCount: number;
  selectedInCurrentPlan: string[];
  budgetDeferredTopics: Array<{ conceptId: string; dueAt: string; priority: number }>;
  notSelected: Array<{
    conceptId: string;
    reason: string;
    selectedExerciseIds: string[];
    selectedInCurrentPlan: boolean;
  }>;
  priorityFindings: Array<{
    selectedConceptId: string;
    selectedDueAt: string;
    selectedPriority: number;
    deferredConceptId: string;
    deferredDueAt: string;
    deferredPriority: number;
    priorityInversion: boolean;
  }>;
};

function topicIds(exerciseIds: string[] = []) {
  return [
    ...new Set(
      exerciseIds.flatMap((id) => {
        const conceptId = content.exercisesById.get(id)?.concept;
        return conceptId ? [conceptId] : [];
      }),
    ),
  ];
}

function activityTopics(activity: Record<string, any>) {
  return topicIds(activity.exerciseIds ?? []);
}

function todayActivities(payload: Record<string, any>) {
  return payload.plan?.activities ?? payload.activities ?? [];
}

function selectedTaskCoverage(
  results: PlannerSelection['results'] | undefined,
  activities: Array<Record<string, any>>,
) {
  const plannedTopics = new Set(
    activities.flatMap((activity) => [
      ...(typeof activity.conceptId === 'string' ? [activity.conceptId] : []),
      ...activityTopics(activity),
    ]),
  );
  const coveredConceptIds = new Set<string>();
  const coveringConceptIds = new Set<string>();
  const planningResults = activities.flatMap((activity) =>
    typeof activity.id === 'string'
      ? (activityPlanningEvidence.get(activity.id)?.results ?? [])
      : [],
  );
  for (const result of [...(results ?? []), ...planningResults]) {
    if (
      result.result !== 'covered' ||
      !result.coveringConceptId ||
      !plannedTopics.has(result.coveringConceptId)
    ) {
      continue;
    }
    coveredConceptIds.add(result.conceptId);
    coveringConceptIds.add(result.coveringConceptId);
  }
  return { coveredConceptIds, coveringConceptIds };
}

function atLocalNoon(day: string) {
  return new Date(`${day}T20:00:00.000Z`);
}

function localDayDifference(from: string, to: string) {
  let day = from;
  let count = 0;
  while (day < to && count < 40) {
    day = shiftLocalDate(day, 1);
    count += 1;
  }
  return count;
}

function recordBudgetDeferred(
  checker: 'I3' | 'I6',
  card: typeof reviewCards.$inferSelect,
  now: Date,
) {
  const day = localDateKey(now, timezone);
  const key = `${card.conceptId}/${card.dimension}`;
  const dueDate = localDateKey(card.dueAt, timezone);
  const existing = checkpointBudgetDeferrals.get(key);
  const record: BudgetDeferredRecord = existing
    ? {
        ...existing,
        checkers: existing.checkers.includes(checker)
          ? existing.checkers
          : [...existing.checkers, checker],
      }
    : {
        checkers: [checker],
        conceptId: card.conceptId,
        dimension: card.dimension,
        dueAt: card.dueAt.toISOString(),
        daysOverdue: localDayDifference(dueDate, day),
      };
  checkpointBudgetDeferrals.set(key, record);
  const dayRecords = budgetDeferralsByDay.get(day) ?? new Map<string, BudgetDeferredRecord>();
  const dayExisting = dayRecords.get(key);
  dayRecords.set(
    key,
    dayExisting
      ? {
          ...dayExisting,
          checkers: record.checkers,
        }
      : record,
  );
  budgetDeferralsByDay.set(day, dayRecords);
}

function hasReviewLogForConceptToday(
  conceptId: string,
  now: Date,
  logs: Array<{ conceptId: string; createdAt: Date }>,
) {
  const day = localDateKey(now, timezone);
  return logs.some(
    (log) => log.conceptId === conceptId && localDateKey(log.createdAt, timezone) === day,
  );
}

function reviewMinuteCapIsActuallyBinding(
  selection: PlannerSelection,
  conceptId: string,
  now: Date,
) {
  const minutesFor = (candidateConceptId: string) => {
    const dueCards = selection.state.cards.filter(
      (card) => card.conceptId === candidateConceptId && isDueToday(card.dueAt, now, timezone),
    );
    return buildReviewActivityForConcept(
      selection.state,
      content,
      now,
      candidateConceptId,
      dueCards,
    )?.plannedMinutes;
  };
  const candidateMinutes = minutesFor(conceptId);
  if (candidateMinutes === undefined) return false;
  const selectedMinutes = selection.results
    .filter((result) => result.result === 'selected' || result.result === 'selected:overdue')
    .reduce((sum, result) => sum + (minutesFor(result.conceptId) ?? 0), 0);
  return (
    selectedMinutes + candidateMinutes >
    Math.floor(selection.budget * SCHEDULER_CONFIG.weekday.reviewBudgetRatio)
  );
}

function isReviewTopicOverdueByCardDueAt(
  conceptId: string,
  cards: Array<Pick<typeof reviewCards.$inferSelect, 'conceptId' | 'dimension' | 'dueAt'>>,
  now: Date,
) {
  const earliestDueAt = cards
    .filter(
      (card) =>
        card.conceptId === conceptId &&
        isDueToday(card.dueAt, now, timezone) &&
        hasEligibleReviewExercise(card.conceptId, card.dimension),
    )
    .map((card) => card.dueAt)
    .sort((left, right) => left.getTime() - right.getTime())[0];
  if (!earliestDueAt) return false;
  return localDateKey(earliestDueAt, timezone) <= shiftLocalDate(localDateKey(now, timezone), -2);
}

vitestIt('only accepts reviewedToday when the concept has a review log on the local day', () => {
  const now = new Date('2026-11-18T16:00:00.000Z');
  const logs = [
    { conceptId: 'reviewed-topic', createdAt: new Date('2026-11-18T15:00:00.000Z') },
    { conceptId: 'other-topic', createdAt: new Date('2026-11-18T15:00:00.000Z') },
    { conceptId: 'reviewed-topic', createdAt: new Date('2026-11-18T07:59:00.000Z') },
  ];

  expect(hasReviewLogForConceptToday('reviewed-topic', now, logs)).toBe(true);
  expect(hasReviewLogForConceptToday('other-topic', now, logs)).toBe(true);
  expect(hasReviewLogForConceptToday('missing-topic', now, logs)).toBe(false);
  expect(
    hasReviewLogForConceptToday('previous-day-topic', now, [
      { conceptId: 'previous-day-topic', createdAt: new Date('2026-11-18T07:59:00.000Z') },
    ]),
  ).toBe(false);
});

vitestIt('checks overdue review eligibility independently from card due dates', () => {
  const cards = [
    {
      conceptId: 'vectors',
      dimension: 'math' as const,
      dueAt: new Date('2026-01-13T07:30:00.000Z'),
    },
  ];

  expect(
    isReviewTopicOverdueByCardDueAt('vectors', cards, new Date('2026-01-14T07:59:00.000Z')),
  ).toBe(false);
  expect(
    isReviewTopicOverdueByCardDueAt('vectors', cards, new Date('2026-01-14T08:30:00.000Z')),
  ).toBe(true);
});

function isLegacyFinding(detail: string, preRunIds: ReadonlySet<string>) {
  const identifiers = detail.match(
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
  );
  return Boolean(identifiers?.length && identifiers.every((id) => preRunIds.has(id)));
}

function invariantViolation(name: string, detail: string) {
  const entries = violations.get(name) ?? new Set<string>();
  if (!entries.has(detail)) {
    entries.add(detail);
    if (name === 'I3' || name === 'I6') console.error(`${name} review selection: ${detail}`);
  }
  violations.set(name, entries);
}

async function checkI1(_now: Date): Promise<string[]> {
  const rows = await db
    .select({ activity: sessionActivities, session: studySessions })
    .from(sessionActivities)
    .innerJoin(studySessions, eq(sessionActivities.sessionId, studySessions.id))
    .where(eq(studySessions.userId, userId));
  const counts = new Map<string, string[]>();
  for (const { activity, session } of rows) {
    if (activity.kind !== 'review' || !session.startedAt) continue;
    const answered = await db
      .select({ id: attempts.id })
      .from(attempts)
      .where(and(eq(attempts.activityId, activity.id), eq(attempts.userId, userId)))
      .limit(1);
    if (
      (session.status === 'abandoned' ||
        !['planned', 'in_progress', 'completed'].includes(activity.status)) &&
      answered.length === 0
    )
      continue;
    const day = localDateKey(session.startedAt, timezone);
    for (const conceptId of activityTopics(activity)) {
      const key = `${day}/${conceptId}`;
      counts.set(key, [...(counts.get(key) ?? []), activity.id]);
    }
  }
  return [...counts].flatMap(([key, ids]) =>
    ids.length > 1 ? [`${key}: review activities ${ids.join(', ')}`] : [],
  );
}

async function checkI2({ now, today }: AuditContext): Promise<string[]> {
  const completed = await db
    .select({ activity: sessionActivities, session: studySessions })
    .from(sessionActivities)
    .innerJoin(studySessions, eq(sessionActivities.sessionId, studySessions.id))
    .where(
      and(
        eq(studySessions.userId, userId),
        eq(sessionActivities.kind, 'review'),
        eq(sessionActivities.status, 'completed'),
      ),
    );
  const plannedTopics = todayActivities(today)
    .filter((activity: Record<string, any>) => activity.kind === 'review')
    .flatMap((activity: Record<string, any>) => activityTopics(activity));
  return completed.flatMap(({ activity, session }) => {
    if (
      !session.startedAt ||
      localDateKey(session.startedAt, timezone) !== localDateKey(now, timezone)
    )
      return [];
    return activityTopics(activity)
      .filter((conceptId) => plannedTopics.includes(conceptId))
      .map(
        (conceptId) => `${conceptId}: completed activity ${activity.id} is still in today's plan`,
      );
  });
}

function hasEligibleReviewExercise(conceptId: string, dimension: string) {
  return (content.exercisesByConcept.get(conceptId) ?? []).some(
    (exercise) =>
      exercise.dimension === dimension &&
      !exercise.lesson_only &&
      !isTemplate(exercise) &&
      ['transfer', 'review', 'core', 'practice', 'basics'].includes(exercise.role),
  );
}

async function focusedConceptIds() {
  const [[learner], enrollments] = await Promise.all([
    db.select({ prefs: users.prefs }).from(users).where(eq(users.id, userId)).limit(1),
    db
      .select({ courseId: courseEnrollments.courseId })
      .from(courseEnrollments)
      .where(and(eq(courseEnrollments.userId, userId), eq(courseEnrollments.status, 'active'))),
  ]);
  const activeCourseIds = enrollments.map((enrollment) => enrollment.courseId);
  const focusSubjectId = effectiveFocusSubjectId(
    learner?.prefs as { focusSubjectId?: unknown } | undefined,
    activeCourseIds,
    content,
  );
  if (!focusSubjectId) return null;
  return new Set(
    activeCourseIds
      .filter((courseId) => subjectForCourse(content, courseId).id === focusSubjectId)
      .flatMap((courseId) => [
        ...courseConceptIds(content.coursesById.get(courseId)),
        ...courseFoundationIds(content, courseId),
      ]),
  );
}

async function checkI3({
  now,
  label,
  today,
  active,
  selection,
  coverageResults,
}: AuditContext): Promise<string[]> {
  const planned = todayActivities(today)
    .filter((activity: Record<string, any>) => activity.kind === 'review')
    .flatMap((activity: Record<string, any>) => activity.exerciseIds ?? []);
  const plannedReviewDimensions = new Set(
    planned.flatMap((exerciseId: string) => {
      const exercise = content.exercisesById.get(exerciseId);
      return exercise ? [`${exercise.concept}/${exercise.dimension}`] : [];
    }),
  );
  const isNextPlan = label === 'GET /today' && today.activeSessionId === null;
  const selectedCoverage = selectedTaskCoverage(coverageResults, [
    ...todayActivities(today),
    ...(active?.activities ?? []).filter((activity: Record<string, any>) =>
      ['planned', 'in_progress'].includes(activity.status),
    ),
  ]);
  const cards = await db.select().from(reviewCards).where(eq(reviewCards.userId, userId));
  const todayLogs = await db
    .select({
      cardId: reviewLogs.cardId,
      conceptId: reviewCards.conceptId,
      rating: reviewLogs.rating,
      attemptId: reviewLogs.attemptId,
      createdAt: reviewLogs.createdAt,
    })
    .from(reviewLogs)
    .innerJoin(reviewCards, eq(reviewLogs.cardId, reviewCards.id))
    .where(eq(reviewCards.userId, userId));
  const completedReviewActivities = (active?.activities ?? []).filter(
    (item: Record<string, any>) => item.kind === 'review' && item.status === 'completed',
  );
  const completedReviewActivityIds = completedReviewActivities.map(
    (activity: Record<string, any>) => activity.id as string,
  );
  const ratingsByActivityConcept = new Map<string, number[]>();
  if (completedReviewActivityIds.length > 0) {
    const completedReviewLogs = await db
      .select({
        activityId: attempts.activityId,
        conceptId: reviewCards.conceptId,
        rating: reviewLogs.rating,
      })
      .from(reviewLogs)
      .innerJoin(attempts, eq(reviewLogs.attemptId, attempts.id))
      .innerJoin(reviewCards, eq(reviewLogs.cardId, reviewCards.id))
      .where(
        and(
          eq(reviewCards.userId, userId),
          inArray(attempts.activityId, completedReviewActivityIds),
        ),
      );
    for (const log of completedReviewLogs) {
      if (!log.activityId) continue;
      const key = `${log.activityId}\u0000${log.conceptId}`;
      const ratings = ratingsByActivityConcept.get(key) ?? [];
      ratings.push(Number(log.rating));
      ratingsByActivityConcept.set(key, ratings);
    }
  }
  const lowerCreditCoveredConceptIds = new Set<string>();
  for (const activity of completedReviewActivities) {
    const plannedResults = activityPlanningEvidence.get(activity.id)?.results ?? [];
    for (const result of plannedResults) {
      if (
        result.result !== 'covered' ||
        !result.coveringConceptId ||
        !activityTopics(activity).includes(result.coveringConceptId)
      ) {
        continue;
      }
      const ratings = ratingsByActivityConcept.get(
        `${activity.id}\u0000${result.coveringConceptId}`,
      );
      if (ratings?.length && Math.min(...ratings) < Rating.Good) {
        lowerCreditCoveredConceptIds.add(result.conceptId);
      }
    }
  }
  const gradedToday = new Set(
    todayLogs
      .filter((log) => localDateKey(log.createdAt, timezone) === localDateKey(now, timezone))
      .map((log) => log.conceptId),
  );
  const focusedConcepts = await focusedConceptIds();
  const failures = cards.flatMap((card) => {
    const concept = content.conceptsById.get(card.conceptId);
    if (!concept || concept.status === 'stub' || !isDueToday(card.dueAt, now, timezone)) return [];
    if (focusedConcepts && !focusedConcepts.has(card.conceptId)) return [];
    const eligible = hasEligibleReviewExercise(card.conceptId, card.dimension);
    if (!eligible || gradedToday.has(card.conceptId)) return [];
    const cardKey = `${card.conceptId}/${card.dimension}`;
    const reviewSelected = plannedReviewDimensions.has(cardKey);
    const plannerResult =
      selection?.results.find((result) => result.conceptId === card.conceptId) ??
      coverageResults?.find((result) => result.conceptId === card.conceptId);
    if (lowerCreditCoveredConceptIds.has(card.conceptId)) {
      if (!isNextPlan) return [];
      if (reviewSelected || selectedCoverage.coveredConceptIds.has(card.conceptId)) {
        lowCreditPickedUpCardKeys.add(cardKey);
        return [];
      }
      if (
        plannerResult?.result === 'rejected:reviewMinuteCap' &&
        selection &&
        !isReviewTopicOverdueByCardDueAt(card.conceptId, cards, now) &&
        reviewMinuteCapIsActuallyBinding(selection, card.conceptId, now)
      ) {
        recordBudgetDeferred('I3', card, now);
        lowCreditPickedUpCardKeys.add(cardKey);
        return [];
      }
      return [
        `${cardKey} was covered by a completed lower-credit review but not picked up by the next plan`,
      ];
    }
    if (reviewSelected || selectedCoverage.coveredConceptIds.has(card.conceptId)) {
      lowCreditPickedUpCardKeys.add(cardKey);
      return [];
    }
    if (
      plannerResult?.result === 'not_candidate:reviewedToday' &&
      hasReviewLogForConceptToday(card.conceptId, now, todayLogs)
    )
      return [];
    if (
      plannerResult?.result === 'rejected:reviewMinuteCap' &&
      selection &&
      !isReviewTopicOverdueByCardDueAt(card.conceptId, cards, now) &&
      reviewMinuteCapIsActuallyBinding(selection, card.conceptId, now)
    ) {
      recordBudgetDeferred('I3', card, now);
      return [];
    }
    return [
      `${card.conceptId}/${card.dimension} due ${card.dueAt.toISOString()} is eligible but no review exercise of that dimension was selected; eligible=${
        (content.exercisesByConcept.get(card.conceptId) ?? [])
          .filter(
            (exercise) =>
              exercise.dimension === card.dimension &&
              hasEligibleReviewExercise(card.conceptId, card.dimension),
          )
          .map((exercise) => exercise.id)
          .join(',') || 'none'
      }; selected=${planned.join(',') || 'none'}`,
    ];
  });
  if (failures.length === 0) return failures;
  return failures.map((failure) => {
    const conceptId = failure.split('/')[0];
    const history = cards
      .filter((card) => card.conceptId === conceptId)
      .map((card) => ({
        dimension: card.dimension,
        dueAt: card.dueAt.toISOString(),
        dueAtEventsToday: (dueAtHistory.get(card.id) ?? [])
          .filter((event) => localDateKey(event.at, timezone) === localDateKey(now, timezone))
          .map((event) => ({
            at: event.at.toISOString(),
            dueAt: event.dueAt.toISOString(),
            cause: event.cause,
          })),
        reviewLogsToday: todayLogs
          .filter(
            (log) =>
              log.cardId === card.id &&
              localDateKey(log.createdAt, timezone) === localDateKey(now, timezone),
          )
          .map((log) => ({
            rating: log.rating,
            attemptId: log.attemptId,
            createdAt: log.createdAt.toISOString(),
          })),
      }));
    return `${failure}; card dueAt history today=${JSON.stringify(history)}; session/planner=${JSON.stringify(plannerEvidenceForSession(active, conceptId))}`;
  });
}

async function checkI4(): Promise<string[]> {
  const rows = await db
    .select()
    .from(sessionActivities)
    .where(eq(sessionActivities.kind, 'review'));
  const cards = await db.select().from(reviewCards).where(eq(reviewCards.userId, userId));
  const logs = await db
    .select()
    .from(reviewLogs)
    .innerJoin(reviewCards, eq(reviewLogs.cardId, reviewCards.id))
    .where(eq(reviewCards.userId, userId));
  const allAttempts = await db.select().from(attempts).where(eq(attempts.userId, userId));
  const failures: string[] = [];
  for (const activity of rows.filter((item) => item.status === 'completed')) {
    const exercises = activity.exerciseIds.flatMap((id) => {
      const exercise = content.exercisesById.get(id);
      return exercise ? [{ id, exercise }] : [];
    });
    const activityAttempts = allAttempts.filter((attempt) => attempt.activityId === activity.id);
    for (const card of cards) {
      const matching = exercises.filter(
        ({ exercise }) =>
          exercise.concept === card.conceptId && exercise.dimension === card.dimension,
      );
      const cardLogs = logs.filter(
        ({ review_logs: log, review_cards: logCard }) =>
          logCard.id === card.id &&
          activityAttempts.some((attempt) => attempt.id === log.attemptId),
      );
      if (matching.length === 0 && cardLogs.length > 0)
        failures.push(
          `${activity.id}: uncovered ${card.conceptId}/${card.dimension} got ${cardLogs.length} logs`,
        );
      if (matching.length === 0) continue;
      if (cardLogs.length !== 1) {
        const missing = matching
          .filter(({ id }) => !activityAttempts.some((attempt) => attempt.exerciseId === id))
          .map(({ id, exercise }) => `${id}(${exercise.type}/${exercise.role})`);
        failures.push(
          `${activity.id}: ${card.conceptId}/${card.dimension} covered, expected one log, saw ${cardLogs.length}; missing attempts=${missing.join(',')}`,
        );
        continue;
      }
      if (matching.some(({ id }) => !activityAttempts.some((attempt) => attempt.exerciseId === id)))
        continue;
      const items = matching.map(({ id, exercise }) => {
        const attemptsForExercise = activityAttempts
          .filter((attempt) => attempt.exerciseId === id)
          .sort((a, b) => b.attemptNo - a.attemptNo);
        const final = attemptsForExercise[0];
        if (!final) throw new Error(`Missing attempt for ${id} in activity ${activity.id}`);
        return {
          correct: final.correct,
          hintsUsed: attemptsForExercise.reduce((sum, attempt) => sum + attempt.hintsUsed, 0),
          durationMs: final.durationMs,
          targetSeconds: exercise.target_seconds,
        };
      });
      const expected = String(reviewActivityRating(items));
      if (cardLogs[0]?.review_logs.rating !== expected)
        failures.push(
          `${activity.id}: ${card.conceptId}/${card.dimension} rating ${cardLogs[0]?.review_logs.rating}, expected ${expected}`,
        );
    }
  }
  return failures;
}

async function checkI5(_now: Date): Promise<string[]> {
  const cards = await db.select().from(reviewCards).where(eq(reviewCards.userId, userId));
  const logs = await db
    .select()
    .from(reviewLogs)
    .innerJoin(reviewCards, eq(reviewLogs.cardId, reviewCards.id))
    .where(eq(reviewCards.userId, userId));
  const failures: string[] = [];
  for (const card of cards) {
    const fsrsDue = new Date((card.fsrs as { due: string | Date }).due).getTime();
    if (card.dueAt.getTime() !== fsrsDue)
      failures.push(
        `${card.conceptId}/${card.dimension}: dueAt=${card.dueAt.toISOString()} fsrs.due=${new Date(fsrsDue).toISOString()}`,
      );
    const cardLogs = logs.filter(({ review_cards: logCard }) => logCard.id === card.id);
    const newLogCount = cardLogs.length - (seededReviewLogCounts.get(card.id) ?? 0);
    const expectedReps = (seededReps.get(card.id) ?? card.reps) + newLogCount;
    if (card.reps !== expectedReps)
      failures.push(
        `${card.conceptId}/${card.dimension}: reps=${card.reps}, logs=${cardLogs.length}, seeded=${seededReps.get(card.id)}`,
      );
    const latestLog = cardLogs
      .map(({ review_logs: log }) => log)
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0];
    const doubleAgainRemediation = logs.some(
      ({ review_cards: dependentCard, review_logs: log }) =>
        log.createdAt.getTime() === card.dueAt.getTime() &&
        log.rating === String(Rating.Again) &&
        content.conceptsById
          .get(dependentCard.conceptId)
          ?.prereqs.some(
            (prerequisite) =>
              prerequisite.id === card.conceptId && prerequisite.strength === 'hard',
          ),
    );
    if (
      latestLog &&
      card.lastReviewAt &&
      localDateKey(latestLog.createdAt, timezone) === localDateKey(card.lastReviewAt, timezone)
    ) {
      const nextDay = shiftLocalDate(localDateKey(latestLog.createdAt, timezone), 1);
      if (localDateKey(card.dueAt, timezone) < nextDay && !doubleAgainRemediation) {
        failures.push(
          `${card.conceptId}/${card.dimension}: due ${card.dueAt.toISOString()} before next local day ${nextDay}; lastReviewAt=${card.lastReviewAt.toISOString()}`,
        );
      }
    }
  }
  return failures;
}

async function checkI6({
  now,
  today,
  active,
  selection,
  coverageResults,
}: AuditContext): Promise<string[]> {
  const openReviews = await db
    .select()
    .from(sessionActivities)
    .innerJoin(studySessions, eq(sessionActivities.sessionId, studySessions.id))
    .where(and(eq(studySessions.userId, userId), eq(sessionActivities.kind, 'review')));
  const planned = [
    ...todayActivities(today),
    ...(active?.activities ?? []).filter((activity: Record<string, any>) =>
      ['planned', 'in_progress'].includes(activity.status),
    ),
  ]
    .filter((activity: Record<string, any>) => activity.kind === 'review')
    .flatMap((activity: Record<string, any>) => activityTopics(activity));
  const selectedCoverage = selectedTaskCoverage(coverageResults, [
    ...todayActivities(today),
    ...(active?.activities ?? []).filter((activity: Record<string, any>) =>
      ['planned', 'in_progress'].includes(activity.status),
    ),
  ]);
  const allAttempts = await db.select().from(attempts).where(eq(attempts.userId, userId));
  const logs = await db
    .select()
    .from(reviewLogs)
    .innerJoin(reviewCards, eq(reviewLogs.cardId, reviewCards.id))
    .where(eq(reviewCards.userId, userId));
  const cards = await db.select().from(reviewCards).where(eq(reviewCards.userId, userId));
  const focusedConcepts = await focusedConceptIds();
  const failures = openReviews.flatMap(({ session_activities: activity }) => {
    const answered = allAttempts.some((attempt) => attempt.activityId === activity.id);
    if (!answered) return [];
    return activityTopics(activity).flatMap((conceptId) => {
      if (focusedConcepts && !focusedConcepts.has(conceptId)) return [];
      const concept = content.conceptsById.get(conceptId);
      if (!concept || concept.status === 'stub') return [];
      const dueUngraded = cards.some(
        (card) =>
          card.conceptId === conceptId &&
          isDueToday(card.dueAt, now, timezone) &&
          hasEligibleReviewExercise(card.conceptId, card.dimension) &&
          !logs.some(
            ({ review_cards: logCard, review_logs: log }) =>
              logCard.id === card.id &&
              allAttempts.some(
                (attempt) => attempt.activityId === activity.id && attempt.id === log.attemptId,
              ),
          ),
      );
      if (
        !dueUngraded ||
        planned.includes(conceptId) ||
        selectedCoverage.coveredConceptIds.has(conceptId)
      )
        return [];
      const dueCards = cards.filter(
        (card) => card.conceptId === conceptId && isDueToday(card.dueAt, now, timezone),
      );
      const plannerResult = selection?.results.find((result) => result.conceptId === conceptId);
      const hasConceptReviewLogToday = logs.some(
        ({ review_cards: logCard, review_logs: log }) =>
          logCard.conceptId === conceptId &&
          localDateKey(log.createdAt, timezone) === localDateKey(now, timezone),
      );
      if (plannerResult?.result === 'not_candidate:reviewedToday' && hasConceptReviewLogToday)
        return [];
      if (hasConceptReviewLogToday) return [];
      if (
        plannerResult?.result === 'rejected:reviewMinuteCap' &&
        selection &&
        !isReviewTopicOverdueByCardDueAt(conceptId, cards, now) &&
        reviewMinuteCapIsActuallyBinding(selection, conceptId, now)
      ) {
        for (const card of dueCards) recordBudgetDeferred('I6', card, now);
        return [];
      }
      const eligible = (content.exercisesByConcept.get(conceptId) ?? [])
        .filter((exercise) => dueCards.some((card) => card.dimension === exercise.dimension))
        .map((exercise) => exercise.id);
      return [
        `${conceptId}: partial review has answers but is absent from the next plan; due=${dueCards.map((card) => `${card.dimension}@${card.dueAt.toISOString()}`).join(',')}; eligible=${eligible.join(',')}; planned=${planned.join(',')}`,
      ];
    });
  });
  if (failures.length === 0) return failures;
  return failures.map((failure) => {
    const conceptId = failure.split(':')[0];
    const history = cards
      .filter((card) => card.conceptId === conceptId)
      .map((card) => ({
        dimension: card.dimension,
        dueAt: card.dueAt.toISOString(),
        dueAtEventsToday: (dueAtHistory.get(card.id) ?? [])
          .filter((event) => localDateKey(event.at, timezone) === localDateKey(now, timezone))
          .map((event) => ({
            at: event.at.toISOString(),
            dueAt: event.dueAt.toISOString(),
            cause: event.cause,
          })),
        reviewLogsToday: logs
          .filter(
            ({ review_cards: logCard, review_logs: log }) =>
              logCard.conceptId === conceptId &&
              localDateKey(log.createdAt, timezone) === localDateKey(now, timezone),
          )
          .map(({ review_cards: logCard, review_logs: log }) => ({
            dimension: logCard.dimension,
            rating: log.rating,
            attemptId: log.attemptId,
            createdAt: log.createdAt.toISOString(),
          })),
      }));
    return `${failure}; card dueAt history today=${JSON.stringify(history)}; session/planner=${JSON.stringify(plannerEvidenceForSession(active, conceptId))}`;
  });
}

async function checkI7({
  now,
  today,
  active,
  reviews,
  coverageResults,
}: AuditContext): Promise<string[]> {
  const learn = (await readApi('/learn', now)) as {
    tasks?: {
      activityKind?: string;
      conceptId?: string;
      reviewTopics?: { conceptId: string }[];
    }[];
  };
  const home = (learn.tasks ?? [])
    .filter((task) => task.activityKind === 'review')
    .flatMap(
      (task) =>
        task.reviewTopics?.map((topic) => topic.conceptId) ??
        (task.conceptId ? [task.conceptId] : []),
    );
  const [cards, logs] = await Promise.all([
    db.select().from(reviewCards).where(eq(reviewCards.userId, userId)),
    db
      .select({
        cardId: reviewLogs.cardId,
        rating: reviewLogs.rating,
        attemptId: reviewLogs.attemptId,
        createdAt: reviewLogs.createdAt,
      })
      .from(reviewLogs)
      .innerJoin(reviewCards, eq(reviewLogs.cardId, reviewCards.id))
      .where(eq(reviewCards.userId, userId)),
  ]);
  const dueTodayTopics = new Set(
    cards.filter((card) => isDueToday(card.dueAt, now, timezone)).map((card) => card.conceptId),
  );
  const reviewsDueTopics = new Set<string>(
    (reviews.topics ?? [])
      .filter((topic: Record<string, any>) => topic.due)
      .map((topic: Record<string, any>) => topic.conceptId as string),
  );
  const homeTopics = new Set<string>(home);
  const selectedCoverage = selectedTaskCoverage(coverageResults, [
    ...todayActivities(today),
    ...(active?.activities ?? []).filter((activity: Record<string, any>) =>
      ['planned', 'in_progress'].includes(activity.status),
    ),
    ...home.map((conceptId) => ({ conceptId })),
  ]);
  const activeReviewTopics = new Set(
    (active?.activities ?? [])
      .filter(
        (activity: Record<string, any>) =>
          activity.kind === 'review' && ['planned', 'in_progress'].includes(activity.status),
      )
      .flatMap((activity: Record<string, any>) => activityTopics(activity)),
  );
  const budgetNoteShown = today.dueReviews < reviews.dueNow;
  const failures: string[] = [];
  const cardHistory = (conceptId: string) =>
    cards
      .filter((card) => card.conceptId === conceptId)
      .map((card) => ({
        dimension: card.dimension,
        dueAt: card.dueAt.toISOString(),
        fsrsDue: (card.fsrs as { due?: string | Date }).due,
        lastReviewAt: card.lastReviewAt?.toISOString() ?? null,
        dueAtEventsToday: (dueAtHistory.get(card.id) ?? [])
          .filter((event) => localDateKey(event.at, timezone) === localDateKey(now, timezone))
          .map((event) => ({
            at: event.at.toISOString(),
            dueAt: event.dueAt.toISOString(),
            cause: event.cause,
          })),
        logs: logs
          .filter((log) => log.cardId === card.id)
          .map((log) => ({
            rating: log.rating,
            attemptId: log.attemptId,
            createdAt: log.createdAt.toISOString(),
          })),
      }));
  for (const conceptId of homeTopics) {
    if (
      dueTodayTopics.has(conceptId) ||
      activeReviewTopics.has(conceptId) ||
      selectedCoverage.coveringConceptIds.has(conceptId)
    )
      continue;
    failures.push(
      `I7(a) Home topic ${conceptId} is neither due today nor in an active review; card history=${JSON.stringify(cardHistory(conceptId))}`,
    );
  }
  if (!budgetNoteShown) {
    for (const conceptId of reviewsDueTopics) {
      if (homeTopics.has(conceptId) || selectedCoverage.coveredConceptIds.has(conceptId)) continue;
      failures.push(
        `I7(b) Reviews due topic ${conceptId} is not on Home and the budget note is not shown; card history=${JSON.stringify(cardHistory(conceptId))}`,
      );
    }
  }
  return failures;
}

async function checkI8(): Promise<string[]> {
  const rows = await db
    .select()
    .from(sessionActivities)
    .where(eq(sessionActivities.kind, 'review'));
  return rows.flatMap((activity) => {
    const ids = activity.exerciseIds;
    const topics = ids.map((id) => content.exercisesById.get(id)?.concept ?? `missing:${id}`);
    const unique = [...new Set(topics)];
    const failures: string[] = [];
    if (unique.length > 3) failures.push(`${activity.id}: ${unique.length} topics`);
    if (unique.length > 1) {
      for (let i = 1; i < topics.length; i += 1) {
        if (topics[i] === topics[i - 1] && topics.slice(i + 1).some((topic) => topic !== topics[i]))
          failures.push(
            `${activity.id}: repeats ${topics[i]} while another topic still has questions`,
          );
      }
    }
    if (topics.some((topic) => topic.startsWith('missing:')))
      failures.push(`${activity.id}: exercise has no source topic`);
    return failures;
  });
}

async function checkI9({ today, now }: AuditContext): Promise<string[]> {
  const second = await readApi('/today', now);
  return JSON.stringify(today.plan?.activities) === JSON.stringify(second.plan?.activities)
    ? []
    : ['identical state and X-Now returned different plans'];
}

const checkers: Array<(context: AuditContext) => Promise<string[]>> = [
  (context) => checkI1(context.now),
  checkI2,
  checkI3,
  () => checkI4(),
  (context) => checkI5(context.now),
  checkI6,
  checkI7,
  () => checkI8(),
  checkI9,
];

async function auditAll(now: Date, label: string) {
  auditTrail.push(label);
  checkpointBudgetDeferrals.clear();
  const [today, active, reviews] = await Promise.all([
    readApi('/today', now),
    readApi('/sessions/active', now),
    readApi('/reviews', now),
  ]);
  const isNewTodayPlan = label === 'GET /today' && today.activeSessionId === null;
  const selection = realDataAuditMode
    ? await plannerSelectionForAudit(now, today)
    : isNewTodayPlan
      ? await plannerSelectionAt(now, today)
      : undefined;
  const coverageResults = selection?.results ?? (await plannerSelectionAt(now, today)).results;
  currentPlanActivityIds = new Set(
    [...todayActivities(today), ...(active?.activities ?? [])]
      .map((activity: Record<string, any>) => activity.id)
      .filter((id: unknown): id is string => typeof id === 'string'),
  );
  const context = {
    now,
    label,
    today,
    active,
    reviews,
    coverageResults,
    ...(selection ? { selection } : {}),
  };
  const findings = new Map<string, string[]>();
  for (let index = 0; index < checkers.length; index += 1) {
    const name = checkerNames[index]!;
    const details = await checkers[index]!(context);
    findings.set(name, details);
    for (const detail of details) invariantViolation(name, detail);
  }
  return findings;
}

function assertNoAuditViolations(label: string, findings: Map<string, string[]>) {
  const runCreatedIds = [...activityCreationCalls.keys()];
  const runCreatedTopics = new Set(
    runCreatedIds
      .filter((id) => currentPlanActivityIds.has(id))
      .flatMap((id) => [...(runCreatedActivityTopics.get(id) ?? [])]),
  );
  const evidence = checkerNames.map((name) => ({
    checker: name,
    status: 'HOLDS' as 'HOLDS' | 'LEGACY' | 'BUDGET-DEFERRED' | 'VIOLATED',
    evidence: findings.get(name) ?? [],
  }));
  const deferredCheckers = new Set(
    [...checkpointBudgetDeferrals.values()].flatMap((record) => record.checkers),
  );
  for (const result of evidence) {
    const details = result.evidence;
    if (details.length === 0) {
      result.status = deferredCheckers.has(result.checker as 'I3' | 'I6')
        ? 'BUDGET-DEFERRED'
        : 'HOLDS';
      latestAuditStatuses.set(result.checker, result.status);
      continue;
    }
    const legacy = details.filter((detail) => {
      const conceptId = detail.split(':')[0];
      if (
        (result.checker === 'I2' || result.checker === 'I7') &&
        conceptId &&
        runCreatedTopics.has(conceptId)
      ) {
        return false;
      }
      return isLegacyFinding(detail, preRunEntityIds);
    });
    const newFindings = details.filter((detail) => !legacy.includes(detail));
    if (legacy.length > 0) {
      const known = legacyAuditFindings.get(result.checker) ?? new Set<string>();
      for (const detail of legacy) known.add(detail);
      legacyAuditFindings.set(result.checker, known);
    }
    result.status =
      newFindings.length > 0
        ? 'VIOLATED'
        : legacy.length > 0
          ? 'LEGACY'
          : deferredCheckers.has(result.checker as 'I3' | 'I6')
            ? 'BUDGET-DEFERRED'
            : 'HOLDS';
    latestAuditStatuses.set(result.checker, result.status);
  }
  auditCheckpoints.push({
    label,
    results: evidence.map((result) => ({
      checker: result.checker,
      status: result.status,
      evidence: [...result.evidence],
    })),
  });
  console.log(`REALDATA_CHECKPOINT ${JSON.stringify({ label, results: evidence })}`);
  if (checkpointBudgetDeferrals.size > 0) {
    console.log(
      `REALDATA_BUDGET_DEFERRED ${JSON.stringify({
        label,
        topics: [...checkpointBudgetDeferrals.values()].map((record) => ({
          ...record,
          checkers: [...record.checkers],
        })),
      })}`,
    );
  }
  if (evidence.some((result) => result.status === 'VIOLATED')) {
    throw new Error(
      `Real-data audit stopped after ${label} on findings not proven to predate the run; checker results:\n${JSON.stringify(evidence, null, 2)}`,
    );
  }
}

function explainPlannerCall(call: SchedulerCall) {
  if (call.kind === 'plan') {
    const [state, planContent, now, budget, _kind, _excludedLearn, excludedReview] = call.args;
    const coveredReviewConceptIds = [...(excludedReview ?? new Set<string>())];
    return {
      budget,
      coveredReviewConceptIds,
      usedExerciseIds: [...(state.usedExerciseIds ?? [])],
      results: explainReviewSelection(
        state,
        planContent,
        now,
        budget,
        new Set(coveredReviewConceptIds),
      ),
    };
  }
  const [state, planContent, now, budget, existingActivities] = call.args;
  return explainReviewSelectionForReplan(state, planContent, now, budget, existingActivities);
}

async function cardSnapshot() {
  const [cards, logs] = await Promise.all([
    db.select().from(reviewCards).where(eq(reviewCards.userId, userId)),
    db
      .select({
        id: reviewLogs.id,
        cardId: reviewLogs.cardId,
        conceptId: reviewCards.conceptId,
        dimension: reviewCards.dimension,
        rating: reviewLogs.rating,
        attemptId: reviewLogs.attemptId,
        createdAt: reviewLogs.createdAt,
        exerciseId: attempts.exerciseId,
      })
      .from(reviewLogs)
      .innerJoin(reviewCards, eq(reviewLogs.cardId, reviewCards.id))
      .leftJoin(attempts, eq(reviewLogs.attemptId, attempts.id))
      .where(eq(reviewCards.userId, userId)),
  ]);
  return { cards, logs };
}

async function recordDueAtChanges(before: Awaited<ReturnType<typeof cardSnapshot>>, now: Date) {
  const after = await cardSnapshot();
  const newLogIds = new Set(before.logs.map((log) => log.id));
  const newLogs = after.logs.filter((log) => !newLogIds.has(log.id));
  for (const card of after.cards) {
    const previous = before.cards.find((item) => item.id === card.id);
    if (!previous || previous.dueAt.getTime() === card.dueAt.getTime()) continue;
    const directLog = newLogs.find((log) => log.cardId === card.id);
    let cause = directLog
      ? `FSRS from review_log ${directLog.id}, rating=${directLog.rating}, attempt=${directLog.attemptId} during POST /attempts`
      : 'no matching review_log during POST /attempts';
    if (!directLog) {
      const prerequisiteLog = newLogs.find((log) =>
        content.conceptsById
          .get(log.conceptId)
          ?.prereqs.some(
            (prerequisite) =>
              prerequisite.strength === 'hard' && prerequisite.id === card.conceptId,
          ),
      );
      if (prerequisiteLog?.rating === String(Rating.Good)) {
        cause = `layering credit from review_log ${prerequisiteLog.id}, concept=${prerequisiteLog.conceptId}/${prerequisiteLog.dimension}, rating=${prerequisiteLog.rating}, attempt=${prerequisiteLog.attemptId} during POST /attempts`;
      } else if (prerequisiteLog?.rating === String(Rating.Again)) {
        const previousAgain = before.logs.some(
          (log) => log.cardId === prerequisiteLog.cardId && log.rating === String(Rating.Again),
        );
        if (previousAgain)
          cause = `double-Again from review_log ${prerequisiteLog.id}, concept=${prerequisiteLog.conceptId}/${prerequisiteLog.dimension}, rating=${prerequisiteLog.rating}, attempt=${prerequisiteLog.attemptId} during POST /attempts`;
      }
    }
    const events = dueAtHistory.get(card.id) ?? [];
    events.push({ at: now, dueAt: card.dueAt, cause });
    dueAtHistory.set(card.id, events);
  }
}

function plannerEvidenceForSession(active: Record<string, any> | null, conceptId: string) {
  const activities: Record<string, any>[] = active?.activities ?? [];
  const evidence = [
    ...new Set<PlanningEvidence>(
      activities
        .map((activity) => activityPlanningEvidence.get(activity.id))
        .filter((item): item is PlanningEvidence => !!item),
    ),
  ];
  return {
    id: active?.id ?? null,
    activities: activities.map((activity: Record<string, any>) => {
      const origin = activityPlanningEvidence.get(activity.id);
      const creationCall = activityCreationCalls.get(activity.id);
      return {
        id: activity.id,
        kind: activity.kind,
        status: activity.status,
        topics: activityTopics(activity),
        createdBy: creationCall
          ? `${creationCall.method} ${creationCall.path} at ${creationCall.now.toISOString()}`
          : origin
            ? `${origin.request.method} ${origin.request.path} at ${origin.request.now.toISOString()}`
            : 'origin not captured',
      };
    }),
    plannerInputs: evidence.map((item) => ({
      call: `${item.request.method} ${item.request.path}`,
      simulatedAt: item.request.now.toISOString(),
      budgetOrRemainingBudget: item.budget,
      coveredReviewConceptIds: item.coveredReviewConceptIds,
      usedExerciseIds: item.usedExerciseIds,
      selection: item.results.find((result) => result.conceptId === conceptId) ?? {
        result: 'concept was not due/eligible at planning time',
      },
    })),
  };
}

async function step(method: string, path: string, now: Date, body?: unknown) {
  const routeSessionId = path.match(/^\/sessions\/([^/]+)/)?.[1];
  const attemptActivityId =
    method === 'POST' &&
    path === '/attempts' &&
    typeof body === 'object' &&
    body !== null &&
    'activityId' in body &&
    typeof body.activityId === 'string'
      ? body.activityId
      : undefined;
  const [attemptActivity] = attemptActivityId
    ? await db
        .select({ sessionId: sessionActivities.sessionId })
        .from(sessionActivities)
        .where(eq(sessionActivities.id, attemptActivityId))
        .limit(1)
    : [];
  const sessionIdBefore =
    routeSessionId === 'active'
      ? (
          await db
            .select({ id: studySessions.id })
            .from(studySessions)
            .where(and(eq(studySessions.userId, userId), eq(studySessions.status, 'active')))
            .limit(1)
        )[0]?.id
      : (routeSessionId ?? attemptActivity?.sessionId);
  const previousRows = sessionIdBefore
    ? await db
        .select({ id: sessionActivities.id })
        .from(sessionActivities)
        .where(eq(sessionActivities.sessionId, sessionIdBefore))
    : [];
  const previousIds = new Set(previousRows.map((row) => row.id));
  const callStart = schedulerCalls.length;
  const cardsBeforeAttempt =
    method === 'POST' && path === '/attempts' ? await cardSnapshot() : undefined;
  const requestCall = { method, path, now };
  currentApiCall = requestCall;
  let response: Response;
  try {
    const init = {
      method,
      headers: headersAt(now),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    };
    response =
      realDataAuditMode && apiBaseUrl
        ? await fetch(`${apiBaseUrl}/api${path}`, init)
        : await app.request(`/api${path}`, init);
  } finally {
    currentApiCall = undefined;
  }
  const data = (await response.json()) as Record<string, any>;
  if (method === 'POST' && path === '/attempts' && typeof data.attemptId === 'string') {
    runCreatedAttemptIds.add(data.attemptId);
    if (realDataAuditMode) {
      const createdLogs = await db
        .select({ id: reviewLogs.id })
        .from(reviewLogs)
        .where(eq(reviewLogs.attemptId, data.attemptId));
      for (const log of createdLogs) runCreatedReviewLogIds.add(log.id);
    }
  }
  if (cardsBeforeAttempt) await recordDueAtChanges(cardsBeforeAttempt, now);
  let sessionId = path === '/sessions' ? data.id : sessionIdBefore;
  if (!sessionId && schedulerCalls.length > callStart) {
    const activeSession = await db
      .select({ id: studySessions.id })
      .from(studySessions)
      .where(and(eq(studySessions.userId, userId), eq(studySessions.status, 'active')))
      .limit(1);
    sessionId = activeSession[0]?.id;
  }
  if (sessionId) {
    const rows = await db
      .select()
      .from(sessionActivities)
      .where(eq(sessionActivities.sessionId, sessionId));
    const createdRows = rows.filter((row) => !previousIds.has(row.id));
    for (const row of createdRows) {
      activityCreationCalls.set(row.id, requestCall);
      runCreatedActivityTopics.set(row.id, new Set(activityTopics(row)));
    }
    for (const call of schedulerCalls.slice(callStart)) {
      const explained = explainPlannerCall(call);
      const evidence: PlanningEvidence = {
        request: call.request,
        sessionId,
        createdActivityIds: createdRows.map((row) => row.id),
        ...explained,
      };
      for (const row of createdRows) activityPlanningEvidence.set(row.id, evidence);
    }
  }
  const findings = await auditAll(now, `${method} ${path}`);
  if (realDataAuditMode) assertNoAuditViolations(`${method} ${path}`, findings);
  return { response, data };
}

async function seedLearner(now: Date) {
  await db.delete(users);
  await db.insert(users).values({
    id: userId,
    displayName: 'Review audit learner',
    timezone,
    startDate,
    activeCourseId: 'fixture-course',
    prefs: { scheduleMinutes: 600, saturdayMinutes: 600, sundayMinutes: 600 },
  });
  await db.insert(courseEnrollments).values(
    ['fixture-course', 'fixture-switching-course', 'fixture-third-course'].map((courseId) => ({
      userId,
      courseId,
      status: 'active' as const,
      startMethod: 'beginning' as const,
      startedAt: now,
    })),
  );
  await db.insert(mastery).values(
    content.concepts.flatMap((concept) =>
      concept.dimensions.map((dimension) => ({
        userId,
        conceptId: concept.id,
        dimension,
        state: 'independent' as const,
      })),
    ),
  );
  seededReps.clear();
  seededReviewLogCounts.clear();
  violations.clear();
  auditTrail.length = 0;
  attemptFailures.length = 0;
  schedulerCalls.length = 0;
  activityPlanningEvidence.clear();
  activityCreationCalls.clear();
  runCreatedActivityTopics.clear();
  runCreatedAttemptIds.clear();
  runCreatedReviewLogIds.clear();
  legacyAuditFindings.clear();
  latestAuditStatuses.clear();
  currentPlanActivityIds.clear();
  reviewAnswerStats.attempted = 0;
  reviewAnswerStats.seededWrong = 0;
  reviewAnswerStats.actuallyWrong = 0;
  dueAtHistory.clear();
  lowCreditPickedUpCardKeys.clear();
}

async function seedCards(now: Date) {
  const specs: Array<[string, string, number]> = [
    ['vectors', 'math', -5],
    ['vectors', 'conceptual', -3],
    ['derivatives', 'math', -2],
    ['derivatives', 'conceptual', -1],
    ['gradients', 'math', -8],
    ['gradients', 'conceptual', 2],
    ['linear-algebra', 'math', -4],
    ['matrix-products', 'math', -10],
    ['switching-topic', 'math', -6],
    ['switching-topic', 'conceptual', 4],
    ['linear-models', 'math', -7],
    ['linear-models', 'conceptual', -2],
    ['loss-functions', 'math', 7],
    ['gradient-descent', 'math', -1],
    ['gradient-descent', 'implementation', -9],
    ['supervised-learning', 'conceptual', -5],
  ];
  for (const [index, [conceptId, dimension, offset]] of specs.entries()) {
    await addReviewCard(now, conceptId, dimension, offset, index);
  }
}

async function addReviewCard(
  now: Date,
  conceptId: string,
  dimension: string,
  offset: number,
  index: number,
) {
  const dueAt = new Date(now.getTime() + offset * 86_400_000);
  const reviewAt = new Date(dueAt.getTime() - (2 + (index % 9)) * 86_400_000);
  const fsrs = {
    ...scheduleReview(newReviewCard(reviewAt), reviewAt, Rating.Good, timezone, false).card,
    due: dueAt,
  };
  const [card] = await db
    .insert(reviewCards)
    .values({
      userId,
      conceptId,
      dimension,
      fsrs,
      dueAt,
      reps: fsrs.reps,
      lapses: fsrs.lapses,
    })
    .returning();
  if (!card) throw new Error(`Could not seed ${conceptId}/${dimension}`);
  seededReps.set(card.id, card.reps);
  dueAtHistory.set(card.id, [{ at: now, dueAt, cause: 'seeded' }]);
  return card;
}

async function withReviewCandidateScope<T>(
  conceptIds: string[],
  run: () => Promise<T>,
): Promise<T> {
  const previousContent = content;
  const previousApp = app;
  const allowedConcepts = new Set(conceptIds);
  content = {
    ...previousContent,
    exercisesByConcept: new Map(
      [...previousContent.exercisesByConcept].filter(([conceptId]) =>
        allowedConcepts.has(conceptId),
      ),
    ),
    lessonsByConcept: new Map(),
  };
  app = createApp({ db, content, tutorProvider: new FakeProvider() });
  try {
    return await run();
  } finally {
    content = previousContent;
    app = previousApp;
  }
}

async function activateReviewIfPlanned(
  sessionId: string,
  activity: Record<string, any>,
  now: Date,
) {
  if (activity.status !== 'planned') return;
  const { response, data } = await step(
    'POST',
    `/sessions/${sessionId}/activities/${activity.id}/progress`,
    now,
    {},
  );
  if (!response.ok) {
    throw new Error(`Could not activate review ${activity.id}: ${JSON.stringify(data)}`);
  }
}

async function completeReviewIfNeeded(sessionId: string, activity: Record<string, any>, now: Date) {
  const [current] = await db
    .select({ status: sessionActivities.status })
    .from(sessionActivities)
    .where(eq(sessionActivities.id, activity.id));
  if (current?.status === 'completed') return;
  const { response, data } = await step(
    'POST',
    `/sessions/${sessionId}/activities/${activity.id}/progress`,
    now,
    { complete: true },
  );
  if (!response.ok) {
    throw new Error(`Could not complete review ${activity.id}: ${JSON.stringify(data)}`);
  }
}

function answerFor(exerciseId: string) {
  return answerForExercise(content, exerciseId);
}

function seededWrongAnswerFor(exerciseId: string) {
  return seededWrongAnswerForExercise(content, exerciseId);
}

function shouldSeedWrongReviewAnswer(exerciseId: string, now: Date) {
  const seed = `${exerciseId}|${localDateKey(now, timezone)}`;
  let hash = 0;
  for (const character of seed) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return hash % 4 === 0;
}

type DueTopicSnapshot = { due: Set<string>; eligible: Set<string> };

async function dueTopicSnapshot(now: Date): Promise<DueTopicSnapshot> {
  const cards = await db.select().from(reviewCards).where(eq(reviewCards.userId, userId));
  const due = new Set<string>();
  const eligible = new Set<string>();
  for (const card of cards) {
    const concept = content.conceptsById.get(card.conceptId);
    if (!concept || concept.status === 'stub' || !isDueToday(card.dueAt, now, timezone)) continue;
    due.add(card.conceptId);
    if (hasEligibleReviewExercise(card.conceptId, card.dimension)) eligible.add(card.conceptId);
  }
  return { due, eligible };
}

async function reviewedTopicsOn(day: string): Promise<Set<string>> {
  const logs = await db
    .select({ conceptId: reviewCards.conceptId, createdAt: reviewLogs.createdAt })
    .from(reviewLogs)
    .innerJoin(reviewCards, eq(reviewLogs.cardId, reviewCards.id))
    .where(eq(reviewCards.userId, userId));
  return new Set(
    logs.filter((log) => localDateKey(log.createdAt, timezone) === day).map((log) => log.conceptId),
  );
}

function localDateTime(day: string, wallTime: string): Date {
  const dateParts = day.split('-').map(Number);
  const timeParts = wallTime.split(':').map(Number);
  const [year, month, date] = dateParts;
  const [hour, minute] = timeParts;
  if (
    dateParts.length !== 3 ||
    timeParts.length !== 2 ||
    year === undefined ||
    month === undefined ||
    date === undefined ||
    hour === undefined ||
    minute === undefined
  ) {
    throw new Error(`Invalid local date/time: ${day} ${wallTime}`);
  }
  const desiredWallTime = Date.UTC(year, month - 1, date, hour, minute);
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  let instant = desiredWallTime;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = Object.fromEntries(
      formatter
        .formatToParts(new Date(instant))
        .filter((part) => part.type !== 'literal')
        .map((part) => [part.type, Number(part.value)]),
    );
    const actualWallTime = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second),
    );
    instant += desiredWallTime - actualWallTime;
  }
  return new Date(instant);
}

async function plannerSelectionAt(
  now: Date,
  today: Record<string, any>,
): Promise<PlannerSelection> {
  const repo = new LearnerRepository(db, userId);
  const [learner, rawState] = await Promise.all([repo.user(), repo.schedulerState(now, content)]);
  const state = filterSchedulerStateForContent(content, rawState);
  const day = localDateKey(now, timezone);
  const sessionKind =
    (today.sessionKind as Parameters<typeof sessionBudget>[0] | undefined) ??
    sessionKindForDate(day);
  const budget = sessionBudget(
    sessionKind,
    (learner?.prefs ?? {}) as Parameters<typeof sessionBudget>[1],
    day,
  );
  return { state, budget, results: explainReviewSelection(state, content, now, budget) };
}

function resumedSelectionSnapshot(): ResumedSelectionSnapshot | undefined {
  const value = process.env.REVIEW_AUDIT_RESUME_SELECTION_SNAPSHOT;
  if (!value) return undefined;
  try {
    return JSON.parse(value) as ResumedSelectionSnapshot;
  } catch {
    throw new Error('REVIEW_AUDIT_RESUME_SELECTION_SNAPSHOT must be valid JSON.');
  }
}

async function plannerSelectionForAudit(
  now: Date,
  today: Record<string, any>,
): Promise<PlannerSelection> {
  const day = localDateKey(now, timezone);
  const cached = morningPlannerSelections.get(day);
  if (cached) return cached;
  const selection = await plannerSelectionAt(now, today);
  const snapshot = resumedSelectionSnapshot();
  const resumeDay = process.env.REVIEW_AUDIT_RESUME_AT
    ? localDateKey(new Date(process.env.REVIEW_AUDIT_RESUME_AT), timezone)
    : undefined;
  const deferredConcepts = new Set(
    snapshot?.day === day && day === resumeDay
      ? snapshot.budgetDeferredTopics.map((topic) => topic.conceptId)
      : [],
  );
  const resumedResults = selection.results.map((result) =>
    deferredConcepts.has(result.conceptId)
      ? { ...result, result: 'rejected:reviewMinuteCap' as const }
      : result,
  );
  for (const conceptId of deferredConcepts) {
    if (resumedResults.some((result) => result.conceptId === conceptId)) continue;
    resumedResults.push({
      conceptId,
      result: 'rejected:reviewMinuteCap',
      exerciseIds:
        snapshot?.notSelected.find((item) => item.conceptId === conceptId)?.selectedExerciseIds ??
        [],
      exerciseDimensions: [],
      reviewMinutes: 0,
      reviewCap: 0,
      usedMinutes: 0,
      budget: selection.budget,
      plannedActivityCount: 0,
    });
  }
  const withResumeReasons =
    deferredConcepts.size > 0 ? { ...selection, results: resumedResults } : selection;
  if (now.getTime() === localDateTime(day, '08:00').getTime()) {
    morningPlannerSelections.set(day, withResumeReasons);
  }
  return withResumeReasons;
}

function schedulerReviewPriority(state: PlannerSelection['state'], conceptId: string, now: Date) {
  const dueCards = state.cards.filter(
    (card) =>
      card.conceptId === conceptId && isDueToday(card.dueAt, now, state.timezone ?? timezone),
  );
  const activity = buildReviewActivityForConcept(state, content, now, conceptId, dueCards);
  if (!activity) return undefined;
  const weighted = Object.entries(activity.reason.terms).reduce(
    (total, [key, value]) =>
      total + value * SCHEDULER_CONFIG.weights[key as keyof typeof SCHEDULER_CONFIG.weights],
    0,
  );
  return weighted / Math.sqrt(Math.max(1, activity.plannedMinutes));
}

function updateBudgetDeferralStreaks(day: string, reviewedToday: Set<string>) {
  const dayRecords = budgetDeferralsByDay.get(day) ?? new Map<string, BudgetDeferredRecord>();
  const deferredTopics = new Set(
    [...dayRecords.values()]
      .map((record) => record.conceptId)
      .filter((conceptId) => !reviewedToday.has(conceptId)),
  );
  for (const conceptId of new Set([...budgetDeferralStreaks.keys(), ...deferredTopics])) {
    if (!deferredTopics.has(conceptId)) {
      budgetDeferralStreaks.delete(conceptId);
      continue;
    }
    const previous = budgetDeferralStreaks.get(conceptId);
    const days = previous && shiftLocalDate(previous.through, 1) === day ? previous.days + 1 : 1;
    const since = previous && days > 1 ? previous.since : day;
    const interval = { since, through: day, days };
    budgetDeferralStreaks.set(conceptId, interval);
    const longest = longestBudgetDeferrals.get(conceptId);
    if (!longest || days > longest.days) longestBudgetDeferrals.set(conceptId, interval);
    if (days > 2) {
      throw new Error(
        `Budget deferral starvation: ${conceptId} remained BUDGET-DEFERRED for ${days} consecutive local days (more than 2; ${since} through ${day}).`,
      );
    }
  }
}

async function explainSelectionAt08(
  now: Date,
  today: Record<string, any>,
  active: Record<string, any> | null,
) {
  const day = localDateKey(now, timezone);
  const { state, budget, results } = await plannerSelectionForAudit(now, today);
  const snapshot = resumedSelectionSnapshot();
  const resumeSnapshot = snapshot?.day === day ? snapshot : undefined;
  const plannedActivities = todayActivities(today) as Array<{
    kind: string;
    plannedMinutes?: number | null;
  }>;
  const cards = await db.select().from(reviewCards).where(eq(reviewCards.userId, userId));
  const dueCardsByTopic = new Map<string, typeof cards>();
  for (const card of cards) {
    if (!isDueToday(card.dueAt, now, timezone)) continue;
    const topicCards = dueCardsByTopic.get(card.conceptId) ?? [];
    topicCards.push(card);
    dueCardsByTopic.set(card.conceptId, topicCards);
  }
  const selectedInPlan = new Set<string>(
    todayActivities(today)
      .filter((activity: Record<string, any>) => activity.kind === 'review')
      .flatMap((activity: Record<string, any>) => activityTopics(activity)),
  );
  const deferredResults = results.filter((result) => result.result === 'rejected:reviewMinuteCap');
  for (const result of deferredResults) {
    for (const card of dueCardsByTopic.get(result.conceptId) ?? []) {
      recordBudgetDeferred('I3', card, now);
    }
  }
  const priorities = new Map<string, number | undefined>();
  for (const result of results) {
    priorities.set(result.conceptId, schedulerReviewPriority(state, result.conceptId, now));
  }
  const dueAtFor = (conceptId: string) =>
    (dueCardsByTopic.get(conceptId) ?? [])
      .map((card) => card.dueAt)
      .sort((left, right) => left.getTime() - right.getTime())[0];
  const computedPriorityFindings = deferredResults.flatMap((deferred) => {
    const deferredDueAt = dueAtFor(deferred.conceptId);
    const deferredPriority = priorities.get(deferred.conceptId);
    if (!deferredDueAt || deferredPriority === undefined) return [];
    return [...selectedInPlan].flatMap((selectedConceptId) => {
      if (selectedConceptId === deferred.conceptId) return [];
      const selectedDueAt = dueAtFor(selectedConceptId);
      const selectedPriority = priorities.get(selectedConceptId);
      if (
        !selectedDueAt ||
        selectedPriority === undefined ||
        selectedDueAt.getTime() <= deferredDueAt.getTime()
      ) {
        return [];
      }
      return [
        {
          selectedConceptId,
          selectedDueAt: selectedDueAt.toISOString(),
          selectedPriority,
          deferredConceptId: deferred.conceptId,
          deferredDueAt: deferredDueAt.toISOString(),
          deferredPriority,
          priorityInversion: deferredPriority > selectedPriority,
        },
      ];
    });
  });
  const priorityFindings = resumeSnapshot?.priorityFindings ?? computedPriorityFindings;
  const notSelected = results
    .filter(
      (result) =>
        !['selected', 'selected:overdue'].includes(result.result) ||
        !selectedInPlan.has(result.conceptId),
    )
    .map((result) => ({
      conceptId: result.conceptId,
      reason:
        result.result === 'selected' || result.result === 'selected:overdue'
          ? 'selected by a fresh pack but absent from the current session plan'
          : result.result,
      selectedExerciseIds: result.exerciseIds,
      selectedInCurrentPlan: selectedInPlan.has(result.conceptId),
    }));
  const notSelectedForReport = resumeSnapshot?.notSelected ?? notSelected;
  const selectedTopicsForReport =
    resumeSnapshot?.selectedInCurrentPlan ?? [...selectedInPlan].sort();
  const resultByConcept = new Map(results.map((result) => [result.conceptId, result.result]));
  const selectedOverdueTopics = selectedTopicsForReport.filter(
    (conceptId) => resultByConcept.get(conceptId) === 'selected:overdue',
  );
  const selectedCappedTopics = selectedTopicsForReport.filter(
    (conceptId) => resultByConcept.get(conceptId) === 'selected',
  );
  const reviewMinutes = plannedActivities
    .filter((activity) => activity.kind === 'review')
    .reduce((total, activity) => total + (activity.plannedMinutes ?? 0), 0);
  const newLessonMinutes = plannedActivities
    .filter((activity) => activity.kind === 'learn')
    .reduce((total, activity) => total + (activity.plannedMinutes ?? 0), 0);
  const deferredTopicsForReport =
    resumeSnapshot?.budgetDeferredTopics ??
    [...new Set(deferredResults.map((result) => result.conceptId))].sort().map((conceptId) => ({
      conceptId,
      dueAt: dueAtFor(conceptId)?.toISOString() ?? '',
      priority: priorities.get(conceptId) ?? 0,
    }));
  console.log(
    `REALDATA_SELECTION ${JSON.stringify({
      day,
      budgetMinutes: budget,
      activeSessionId: active?.id ?? null,
      dueTopicCount: resumeSnapshot?.dueTopicCount ?? results.length,
      selectedInCurrentPlan: selectedTopicsForReport,
      selectedCount: selectedTopicsForReport.length,
      selectedCappedTopics,
      selectedOverdueTopics,
      reviewMinutes,
      newLessonMinutes,
      budgetDeferredTopics: deferredTopicsForReport,
      notSelected: notSelectedForReport,
      priorityFindings,
    })}`,
  );
  return {
    day,
    dueTopicCount: resumeSnapshot?.dueTopicCount ?? results.length,
    selectedTopics: selectedTopicsForReport,
    selectedCappedTopics,
    selectedOverdueTopics,
    reviewMinutes,
    newLessonMinutes,
    budgetDeferredTopics: deferredTopicsForReport.map((topic) => topic.conceptId),
    notSelected: notSelectedForReport,
    priorityFindings,
  };
}

type MorningSelectionAudit = Awaited<ReturnType<typeof explainSelectionAt08>>;

const reviewAnswerStats = { attempted: 0, seededWrong: 0, actuallyWrong: 0 };

async function submitSeededAnswer(
  activity: Record<string, any>,
  exerciseId: string,
  now: Date,
  mode: 'practice' | 'assessment' | 'review',
) {
  const priorAttempts = await db
    .select()
    .from(attempts)
    .where(
      and(
        eq(attempts.userId, userId),
        eq(attempts.activityId, activity.id),
        eq(attempts.exerciseId, exerciseId),
      ),
    );
  if (
    priorAttempts.some(
      (attempt) => attempt.mode === mode && (mode === 'review' || attempt.correct >= 1),
    )
  ) {
    return;
  }
  const exercise = content.exercisesById.get(exerciseId);
  if (!exercise)
    throw new Error(`No real-content exercise ${exerciseId} for activity ${activity.id}.`);
  const seededWrong = mode === 'review' && shouldSeedWrongReviewAnswer(exerciseId, now);
  const baseAnswer = seededWrong ? seededWrongAnswerFor(exerciseId) : answerFor(exerciseId);
  const submit = (answer: unknown) =>
    step('POST', '/attempts', now, {
      exerciseId,
      activityId: activity.id,
      answer,
      mode,
      durationMs: 1_000,
    });
  let result = await submit(baseAnswer);
  if (result.data.status === 'self_check_required' && exercise.type === 'explain') {
    const scoringCriteria = exercise.rubric.some((criterion) => criterion.required)
      ? exercise.rubric.filter((criterion) => criterion.required)
      : exercise.rubric;
    const text =
      typeof baseAnswer === 'object' &&
      baseAnswer !== null &&
      'text' in baseAnswer &&
      typeof baseAnswer.text === 'string'
        ? baseAnswer.text
        : 'A correct explanation.';
    result = await submit({
      text,
      metCriteria: scoringCriteria.map((criterion) => criterion.id),
    });
  }
  if (
    result.response.ok &&
    result.data.status === 'graded' &&
    Number(result.data.correct) < 1 &&
    result.data.retryAllowed === true &&
    !seededWrong
  ) {
    result = await submit(baseAnswer);
  }
  const gradedWrong = result.data.status === 'graded' && Number(result.data.correct) < 1;
  if (!result.response.ok || result.data.status !== 'graded' || (gradedWrong && !seededWrong)) {
    throw new Error(
      `Could not submit the seeded answer (${activity.kind}/${exerciseId}): ${result.response.status} ${JSON.stringify(result.data)}`,
    );
  }
  if (mode === 'review') {
    reviewAnswerStats.attempted += 1;
    if (seededWrong) reviewAnswerStats.seededWrong += 1;
    if (gradedWrong) reviewAnswerStats.actuallyWrong += 1;
  }
}

async function completeActivityThroughApi(
  sessionId: string,
  activity: Record<string, any>,
  now: Date,
) {
  const result = await step(
    'POST',
    `/sessions/${sessionId}/activities/${activity.id}/progress`,
    now,
    { complete: true },
  );
  if (!result.response.ok) {
    throw new Error(
      `Could not complete ${activity.kind} activity ${activity.id}: ${result.response.status} ${JSON.stringify(result.data)}`,
    );
  }
}

async function runSessionAt08(
  now: Date,
  skippedActivities: Set<string>,
  selectionAudits: MorningSelectionAudit[],
  includeSelectionExplanation = true,
) {
  const { response: todayResponse, data: today } = await step('GET', '/today', now);
  if (!todayResponse.ok) {
    throw new Error(`GET /today failed: ${todayResponse.status} ${JSON.stringify(today)}`);
  }
  const { response: activeResponse, data: active } = await step('GET', '/sessions/active', now);
  if (!activeResponse.ok) {
    throw new Error(
      `GET /sessions/active failed: ${activeResponse.status} ${JSON.stringify(active)}`,
    );
  }
  if (includeSelectionExplanation) {
    selectionAudits.push(await explainSelectionAt08(now, today, active));
  }
  let sessionId: string;
  if (active?.id) {
    sessionId = active.id;
  } else {
    const kind = today.sessionKind ?? sessionKindForDate(localDateKey(now, timezone));
    const { response, data } = await step('POST', '/sessions', now, { kind });
    if (!response.ok || typeof data.id !== 'string') {
      throw new Error(`POST /sessions failed: ${response.status} ${JSON.stringify(data)}`);
    }
    sessionId = data.id;
  }
  const { response: openResponse, data: session } = await step(
    'GET',
    `/sessions/${sessionId}`,
    now,
  );
  if (!openResponse.ok) {
    throw new Error(
      `Opening session ${sessionId} failed: ${openResponse.status} ${JSON.stringify(session)}`,
    );
  }
  for (const activity of [...(session.activities ?? [])].sort(
    (left: Record<string, any>, right: Record<string, any>) => (left.idx ?? 0) - (right.idx ?? 0),
  )) {
    if (activity.status === 'completed' || activity.status === 'skipped') continue;
    if (activity.kind === 'learn') {
      const lesson = activity.conceptId
        ? content.lessonsByConcept.get(activity.conceptId)
        : undefined;
      if (lesson && (lesson.knowledge_points?.length || lesson.blocks.length > 0)) {
        skippedActivities.add(
          `${localDateKey(now, timezone)} learn/${activity.conceptId ?? activity.id}`,
        );
        continue;
      }
    }
    if (activity.kind === 'review') {
      for (const exerciseId of activity.exerciseIds ?? []) {
        await submitSeededAnswer(activity, exerciseId, now, 'review');
      }
      continue;
    }
    if (activity.kind === 'paper') {
      await completeActivityThroughApi(sessionId, activity, now);
      continue;
    }
    if (activity.kind === 'lab' || activity.kind === 'project') {
      skippedActivities.add(
        `${localDateKey(now, timezone)} ${activity.kind}/${activity.conceptId ?? activity.projectId ?? activity.id}`,
      );
      continue;
    }
    const mode = activity.kind === 'quick_check' ? 'assessment' : 'practice';
    for (const exerciseId of activity.exerciseIds ?? []) {
      await submitSeededAnswer(activity, exerciseId, now, mode);
    }
    const [current] = await db
      .select({ status: sessionActivities.status })
      .from(sessionActivities)
      .where(eq(sessionActivities.id, activity.id))
      .limit(1);
    if (current?.status !== 'completed') {
      await completeActivityThroughApi(sessionId, activity, now);
    }
  }
  const { response, data } = await step('GET', `/sessions/${sessionId}`, now);
  if (!response.ok) {
    throw new Error(
      `Refreshing session ${sessionId} failed: ${response.status} ${JSON.stringify(data)}`,
    );
  }
}

async function runRealDataAudit() {
  const resumeAtValue = process.env.REVIEW_AUDIT_RESUME_AT;
  const startedAt = resumeAtValue ? new Date(resumeAtValue) : new Date();
  if (Number.isNaN(startedAt.getTime())) {
    throw new Error('REVIEW_AUDIT_RESUME_AT must be an ISO timestamp.');
  }
  const resumed = process.env.REVIEW_AUDIT_RESUME === '1' || Boolean(resumeAtValue);
  const today = localDateKey(startedAt, timezone);
  const todayAt20 = localDateTime(today, '20:00');
  const includeToday20 = todayAt20.getTime() > startedAt.getTime();
  const dailyDue = new Map<string, DueTopicSnapshot>();
  const dailyRows: Array<Record<string, unknown>> = [];
  const selectionAudits: MorningSelectionAudit[] = [];
  const skippedActivities = new Set<string>();
  const startSnapshot = resumedSelectionSnapshot();
  const initialDue = await dueTopicSnapshot(startedAt);
  if (startSnapshot?.day === today) {
    const resumedDueTopics = new Set([
      ...initialDue.due,
      ...startSnapshot.selectedInCurrentPlan,
      ...startSnapshot.budgetDeferredTopics.map((topic) => topic.conceptId),
    ]);
    dailyDue.set(today, {
      due: resumedDueTopics,
      eligible: new Set([...initialDue.eligible, ...resumedDueTopics]),
    });
  } else {
    dailyDue.set(today, initialDue);
  }

  const firstFindings = await auditAll(startedAt, 'now');
  assertNoAuditViolations('now', firstFindings);
  const activeResult = await step('GET', '/sessions/active', startedAt);
  if (!activeResult.response.ok || typeof activeResult.data?.id !== 'string') {
    throw new Error(
      `Could not locate the active session at now: ${JSON.stringify(activeResult.data)}`,
    );
  }
  const sessionId = activeResult.data.id;
  if (process.env.REVIEW_AUDIT_SESSION_ID && process.env.REVIEW_AUDIT_SESSION_ID !== sessionId) {
    throw new Error(
      `Expected active session ${process.env.REVIEW_AUDIT_SESSION_ID}, found ${sessionId}.`,
    );
  }
  const opened = await step('GET', `/sessions/${sessionId}`, startedAt);
  if (!opened.response.ok) {
    throw new Error(`Could not open active session ${sessionId}: ${JSON.stringify(opened.data)}`);
  }
  const session = opened.data;
  const priorReviewActivities = (session.activities ?? []).filter(
    (activity: Record<string, any>) => activity.kind === 'review',
  );
  const coveredReviewTopics = new Set(
    priorReviewActivities.flatMap((activity: Record<string, any>) => activityTopics(activity)),
  );
  const priorReviewExerciseIds = new Set(
    priorReviewActivities.flatMap((activity: Record<string, any>) => activity.exerciseIds ?? []),
  );
  const maximumLikelihoodMathCovered = (
    content.exercisesByConcept.get('maximum-likelihood') ?? []
  ).some((exercise) => exercise.dimension === 'math' && priorReviewExerciseIds.has(exercise.id));
  const elapsedMinutes = session.startedAt
    ? Math.max(0, Math.floor((startedAt.getTime() - Date.parse(session.startedAt)) / 60_000))
    : 0;
  const remainingBudgetMinutes = Math.max(0, session.plannedMinutes - elapsedMinutes);
  const previousActivityIds = new Set(activityCreationCalls.keys());
  const replanned = resumed
    ? null
    : await step('POST', `/sessions/${sessionId}/replan`, startedAt, {
        remainingBudgetMinutes,
      });
  if (replanned && !replanned.response.ok) {
    throw new Error(
      `Replan failed: ${replanned.response.status} ${JSON.stringify(replanned.data)}`,
    );
  }
  const refreshed = await step('GET', `/sessions/${sessionId}`, startedAt);
  if (!refreshed.response.ok) {
    throw new Error(`Could not refresh replanned session: ${JSON.stringify(refreshed.data)}`);
  }
  const newReviewActivities = (refreshed.data.activities ?? []).filter(
    (activity: Record<string, any>) =>
      activity.kind === 'review' &&
      activityCreationCalls.has(activity.id) &&
      !previousActivityIds.has(activity.id),
  );
  const addedReviewTopics = new Set(
    newReviewActivities.flatMap((activity: Record<string, any>) => activityTopics(activity)),
  );
  const addedDimensions: Array<{
    conceptId: string | undefined;
    dimension: string | undefined;
    exerciseId: string;
  }> = newReviewActivities.flatMap((activity: Record<string, any>) =>
    (activity.exerciseIds ?? []).map((exerciseId: string) => {
      const conceptId = activityTopics(activity).find((topic) =>
        content.exercisesByConcept.get(topic)?.some((candidate) => candidate.id === exerciseId),
      );
      const exercise = conceptId
        ? (content.exercisesByConcept.get(conceptId) ?? []).find(
            (candidate) => candidate.id === exerciseId,
          )
        : undefined;
      return {
        conceptId,
        dimension: exercise?.dimension,
        exerciseId,
      };
    }),
  );
  const duplicateCoveredTopics = [...addedReviewTopics].filter((topic) =>
    coveredReviewTopics.has(topic),
  );
  if (resumed) {
    console.log(
      `REALDATA_RESUME ${JSON.stringify({
        sessionId,
        startedAt: startedAt.toISOString(),
        activeReviewTopics: [...coveredReviewTopics].sort(),
        maximumLikelihoodMathCovered,
      })}`,
    );
  } else {
    console.log(
      `REALDATA_REPLAN ${JSON.stringify({
        sessionId,
        remainingBudgetMinutes,
        addedReviewTopics: [...addedReviewTopics].sort(),
        addedDimensions,
        addedLogisticRegression: addedReviewTopics.has('logistic-regression'),
        maximumLikelihoodMathCoveredBefore: maximumLikelihoodMathCovered,
        addedMaximumLikelihoodMath: addedDimensions.some(
          (exercise) =>
            exercise.conceptId === 'maximum-likelihood' && exercise.dimension === 'math',
        ),
        duplicateCoveredTopics,
      })}`,
    );
    if (duplicateCoveredTopics.length > 0) {
      throw new Error(
        `Replan added already-covered review topics: ${duplicateCoveredTopics.join(', ')}`,
      );
    }
  }
  const initialIs08 = startedAt.getTime() === localDateTime(today, '08:00').getTime();
  await runSessionAt08(startedAt, skippedActivities, selectionAudits, initialIs08);
  const activeAfterCompletion = await step('GET', '/sessions/active', startedAt);
  if (activeAfterCompletion.data?.id === sessionId) {
    const ended = await step('POST', `/sessions/${sessionId}/end`, startedAt);
    if (!ended.response.ok) {
      throw new Error(
        `Could not end active session: ${ended.response.status} ${JSON.stringify(ended.data)}`,
      );
    }
  }
  const futureDays = resumed ? 13 : 14;
  for (const moment of [
    ...(includeToday20 ? [{ day: today, wallTime: '20:00', instant: todayAt20 }] : []),
    ...Array.from({ length: futureDays }, (_, index) => {
      const day = shiftLocalDate(today, index + 1);
      return [
        { day, wallTime: '08:00', instant: localDateTime(day, '08:00') },
        { day, wallTime: '20:00', instant: localDateTime(day, '20:00') },
      ];
    }).flat(),
  ]) {
    if (moment.wallTime === '08:00') {
      dailyDue.set(moment.day, await dueTopicSnapshot(moment.instant));
      await runSessionAt08(moment.instant, skippedActivities, selectionAudits);
    } else {
      const findings = await auditAll(moment.instant, `${moment.day} ${moment.wallTime}`);
      assertNoAuditViolations(`${moment.day} ${moment.wallTime}`, findings);
      const snapshot = dailyDue.get(moment.day) ?? { due: new Set(), eligible: new Set() };
      const reviewed = await reviewedTopicsOn(moment.day);
      const reviewedDue = new Set([...snapshot.due].filter((conceptId) => reviewed.has(conceptId)));
      const eligibleUnreviewed = [...snapshot.eligible].filter(
        (conceptId) => !reviewed.has(conceptId),
      );
      const morning = [...selectionAudits].reverse().find((audit) => audit.day === moment.day);
      const selectedTopics = (morning?.selectedTopics ?? []).filter((conceptId) =>
        snapshot.due.has(conceptId),
      );
      const budgetDeferredTopics = new Set([
        ...(morning?.budgetDeferredTopics ?? []),
        ...[...(budgetDeferralsByDay.get(moment.day)?.values() ?? [])].map(
          (record) => record.conceptId,
        ),
      ]);
      const row = {
        day: moment.day,
        due: snapshot.due.size,
        selected: selectedTopics.length,
        selectedCapped: morning?.selectedCappedTopics.length ?? 0,
        selectedOverdue: morning?.selectedOverdueTopics.length ?? 0,
        reviewed: reviewedDue.size,
        budgetDeferred: budgetDeferredTopics.size,
        reviewMinutes: morning?.reviewMinutes ?? 0,
        newLessonMinutes: morning?.newLessonMinutes ?? 0,
        dueTopics: snapshot.due.size,
        selectedTopics,
        reviewedDueTopics: reviewedDue.size,
        budgetDeferredTopics: [...budgetDeferredTopics].sort(),
        dueConceptIds: [...snapshot.due].sort(),
        reviewedDueConceptIds: [...reviewedDue].sort(),
        eligibleDueButUnreviewed: eligibleUnreviewed.sort(),
      };
      dailyRows.push(row);
      console.log(`REALDATA_DAY ${JSON.stringify(row)}`);
      updateBudgetDeferralStreaks(moment.day, reviewed);
    }
  }

  console.log(
    `REALDATA_AUDIT_REPORT ${JSON.stringify({
      learnerCount: 1,
      timezone,
      startedAt: startedAt.toISOString(),
      apiPort: apiBaseUrl ? new URL(apiBaseUrl).port : null,
      reviewAnswerStats,
      checkers: checkerNames.map((checker) => ({
        checker,
        status: latestAuditStatuses.get(checker) ?? 'HOLDS',
        legacyFindings: [...(legacyAuditFindings.get(checker) ?? [])],
      })),
      dailyDueVsReviewed: dailyRows,
      morningSelectionExplanations: selectionAudits,
      longestBudgetDeferrals: [...longestBudgetDeferrals].map(([conceptId, interval]) => ({
        conceptId,
        ...interval,
      })),
      checkerResults: auditCheckpoints,
      skippedLearnOrProjectActivities: [...skippedActivities].sort(),
    })}`,
  );
}

let simulationDone = false;

beforeAll(async () => {
  if (realDataAuditMode) {
    const databaseName = new URL(env.TEST_DATABASE_URL).pathname.replace(/^\//, '');
    const expectedDatabaseName = process.env.REVIEW_AUDIT_DATABASE_NAME ?? 'academy_realdata';
    if (databaseName !== expectedDatabaseName) {
      throw new Error(
        `Real-data audit requires TEST_DATABASE_URL to target ${expectedDatabaseName}.`,
      );
    }
    if (!apiBaseUrl) {
      throw new Error('Real-data audit requires REVIEW_AUDIT_API_URL.');
    }
    content = await loadContent();
    const learners = await db.select({ id: users.id }).from(users).limit(2);
    if (learners.length !== 1) {
      throw new Error(`Expected one real learner in ${databaseName}, found ${learners.length}.`);
    }
    const learner = learners[0];
    if (!learner) throw new Error(`No real learner found in ${databaseName}.`);
    userId = process.env.REVIEW_AUDIT_USER_ID ?? learner.id;
    if (!learners.some((learner) => learner.id === userId)) {
      throw new Error(
        `REVIEW_AUDIT_USER_ID does not identify the sole learner in ${databaseName}.`,
      );
    }
    app = createApp({ db, content, tutorProvider: new FakeProvider() });
    const cards = await db.select().from(reviewCards).where(eq(reviewCards.userId, userId));
    seededReps.clear();
    for (const card of cards) seededReps.set(card.id, card.reps);
    const initialLogs = await db
      .select({ cardId: reviewLogs.cardId })
      .from(reviewLogs)
      .innerJoin(reviewCards, eq(reviewLogs.cardId, reviewCards.id))
      .where(eq(reviewCards.userId, userId));
    seededReviewLogCounts.clear();
    for (const { cardId } of initialLogs) {
      seededReviewLogCounts.set(cardId, (seededReviewLogCounts.get(cardId) ?? 0) + 1);
    }
    violations.clear();
    simulationFindings.clear();
    auditTrail.length = 0;
    attemptFailures.length = 0;
    schedulerCalls.length = 0;
    activityPlanningEvidence.clear();
    activityCreationCalls.clear();
    runCreatedActivityTopics.clear();
    runCreatedAttemptIds.clear();
    runCreatedReviewLogIds.clear();
    checkpointBudgetDeferrals.clear();
    budgetDeferralsByDay.clear();
    budgetDeferralStreaks.clear();
    longestBudgetDeferrals.clear();
    morningPlannerSelections.clear();
    legacyAuditFindings.clear();
    latestAuditStatuses.clear();
    auditCheckpoints.length = 0;
    currentPlanActivityIds.clear();
    reviewAnswerStats.attempted = 0;
    reviewAnswerStats.seededWrong = 0;
    reviewAnswerStats.actuallyWrong = 0;
    const priorRunStartValue = process.env.REVIEW_AUDIT_RUN_STARTED_AT;
    auditRunStartedAt = priorRunStartValue ? new Date(priorRunStartValue) : new Date();
    if (Number.isNaN(auditRunStartedAt.getTime())) {
      throw new Error('REVIEW_AUDIT_RUN_STARTED_AT must be an ISO timestamp.');
    }
    preRunEntityIds.clear();
    const oldSessions = await db
      .select({ id: studySessions.id, startedAt: studySessions.startedAt })
      .from(studySessions)
      .where(eq(studySessions.userId, userId));
    for (const session of oldSessions) {
      if (session.startedAt && session.startedAt < auditRunStartedAt) {
        preRunEntityIds.add(session.id);
      }
    }
    const activitiesWithSession = await db
      .select({
        activityId: sessionActivities.id,
        sessionId: sessionActivities.sessionId,
        sessionStartedAt: studySessions.startedAt,
        exerciseIds: sessionActivities.exerciseIds,
      })
      .from(sessionActivities)
      .innerJoin(studySessions, eq(sessionActivities.sessionId, studySessions.id))
      .where(eq(studySessions.userId, userId));
    for (const activity of activitiesWithSession) {
      if (activity.sessionStartedAt && activity.sessionStartedAt < auditRunStartedAt) {
        preRunEntityIds.add(activity.activityId);
      } else if (activity.sessionStartedAt) {
        const call = {
          method: 'POST',
          path: `/sessions/${activity.sessionId}`,
          now: activity.sessionStartedAt,
        };
        activityCreationCalls.set(activity.activityId, call);
        runCreatedActivityTopics.set(activity.activityId, new Set(topicIds(activity.exerciseIds)));
      }
    }
    const priorAttempts = await db
      .select({ id: attempts.id, createdAt: attempts.createdAt })
      .from(attempts)
      .where(eq(attempts.userId, userId));
    for (const attempt of priorAttempts) {
      if (attempt.createdAt < auditRunStartedAt) preRunEntityIds.add(attempt.id);
      else runCreatedAttemptIds.add(attempt.id);
    }
    const priorLogs = await db
      .select({ id: reviewLogs.id, createdAt: reviewLogs.createdAt })
      .from(reviewLogs)
      .innerJoin(reviewCards, eq(reviewLogs.cardId, reviewCards.id))
      .where(eq(reviewCards.userId, userId));
    for (const log of priorLogs) {
      if (log.createdAt < auditRunStartedAt) preRunEntityIds.add(log.id);
      else runCreatedReviewLogIds.add(log.id);
    }
    for (const card of cards) preRunEntityIds.add(card.id);
    const learnerRecord = await db
      .select({ id: users.id, createdAt: users.createdAt })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (learnerRecord[0] && learnerRecord[0].createdAt < auditRunStartedAt) {
      preRunEntityIds.add(learnerRecord[0].id);
    }
    dueAtHistory.clear();
    return;
  }
  content = await loadContent('tests/fixtures/content');
  app = createApp({ db, content, tutorProvider: new FakeProvider() });
  const planSession = schedulerModule.planSession;
  const replan = schedulerModule.replan;
  vi.spyOn(schedulerModule, 'planSession').mockImplementation((...args) => {
    if (currentApiCall) schedulerCalls.push({ kind: 'plan', args, request: { ...currentApiCall } });
    return planSession(...args);
  });
  vi.spyOn(schedulerModule, 'replan').mockImplementation((...args) => {
    if (currentApiCall)
      schedulerCalls.push({ kind: 'replan', args, request: { ...currentApiCall } });
    return replan(...args);
  });
  const now = atLocalNoon(startDate);
  await seedLearner(now);
  await seedCards(now);
  let day = startDate;
  let random = 0x51a7;
  const nextRandom = () => {
    random = (random * 1_664_525 + 1_013_904_223) >>> 0;
    return random / 0x1_0000_0000;
  };
  for (let dateIndex = 0; dateIndex < 30; dateIndex += 1) {
    lowCreditPickedUpCardKeys.clear();
    const nowAtDay = atLocalNoon(day);
    await step('GET', '/today', nowAtDay);
    await step('GET', '/reviews', nowAtDay);
    const { response, data: session } = await step('POST', '/sessions', nowAtDay, {
      budgetMinutes: 600,
    });
    if (!response.ok)
      throw new Error(`POST /sessions failed ${response.status}: ${JSON.stringify(session)}`);
    await step('GET', '/sessions/active', nowAtDay);
    for (const activity of session.activities ?? []) {
      if (activity.status === 'completed') continue;
      for (const exerciseId of activity.exerciseIds ?? []) {
        const exercise = content.exercisesById.get(exerciseId);
        if (!exercise) continue;
        const hint = activity.kind !== 'quick_check' && nextRandom() < 0.08;
        if (hint)
          await step('POST', '/hints', nowAtDay, {
            exerciseId,
            activityId: activity.id,
            mode: activity.kind === 'review' ? 'review' : 'practice',
            stuck: activity.kind === 'review',
          });
        const wrong = nextRandom() < 0.12;
        const answer = wrong ? wrongAnswerForExercise(content, exerciseId) : answerFor(exerciseId);
        const durationMs =
          exercise.target_seconds && nextRandom() < 0.2
            ? (exercise.target_seconds + 5) * 1000
            : 1_000;
        const mode =
          activity.kind === 'review'
            ? 'review'
            : activity.kind === 'quick_check'
              ? 'assessment'
              : activity.kind === 'diagnostic'
                ? 'diagnostic'
                : 'practice';
        const { response: attemptResponse, data: attemptResult } = await step(
          'POST',
          '/attempts',
          nowAtDay,
          {
            exerciseId,
            activityId: activity.id,
            answer,
            mode,
            durationMs,
          },
        );
        if (!attemptResponse.ok) {
          attemptFailures.push(
            `${activity.kind}/${exerciseId}: ${attemptResponse.status} ${JSON.stringify(attemptResult)}`,
          );
          continue;
        }
        if (attemptResult.retryAllowed && wrong) {
          await step('POST', '/attempts', nowAtDay, {
            exerciseId,
            activityId: activity.id,
            answer: answerFor(exerciseId),
            mode,
            durationMs: 1_000,
          });
        }
      }
      if (activity.kind === 'review') continue;
      const progressResult = await step(
        'POST',
        `/sessions/${session.id}/activities/${activity.id}/progress`,
        nowAtDay,
        { complete: true },
      );
      if (!progressResult.response.ok) {
        attemptFailures.push(
          `Progress ${activity.id} rejected: ${progressResult.response.status} ${JSON.stringify(progressResult.data)}`,
        );
      }
    }
    if (dateIndex === 0) {
      const later = (session.activities ?? []).find(
        (activity: Record<string, any>) => activity.status === 'planned',
      );
      if (later) await step('POST', `/sessions/${session.id}/replan`, nowAtDay, {});
    }
    const endOfDayCards = await db.select().from(reviewCards).where(eq(reviewCards.userId, userId));
    const endOfDayLogs = await db
      .select({
        conceptId: reviewCards.conceptId,
        createdAt: reviewLogs.createdAt,
      })
      .from(reviewLogs)
      .innerJoin(reviewCards, eq(reviewLogs.cardId, reviewCards.id))
      .where(eq(reviewCards.userId, userId));
    const gradedAtEndOfDay = new Set(
      endOfDayLogs
        .filter((log) => localDateKey(log.createdAt, timezone) === localDateKey(nowAtDay, timezone))
        .map((log) => log.conceptId),
    );
    for (const card of endOfDayCards) {
      const concept = content.conceptsById.get(card.conceptId);
      if (
        !concept ||
        concept.status === 'stub' ||
        !isDueToday(card.dueAt, nowAtDay, timezone) ||
        gradedAtEndOfDay.has(card.conceptId) ||
        !hasEligibleReviewExercise(card.conceptId, card.dimension) ||
        lowCreditPickedUpCardKeys.has(`${card.conceptId}/${card.dimension}`) ||
        budgetDeferralsByDay
          .get(localDateKey(nowAtDay, timezone))
          ?.get(`${card.conceptId}/${card.dimension}`)
          ?.checkers.includes('I3')
      ) {
        continue;
      }
      const overdueDays = localDayDifference(
        localDateKey(card.dueAt, timezone),
        localDateKey(nowAtDay, timezone),
      );
      if (overdueDays > 2) {
        invariantViolation(
          'I3',
          `${card.conceptId}/${card.dimension} remained overdue ${overdueDays} local days after ${day}`,
        );
      }
    }
    day = shiftLocalDate(day, 1);
  }
  for (const name of checkerNames) {
    simulationFindings.set(name, [...(violations.get(name) ?? [])]);
  }
  simulationStepCount = auditTrail.length;
  simulationAttemptFailures = [...attemptFailures];
  simulationDone = true;
}, 300_000);

afterAll(async () => {
  if (!realDataAuditMode) await db.delete(users).where(eq(users.id, userId));
  await db.$client.end();
});

async function assertInvariant(name: string) {
  expect(simulationDone).toBe(true);
  const found = [...(simulationFindings.get(name) ?? [])];
  if (name === 'I1') {
    const now = atLocalNoon(startDate);
    await seedLearner(now);
    await seedCards(now);
    const { data: session } = await step('POST', '/sessions', now, { budgetMinutes: 600 });
    await step('POST', `/sessions/${session.id}/replan`, now, {});
    found.push(...(violations.get('I1') ?? []));
  }
  if (name === 'I4') {
    found.push(
      ...simulationAttemptFailures.map((failure) => `Rejected attempt/progress: ${failure}`),
    );
  }
  const failedAttempts =
    name === 'I4' ? `\nRejected attempts: ${simulationAttemptFailures.join('\n')}` : '';
  expect(
    found,
    `${name} violations:\n${found.join('\n')}\nAudited ${simulationStepCount} API steps${failedAttempts}`,
  ).toEqual([]);
}

it('I1 assertion includes simulated findings', async () => {
  const previousFindings = simulationFindings.get('I1');
  simulationFindings.set('I1', ['synthetic I1 simulation finding']);
  try {
    await expect(assertInvariant('I1')).rejects.toThrow('synthetic I1 simulation finding');
  } finally {
    if (previousFindings) simulationFindings.set('I1', previousFindings);
    else simulationFindings.delete('I1');
  }
});

vitestIt('classifies findings as legacy only when every identifier predates the run', () => {
  const preRunId = '25c6f1c4-c6f2-470f-9eae-65ef24f51c9b';
  const runCreatedId = '5d3e6aa1-0e46-435b-9cfc-186841e3afdd';
  const preRunIds = new Set([preRunId]);
  expect(isLegacyFinding(`old activity ${preRunId}`, preRunIds)).toBe(true);
  expect(isLegacyFinding('identifier-free I9 finding', preRunIds)).toBe(false);
  expect(isLegacyFinding(`old ${preRunId} and new ${runCreatedId}`, preRunIds)).toBe(false);
});

vitestIt('recognizes coverage only when the covering task is planned', () => {
  const result: PlannerSelection['results'][number] = {
    conceptId: 'vectors',
    result: 'covered',
    coveringConceptId: 'linear-models',
    exerciseIds: [],
    exerciseDimensions: [],
    reviewMinutes: 1,
    reviewCap: 30,
    usedMinutes: 1,
    budget: 40,
    plannedActivityCount: 1,
  };

  const planned = selectedTaskCoverage(
    [result],
    [{ kind: 'review', conceptId: 'linear-models', exerciseIds: [] }],
  );
  expect([...planned.coveredConceptIds]).toEqual(['vectors']);
  expect([...planned.coveringConceptIds]).toEqual(['linear-models']);

  const absent = selectedTaskCoverage(
    [result],
    [{ kind: 'review', conceptId: 'gradient-descent', exerciseIds: [] }],
  );
  expect([...absent.coveredConceptIds]).toEqual([]);
  expect([...absent.coveringConceptIds]).toEqual([]);
});

// I1: session replan can schedule an already-covered topic again.
it('I1 review scheduling invariant', () => assertInvariant('I1'));
// I2: completing a review does not reliably keep its topics out of Home.
it('I2 review scheduling invariant', () => assertInvariant('I2'));
// I3: due cards with eligible exercises can be omitted unless a selected task covers them.
it('I3 review scheduling invariant', () => assertInvariant('I3'));
it('I3 replans a due prerequisite after a completed low-credit coverer', async () => {
  const now = atLocalNoon(startDate);
  await seedLearner(now);
  await addReviewCard(now, 'gradient-descent', 'math', -1, 0);
  await addReviewCard(now, 'derivatives', 'math', -2, 1);

  const { response: sessionResponse, data: session } = await step('POST', '/sessions', now, {
    budgetMinutes: 600,
  });
  expect(sessionResponse.ok).toBe(true);
  const coverer = session.activities.find(
    (activity: Record<string, any>) =>
      activity.kind === 'review' && activityTopics(activity).includes('gradient-descent'),
  );
  if (!coverer) throw new Error('Missing gradient-descent covering review');
  expect(activityTopics(coverer)).not.toContain('derivatives');
  expect(
    activityPlanningEvidence
      .get(coverer.id)
      ?.results.find((result) => result.conceptId === 'derivatives'),
  ).toMatchObject({
    result: 'covered',
    coveringConceptId: 'gradient-descent',
  });
  await activateReviewIfPlanned(session.id, coverer, now);

  for (const exerciseId of coverer.exerciseIds) {
    const exercise = content.exercisesById.get(exerciseId);
    const wrong =
      exercise?.concept === 'gradient-descent'
        ? wrongAnswerForExercise(content, exerciseId)
        : undefined;
    const answer = wrong ?? answerFor(exerciseId);
    const { response, data } = await step('POST', '/attempts', now, {
      exerciseId,
      activityId: coverer.id,
      answer,
      mode: 'review',
    });
    expect(response.ok, JSON.stringify(data)).toBe(true);
    if (data.retryAllowed && wrong) {
      const { response: retryResponse, data: retryData } = await step('POST', '/attempts', now, {
        exerciseId,
        activityId: coverer.id,
        answer: wrong,
        mode: 'review',
      });
      expect(retryResponse.ok, JSON.stringify(retryData)).toBe(true);
    }
  }
  await completeReviewIfNeeded(session.id, coverer, now);

  const coveringRatings = await db
    .select({ rating: reviewLogs.rating })
    .from(reviewLogs)
    .innerJoin(attempts, eq(reviewLogs.attemptId, attempts.id))
    .innerJoin(reviewCards, eq(reviewLogs.cardId, reviewCards.id))
    .where(and(eq(attempts.activityId, coverer.id), eq(reviewCards.conceptId, 'gradient-descent')));
  expect(coveringRatings.length).toBeGreaterThan(0);
  expect(Math.min(...coveringRatings.map(({ rating }) => Number(rating)))).toBe(Rating.Again);

  const derivativeCard = (
    await db
      .select()
      .from(reviewCards)
      .where(
        and(
          eq(reviewCards.userId, userId),
          eq(reviewCards.conceptId, 'derivatives'),
          eq(reviewCards.dimension, 'math'),
        ),
      )
  )[0];
  expect(derivativeCard && isDueToday(derivativeCard.dueAt, now, timezone)).toBe(true);
  const derivativeLogs = await db
    .select({ createdAt: reviewLogs.createdAt })
    .from(reviewLogs)
    .innerJoin(reviewCards, eq(reviewLogs.cardId, reviewCards.id))
    .where(
      and(
        eq(reviewCards.userId, userId),
        eq(reviewCards.conceptId, 'derivatives'),
        eq(reviewCards.dimension, 'math'),
      ),
    );
  expect(
    derivativeLogs.some(
      ({ createdAt }) => localDateKey(createdAt, timezone) === localDateKey(now, timezone),
    ),
  ).toBe(false);

  const { response: endResponse } = await step('POST', `/sessions/${session.id}/end`, now);
  expect(endResponse.ok).toBe(true);
  const { data: today } = await step('GET', '/today', now);
  expect(
    todayActivities(today).some(
      (activity: Record<string, any>) =>
        activity.kind === 'review' && activityTopics(activity).includes('derivatives'),
    ),
    JSON.stringify(
      todayActivities(today).map((activity: Record<string, any>) => ({
        kind: activity.kind,
        status: activity.status,
        conceptId: activity.conceptId,
        topics: activityTopics(activity),
      })),
    ),
  ).toBe(true);
});
// I4: completed activities can leave covered cards ungraded.
it('I4 review scheduling invariant', () => assertInvariant('I4'));
// I5: double-Again can move a graded prerequisite card before tomorrow.
it('I5 review scheduling invariant', () => assertInvariant('I5'));
// I6: partial answers can disappear unless their due cards are covered by a selected task.
it('I6 review scheduling invariant', () => assertInvariant('I6'));
// I7: Home topics must be due, active, or a selected coverer; due Reviews need Home, coverage, or the budget note.
it('I7 review scheduling invariant', () => assertInvariant('I7'));
// I8: mixed reviews can repeat a topic before switching to another.
it('I8 review scheduling invariant', () => assertInvariant('I8'));
it('I9 review scheduling invariant', () => assertInvariant('I9'));

it('S2 keeps a partial review available while it remains active', async () => {
  const now = atLocalNoon(startDate);
  await seedLearner(now);
  await seedCards(now);
  const { data: today } = await step('GET', '/today', now);
  const { data: session } = await step('POST', '/sessions', now, { budgetMinutes: 600 });
  const activity = (session.activities ?? []).find(
    (item: Record<string, any>) => item.kind === 'review',
  );
  if (!activity)
    throw new Error(`No review activity in plan ${JSON.stringify(today.plan?.activities)}`);
  const firstExercise = activity.exerciseIds[0];
  await step('POST', '/attempts', now, {
    exerciseId: firstExercise,
    activityId: activity.id,
    answer: answerFor(firstExercise),
    mode: 'review',
  });
  await step('POST', `/sessions/${session.id}/replan`, now, {});
  const { data: active } = await step('GET', '/sessions/active', now);
  expect(
    (active.activities ?? []).some(
      (item: Record<string, any>) => item.id === activity.id && item.status === 'in_progress',
    ),
  ).toBe(true);
  const found = [...(violations.get('I6') ?? [])];
  expect(
    found,
    'An in-progress review remains available even when Home plans a fresh review set',
  ).toEqual([]);
});

it('S1 keeps mixed review topics out of a replan', async () => {
  const now = atLocalNoon(startDate);
  await seedLearner(now);
  await seedCards(now);
  const { data: session } = await step('POST', '/sessions', now, { budgetMinutes: 600 });
  const first = (session.activities ?? []).find(
    (item: Record<string, any>) => item.kind === 'review',
  );
  if (!first) throw new Error('No review activity to replan');
  await step('POST', `/sessions/${session.id}/replan`, now, {});
  const found = [...(violations.get('I1') ?? [])];
  expect(found, 'I1 should not repeat a covered review topic after replan').toEqual([]);
});

it('S3 Today and Home expose the active session review topics', async () => {
  const now = atLocalNoon(startDate);
  await seedLearner(now);
  await seedCards(now);
  await step('GET', '/today', now);
  const { data: session } = await step('POST', '/sessions', now, {
    budgetMinutes: 600,
  });
  const { data: today } = await step('GET', '/today', now);
  expect(
    today.plan.activities
      .filter((activity: Record<string, any>) => activity.kind === 'review')
      .flatMap((activity: Record<string, any>) => activityTopics(activity)),
  ).toEqual(
    session.activities
      .filter((activity: Record<string, any>) => activity.kind === 'review')
      .flatMap((activity: Record<string, any>) => activityTopics(activity)),
  );
  const found = [...(violations.get('I7') ?? [])];
  expect(found, 'Home and Today should expose the same active review plan').toEqual([]);
});

it('S4 starting another session preserves answers from an abandoned partial review', async () => {
  const now = atLocalNoon(startDate);
  await seedLearner(now);
  await addReviewCard(now, 'vectors', 'math', -5, 0);
  const { data: session } = await step('POST', '/sessions', now, { budgetMinutes: 600 });
  const review = session.activities.find((item: Record<string, any>) => item.kind === 'review');
  if (!review) throw new Error('No review activity');
  await step('POST', '/attempts', now, {
    exerciseId: review.exerciseIds[0],
    activityId: review.id,
    answer: answerFor(review.exerciseIds[0]),
    mode: 'review',
  });
  await step('POST', '/sessions', new Date(now.getTime() + 60_000), { budgetMinutes: 600 });
  const preserved = await db
    .select()
    .from(attempts)
    .where(and(eq(attempts.activityId, review.id), eq(attempts.exerciseId, review.exerciseIds[0])));
  expect(preserved).toHaveLength(1);
  const found = [...(violations.get('I6') ?? [])];
  expect(found, 'an ungraded attempt must not hide a due topic').toEqual([]);
});

it('S5 reports an eligible due topic hidden after an ungraded practice attempt', async () => {
  const now = atLocalNoon(startDate);
  await seedLearner(now);
  const card = await addReviewCard(now, 'vectors', 'math', -1, 0);
  const exerciseId = 'vectors-fixture-practice-1';
  const { response } = await step('POST', '/attempts', now, {
    exerciseId,
    answer: answerFor(exerciseId),
    mode: 'practice',
  });
  expect(response.ok).toBe(true);
  expect(await db.select().from(reviewLogs).where(eq(reviewLogs.cardId, card.id))).toHaveLength(0);
  expect(
    [...(violations.get('I7') ?? [])],
    'an ungraded practice attempt should not hide a due topic from Home',
  ).toEqual([]);
});

it('excludes due topics without eligible exercises from I7 comparisons', async () => {
  const now = atLocalNoon(startDate);
  await seedLearner(now);
  const dueAt = new Date(now.getTime() - 86_400_000);
  const fsrs = { ...newReviewCard(dueAt), due: dueAt };
  await db
    .insert(reviewCards)
    .values({ userId, conceptId: 'vectors', dimension: 'transfer', dueAt, fsrs });
  await step('GET', '/today', now);
  await step('GET', '/reviews', now);
  expect(violations.get('I7') ?? []).toEqual([]);
});

it('S6 rejects review attempts without a review activity', async () => {
  const now = atLocalNoon(startDate);
  await seedLearner(now);
  await seedCards(now);
  for (const exerciseId of ['vectors-fixture-practice-1', 'vectors-fixture-practice-2']) {
    const { response, data } = await step('POST', '/attempts', now, {
      exerciseId,
      answer: answerFor(exerciseId),
      mode: 'review',
    });
    expect(response.status).toBe(400);
    expect(data).toMatchObject({
      error: 'Review attempts need a review activity.',
    });
  }
  const card = (
    await db
      .select()
      .from(reviewCards)
      .where(
        and(
          eq(reviewCards.userId, userId),
          eq(reviewCards.conceptId, 'vectors'),
          eq(reviewCards.dimension, 'math'),
        ),
      )
  )[0];
  if (!card) throw new Error('Missing vectors math card');
  const logs = await db.select().from(reviewLogs).where(eq(reviewLogs.cardId, card.id));
  expect(logs).toEqual([]);
});

it('rejects completing a review before every activity exercise has an attempt', async () => {
  const now = atLocalNoon(startDate);
  await seedLearner(now);
  await seedCards(now);
  const { data: session } = await step('POST', '/sessions', now, { budgetMinutes: 600 });
  const review = session.activities.find(
    (activity: Record<string, any>) => activity.kind === 'review',
  );
  if (!review) throw new Error('No review activity');
  const { response, data } = await step(
    'POST',
    `/sessions/${session.id}/activities/${review.id}/progress`,
    now,
    { complete: true },
  );
  expect(response.status).toBe(409);
  expect(data).toMatchObject({
    error: 'Review activity needs an attempt for every exercise before completion.',
  });
});

it('a review log on one dimension hides every due dimension for that topic today', async () => {
  const now = atLocalNoon(startDate);
  await seedLearner(now);
  const card = await addReviewCard(now, 'vectors', 'math', -1, 0);
  await addReviewCard(now, 'vectors', 'conceptual', -1, 0);
  const exercise = content.exercisesById.get('vectors-fixture-practice-1');
  if (!exercise) throw new Error('Missing vectors review exercise');
  const scheduled = scheduleReview(card.fsrs as never, now, Rating.Good, timezone, false);
  const [attempt] = await db
    .insert(attempts)
    .values({
      userId,
      exerciseId: exercise.id,
      exerciseVersion: exercise.contentVersion,
      conceptId: 'vectors',
      dimension: 'math',
      mode: 'review',
      answer: 'correct',
      correct: 1,
      credit: 1,
      hintsUsed: 0,
      attemptNo: 1,
      gradedBy: 'test',
      feedback: {},
      createdAt: now,
    })
    .returning();
  if (!attempt) throw new Error('Could not create review attempt');
  await db.insert(reviewLogs).values({
    cardId: card.id,
    attemptId: attempt.id,
    rating: String(Rating.Good),
    fsrsLog: scheduled.log,
    createdAt: now,
  });
  await db
    .update(reviewCards)
    .set({
      dueAt: scheduled.card.due,
      lastReviewAt: now,
      reps: scheduled.card.reps,
      lapses: scheduled.card.lapses,
      fsrs: scheduled.card,
    })
    .where(eq(reviewCards.id, card.id));

  const { data: today } = await step('GET', '/today', now);
  expect(
    today.plan.activities.some(
      (activity: Record<string, any>) =>
        activity.kind === 'review' && activityTopics(activity).includes('vectors'),
    ),
  ).toBe(false);
});

it('S7 checks card updates for two uncovered due topics in one mixed review', async () => {
  await withReviewCandidateScope(['vectors', 'switching-topic'], async () => {
    const now = atLocalNoon(startDate);
    await seedLearner(now);
    await addReviewCard(now, 'vectors', 'math', -5, 0);
    await addReviewCard(now, 'switching-topic', 'math', -4, 1);
    const { data: session } = await step('POST', '/sessions', now, { budgetMinutes: 600 });
    const activity = session.activities.find(
      (item: Record<string, any>) =>
        item.kind === 'review' &&
        activityTopics(item).includes('vectors') &&
        activityTopics(item).includes('switching-topic'),
    );
    if (!activity) throw new Error('No vectors/switching-topic mixed activity');
    for (const exerciseId of activity.exerciseIds) {
      await step('POST', '/attempts', now, {
        exerciseId,
        activityId: activity.id,
        answer: answerFor(exerciseId),
        mode: 'review',
      });
    }
    const cardRows = await db
      .select()
      .from(reviewCards)
      .where(
        and(
          eq(reviewCards.userId, userId),
          inArray(reviewCards.conceptId, ['vectors', 'switching-topic']),
        ),
      );
    const mismatch = cardRows.filter(
      (card) =>
        new Date((card.fsrs as { due: string | Date }).due).getTime() !== card.dueAt.getTime(),
    );
    expect(mismatch.map((card) => `${card.conceptId}/${card.dimension}`)).toEqual([]);
  });
});

it('S7 keeps a covered prerequisite out of a mixed review of uncovered topics', async () => {
  await withReviewCandidateScope(['vectors', 'derivatives', 'switching-topic'], async () => {
    const now = atLocalNoon(startDate);
    await seedLearner(now);
    await addReviewCard(now, 'vectors', 'math', -5, 0);
    const { data: vectorSession } = await step('POST', '/sessions', now, {
      budgetMinutes: 600,
    });
    const vectorReview = vectorSession.activities.find(
      (activity: Record<string, any>) =>
        activity.kind === 'review' && activityTopics(activity).includes('vectors'),
    );
    if (!vectorReview) throw new Error('No vectors review before prerequisite re-plan');
    await activateReviewIfPlanned(vectorSession.id, vectorReview, now);
    for (const exerciseId of vectorReview.exerciseIds) {
      const { response } = await step('POST', '/attempts', now, {
        exerciseId,
        activityId: vectorReview.id,
        answer: answerFor(exerciseId),
        mode: 'review',
      });
      expect(response.ok).toBe(true);
    }
    await completeReviewIfNeeded(vectorSession.id, vectorReview, now);
    const { response: vectorEndResponse } = await step(
      'POST',
      `/sessions/${vectorSession.id}/end`,
      now,
    );
    expect(vectorEndResponse.ok).toBe(true);

    await addReviewCard(now, 'derivatives', 'math', -4, 1);
    await addReviewCard(now, 'switching-topic', 'math', -3, 2);
    const card = (
      await db
        .select()
        .from(reviewCards)
        .where(
          and(
            eq(reviewCards.userId, userId),
            eq(reviewCards.conceptId, 'derivatives'),
            eq(reviewCards.dimension, 'math'),
          ),
        )
    )[0];
    const priorExercise = content.exercisesById.get('derivatives-power-rule');
    if (!card || !priorExercise) throw new Error('Missing derivatives review fixture');
    const priorAt = new Date(now.getTime() - 2 * 86_400_000);
    const [priorAttempt] = await db
      .insert(attempts)
      .values({
        userId,
        exerciseId: priorExercise.id,
        exerciseVersion: priorExercise.contentVersion,
        conceptId: 'derivatives',
        dimension: 'math',
        mode: 'review',
        answer: 'incorrect',
        correct: 0,
        credit: 0,
        hintsUsed: 0,
        attemptNo: 1,
        gradedBy: 'test',
        feedback: {},
        createdAt: priorAt,
      })
      .returning();
    if (!priorAttempt) throw new Error('Could not create prior Again attempt');
    await db.insert(reviewLogs).values({
      cardId: card.id,
      attemptId: priorAttempt.id,
      rating: String(Rating.Again),
      fsrsLog: {},
      createdAt: priorAt,
    });
    await db
      .update(reviewCards)
      .set({
        reps: card.reps + 1,
        fsrs: { ...(card.fsrs as object), reps: card.reps + 1 },
      })
      .where(eq(reviewCards.id, card.id));
    const { data: session } = await step('POST', '/sessions', now, { budgetMinutes: 600 });
    const activity = session.activities.find(
      (item: Record<string, any>) =>
        item.kind === 'review' &&
        activityTopics(item).includes('derivatives') &&
        activityTopics(item).includes('switching-topic'),
    );
    if (!activity) throw new Error('No derivatives/switching-topic mixed activity');
    expect(activityTopics(activity)).not.toContain('vectors');
    await activateReviewIfPlanned(session.id, activity, now);
    for (const exerciseId of activity.exerciseIds) {
      const conceptId = content.exercisesById.get(exerciseId)?.concept;
      await step('POST', '/attempts', now, {
        exerciseId,
        activityId: activity.id,
        answer: conceptId === 'derivatives' ? 'incorrect' : answerFor(exerciseId),
        mode: 'review',
      });
    }
    await completeReviewIfNeeded(session.id, activity, now);
    const prerequisite = (
      await db
        .select()
        .from(reviewCards)
        .where(
          and(
            eq(reviewCards.userId, userId),
            eq(reviewCards.conceptId, 'vectors'),
            eq(reviewCards.dimension, 'math'),
          ),
        )
    )[0];
    const currentAgain = (
      await db
        .select()
        .from(reviewLogs)
        .innerJoin(reviewCards, eq(reviewLogs.cardId, reviewCards.id))
        .where(and(eq(reviewCards.userId, userId), eq(reviewCards.conceptId, 'derivatives')))
    ).filter(({ review_logs: log }) => log.createdAt.getTime() >= now.getTime());
    expect(currentAgain.some(({ review_logs: log }) => log.rating === String(Rating.Again))).toBe(
      true,
    );
    expect(
      prerequisite && new Date((prerequisite.fsrs as { due: string | Date }).due).getTime(),
    ).toBe(prerequisite?.dueAt.getTime());
    expect(prerequisite?.dueAt.getTime()).toBeGreaterThan(now.getTime());
  });
});

it('covers local midnight, DST, deterministic plans, and skipped-review advancement', async () => {
  const now = new Date('2026-03-07T07:59:00.000Z');
  await seedLearner(now);
  await seedCards(now);
  await step('GET', '/today', now);
  await step('GET', '/today', now);
  const { data: session } = await step('POST', '/sessions', now, { budgetMinutes: 600 });
  const first = session.activities.find((item: Record<string, any>) => item.kind === 'review');
  if (first) {
    const completedAt = new Date('2026-03-07T07:59:30.000Z');
    for (const exerciseId of first.exerciseIds) {
      await step('POST', '/attempts', completedAt, {
        exerciseId,
        activityId: first.id,
        answer: answerFor(exerciseId),
        mode: 'review',
      });
    }
    const activeSameDay = await step(
      'GET',
      '/sessions/active',
      new Date('2026-03-07T07:59:40.000Z'),
    );
    expect(
      activeSameDay.data.activities?.find(
        (activity: Record<string, any>) => activity.status === 'in_progress',
      )?.id,
    ).not.toBe(first.id);
    const afterMidnight = new Date('2026-03-07T08:01:00.000Z');
    await step('GET', '/sessions/active', afterMidnight);
  }
  await step('GET', '/today', new Date('2026-03-08T09:59:00.000Z'));
  await step('GET', '/today', new Date('2026-03-08T10:01:00.000Z'));
});

it('exercises the activity-progress prerequisite replan path', async () => {
  const now = atLocalNoon(startDate);
  await seedLearner(now);
  await db
    .update(mastery)
    .set({ state: 'not_assessed' })
    .where(eq(mastery.conceptId, 'derivatives'));
  const { data: session } = await step('POST', '/sessions', now, {
    budgetMinutes: 600,
    focusConceptId: 'derivatives',
  });
  const derivative = session.activities.find(
    (activity: Record<string, any>) =>
      activity.kind === 'learn' && activity.conceptId === 'derivatives',
  );
  if (!derivative) throw new Error('No derivatives lesson activity to exercise replan');
  await db.update(mastery).set({ state: 'not_assessed' }).where(eq(mastery.conceptId, 'vectors'));
  const { response } = await step(
    'POST',
    `/sessions/${session.id}/activities/${derivative.id}/progress`,
    now,
    {
      lessonViewed: true,
    },
  );
  expect(response.status).toBe(409);
});

if (realDataAuditMode) {
  vitestIt('audits real learner review behavior across the requested timeline', async () => {
    await runRealDataAudit();
  });
}
