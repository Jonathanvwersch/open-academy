import { and, eq, inArray } from 'drizzle-orm';
import { Rating } from 'ts-fsrs';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { env } from '../../src/config.js';
import { subjectForCourse } from '../../src/content/index.js';
import { loadContent } from '../../src/content/load.js';
import { instantiateExercise, isTemplate } from '../../src/content/templates.js';
import type { ContentIndex } from '../../src/content/types.js';
import { createDb } from '../../src/db/client.js';
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
import {
  isDueToday,
  newReviewCard,
  reviewActivityRating,
  scheduleReview,
} from '../../src/learning/fsrs.js';
import { courseConceptIds, courseFoundationIds } from '../../src/learning/prerequisites.js';
import * as schedulerModule from '../../src/learning/scheduler.js';
import {
  effectiveFocusSubjectId,
  explainReviewSelection,
  explainReviewSelectionForReplan,
} from '../../src/learning/scheduler.js';
import { localDateKey } from '../../src/learning/xp.js';

const db = createDb(env.TEST_DATABASE_URL);
const userId = '00000000-0000-4000-8000-000000000098';
const timezone = 'America/Los_Angeles';
const startDate = '2026-02-22';
let app: ReturnType<typeof createApp>;
let content: ContentIndex;
const seededReps = new Map<string, number>();
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
type DueAtEvent = { at: Date; dueAt: Date; cause: string };
const dueAtHistory = new Map<string, DueAtEvent[]>();
let currentApiCall: ApiCall | undefined;
let simulationStepCount = 0;
let simulationAttemptFailures: string[] = [];

const checkerNames = ['I1', 'I2', 'I3', 'I4', 'I5', 'I6', 'I7', 'I8', 'I9'];
vi.setConfig({ hookTimeout: 300_000, testTimeout: 60_000 });

function headersAt(now: Date) {
  return {
    'content-type': 'application/json',
    'X-Now': now.toISOString(),
    'X-Time-Zone': timezone,
  };
}

async function readApi(path: string, now: Date): Promise<any> {
  const response = await app.request(`/api${path}`, { headers: headersAt(now) });
  return response.json() as Promise<Record<string, any>>;
}

type AuditContext = {
  now: Date;
  today: Record<string, any>;
  active: Record<string, any> | null;
  reviews: Record<string, any>;
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

async function checkI3({ now, today, active }: AuditContext): Promise<string[]> {
  const planned = todayActivities(today)
    .filter((activity: Record<string, any>) => activity.kind === 'review')
    .flatMap((activity: Record<string, any>) => activity.exerciseIds ?? []);
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
  const gradedToday = new Set(
    todayLogs
      .filter((log) => localDateKey(log.createdAt, timezone) === localDateKey(now, timezone))
      .map((log) => log.conceptId),
  );
  const focusedConcepts = await focusedConceptIds();
  const failures = cards.flatMap((card) => {
    const concept = content.conceptsById.get(card.conceptId);
    if (
      !concept ||
      concept.status === 'stub' ||
      !isDueToday(card.dueAt, now, timezone) ||
      gradedToday.has(card.conceptId)
    )
      return [];
    if (focusedConcepts && !focusedConcepts.has(card.conceptId)) return [];
    const eligible = hasEligibleReviewExercise(card.conceptId, card.dimension);
    if (
      !eligible ||
      planned.some((id: string) => {
        const exercise = content.exercisesById.get(id);
        return exercise?.concept === card.conceptId && exercise.dimension === card.dimension;
      })
    )
      return [];
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
        const final = attemptsForExercise[0]!;
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
    const expectedReps = (seededReps.get(card.id) ?? card.reps) + cardLogs.length;
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

async function checkI6({ now, today, active }: AuditContext): Promise<string[]> {
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
      const dueUngraded = cards.some(
        (card) =>
          card.conceptId === conceptId &&
          isDueToday(card.dueAt, now, timezone) &&
          !logs.some(
            ({ review_cards: logCard, review_logs: log }) =>
              logCard.conceptId === conceptId &&
              localDateKey(log.createdAt, timezone) === localDateKey(now, timezone),
          ) &&
          hasEligibleReviewExercise(card.conceptId, card.dimension) &&
          !logs.some(
            ({ review_cards: logCard, review_logs: log }) =>
              logCard.id === card.id &&
              allAttempts.some(
                (attempt) => attempt.activityId === activity.id && attempt.id === log.attemptId,
              ),
          ),
      );
      if (!dueUngraded || planned.includes(conceptId)) return [];
      const dueCards = cards.filter(
        (card) => card.conceptId === conceptId && isDueToday(card.dueAt, now, timezone),
      );
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

async function checkI7({ now, today, active, reviews }: AuditContext): Promise<string[]> {
  const learnResponse = await app.request('/api/learn', { headers: headersAt(now) });
  const learn = (await learnResponse.json()) as {
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
    if (dueTodayTopics.has(conceptId) || activeReviewTopics.has(conceptId)) continue;
    failures.push(
      `I7(a) Home topic ${conceptId} is neither due today nor in an active review; card history=${JSON.stringify(cardHistory(conceptId))}`,
    );
  }
  if (!budgetNoteShown) {
    for (const conceptId of reviewsDueTopics) {
      if (homeTopics.has(conceptId)) continue;
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
  const [today, active, reviews] = await Promise.all([
    readApi('/today', now),
    readApi('/sessions/active', now),
    readApi('/reviews', now),
  ]);
  const context = { now, today, active, reviews };
  for (let index = 0; index < checkers.length; index += 1) {
    const name = checkerNames[index]!;
    for (const detail of await checkers[index]!(context)) invariantViolation(name, detail);
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
    response = await app.request(`/api${path}`, {
      method,
      headers: headersAt(now),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } finally {
    currentApiCall = undefined;
  }
  const data = (await response.json()) as Record<string, any>;
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
    for (const row of createdRows) activityCreationCalls.set(row.id, requestCall);
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
  await auditAll(now, `${method} ${path}`);
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
  violations.clear();
  auditTrail.length = 0;
  attemptFailures.length = 0;
  schedulerCalls.length = 0;
  activityPlanningEvidence.clear();
  activityCreationCalls.clear();
  dueAtHistory.clear();
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

function answerFor(exerciseId: string) {
  const indexed = content.exercisesById.get(exerciseId);
  if (!indexed) throw new Error(`Unknown exercise ${exerciseId}`);
  const exercise = isTemplate(indexed) ? instantiateExercise(indexed, 0).exercise : indexed;
  if (exercise.type === 'mc') {
    const correct = exercise.options.filter((option) => option.correct).map((option) => option.id);
    return exercise.multi ? correct : correct[0];
  }
  if ('answer' in exercise) return exercise.answer;
  if ('accept' in exercise) return exercise.accept[0];
  return { text: 'A correct explanation.' };
}

let simulationDone = false;

beforeAll(async () => {
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
        const answer = wrong
          ? exercise.type === 'mc'
            ? 'wrong-option'
            : 'not the answer'
          : answerFor(exerciseId);
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
        !hasEligibleReviewExercise(card.conceptId, card.dimension)
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
  await db.delete(users).where(eq(users.id, userId));
  await db.$client.end();
});

async function assertInvariant(name: string) {
  expect(simulationDone).toBe(true);
  if (name === 'I1') {
    const now = atLocalNoon(startDate);
    await seedLearner(now);
    await seedCards(now);
    const { data: session } = await step('POST', '/sessions', now, { budgetMinutes: 600 });
    await step('POST', `/sessions/${session.id}/replan`, now, {});
    const repeatedTopic = [...(violations.get('I1') ?? [])];
    expect(repeatedTopic, 'I1: replan must preserve mixed review concept coverage').toEqual([]);
    return;
  }
  const found = [...(simulationFindings.get(name) ?? [])];
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

// I1: session replan can schedule an already-covered topic again.
it('I1 review scheduling invariant', () => assertInvariant('I1'));
// I2: completing a review does not reliably keep its topics out of Home.
it('I2 review scheduling invariant', () => assertInvariant('I2'));
// I3: due cards with eligible exercises can be omitted from the plan.
it('I3 review scheduling invariant', () => assertInvariant('I3'));
// I4: completed activities can leave covered cards ungraded.
it('I4 review scheduling invariant', () => assertInvariant('I4'));
// I5: double-Again can move a graded prerequisite card before tomorrow.
it('I5 review scheduling invariant', () => assertInvariant('I5'));
// I6: partial answers can disappear when another session starts.
it('I6 review scheduling invariant', () => assertInvariant('I6'));
// I7: Home topics must be due or active, and Reviews due topics need Home or the budget note.
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

it('S7 checks layering credit and double-Again effects on cards in the same activity', async () => {
  const now = atLocalNoon(startDate);
  await seedLearner(now);
  await addReviewCard(now, 'vectors', 'math', -5, 0);
  await addReviewCard(now, 'derivatives', 'math', -4, 1);
  const { data: session } = await step('POST', '/sessions', now, { budgetMinutes: 600 });
  const activity = session.activities.find(
    (item: Record<string, any>) =>
      item.kind === 'review' &&
      activityTopics(item).includes('vectors') &&
      activityTopics(item).includes('derivatives'),
  );
  if (!activity) throw new Error('No vectors/derivatives mixed activity');
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
        inArray(reviewCards.conceptId, ['vectors', 'derivatives']),
      ),
    );
  const mismatch = cardRows.filter(
    (card) =>
      new Date((card.fsrs as { due: string | Date }).due).getTime() !== card.dueAt.getTime(),
  );
  expect(mismatch.map((card) => `${card.conceptId}/${card.dimension}`)).toEqual([]);
});

it('S7 does not bring a prerequisite covered by the same review due now', async () => {
  const now = atLocalNoon(startDate);
  await seedLearner(now);
  await addReviewCard(now, 'vectors', 'math', -5, 0);
  await addReviewCard(now, 'derivatives', 'math', -4, 1);
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
      activityTopics(item).includes('vectors') &&
      activityTopics(item).includes('derivatives'),
  );
  if (!activity) throw new Error('No vectors/derivatives mixed activity');
  for (const exerciseId of activity.exerciseIds) {
    const conceptId = content.exercisesById.get(exerciseId)?.concept;
    await step('POST', '/attempts', now, {
      exerciseId,
      activityId: activity.id,
      answer: conceptId === 'derivatives' ? 'incorrect' : answerFor(exerciseId),
      mode: 'review',
    });
  }
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
