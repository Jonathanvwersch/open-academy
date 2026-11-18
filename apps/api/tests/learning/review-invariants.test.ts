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
import { newReviewCard, reviewActivityRating, scheduleReview } from '../../src/learning/fsrs.js';
import { courseConceptIds, courseFoundationIds } from '../../src/learning/prerequisites.js';
import { effectiveFocusSubjectId } from '../../src/learning/scheduler.js';
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
let simulationStepCount = 0;
let simulationAttemptFailures: string[] = [];
let lastHomeFirst: unknown;
let sessionStartMismatch: string | undefined;

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
  entries.add(detail);
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

async function checkI3({ now, today }: AuditContext): Promise<string[]> {
  const planned = todayActivities(today)
    .filter((activity: Record<string, any>) => activity.kind === 'review')
    .flatMap((activity: Record<string, any>) => activity.exerciseIds ?? []);
  const cards = await db.select().from(reviewCards).where(eq(reviewCards.userId, userId));
  const todayLogs = await db
    .select({ cardId: reviewLogs.cardId, createdAt: reviewLogs.createdAt })
    .from(reviewLogs)
    .innerJoin(reviewCards, eq(reviewLogs.cardId, reviewCards.id))
    .where(eq(reviewCards.userId, userId));
  const gradedToday = new Set(
    todayLogs
      .filter((log) => localDateKey(log.createdAt, timezone) === localDateKey(now, timezone))
      .map((log) => log.cardId),
  );
  const focusedConcepts = await focusedConceptIds();
  return cards.flatMap((card) => {
    const concept = content.conceptsById.get(card.conceptId);
    if (!concept || concept.status === 'stub' || card.dueAt > now || gradedToday.has(card.id))
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
    return [`${card.conceptId}/${card.dimension} due ${card.dueAt.toISOString()} not planned`];
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
    if (
      latestLog &&
      card.lastReviewAt &&
      localDateKey(latestLog.createdAt, timezone) === localDateKey(card.lastReviewAt, timezone)
    ) {
      const nextDay = shiftLocalDate(localDateKey(latestLog.createdAt, timezone), 1);
      if (localDateKey(card.dueAt, timezone) < nextDay) {
        failures.push(
          `${card.conceptId}/${card.dimension}: due ${card.dueAt.toISOString()} before next local day ${nextDay}; lastReviewAt=${card.lastReviewAt.toISOString()}`,
        );
      }
    }
  }
  return failures;
}

async function checkI6({ now, today }: AuditContext): Promise<string[]> {
  const openReviews = await db
    .select()
    .from(sessionActivities)
    .innerJoin(studySessions, eq(sessionActivities.sessionId, studySessions.id))
    .where(and(eq(studySessions.userId, userId), eq(sessionActivities.kind, 'review')));
  const planned = todayActivities(today)
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
  return openReviews.flatMap(({ session_activities: activity }) => {
    const answered = allAttempts.some((attempt) => attempt.activityId === activity.id);
    if (!answered) return [];
    return activityTopics(activity).flatMap((conceptId) => {
      if (focusedConcepts && !focusedConcepts.has(conceptId)) return [];
      const dueUngraded = cards.some(
        (card) =>
          card.conceptId === conceptId &&
          card.dueAt <= now &&
          hasEligibleReviewExercise(card.conceptId, card.dimension) &&
          !logs.some(
            ({ review_cards: logCard, review_logs: log }) =>
              logCard.id === card.id &&
              allAttempts.some(
                (attempt) => attempt.activityId === activity.id && attempt.id === log.attemptId,
              ),
          ),
      );
      return dueUngraded && !planned.includes(conceptId)
        ? [`${conceptId}: partial review has answers but is absent from the next plan`]
        : [];
    });
  });
}

async function checkI7({ now, today, active, reviews }: AuditContext): Promise<string[]> {
  const home = todayActivities(today)
    .filter((activity: Record<string, any>) => activity.kind === 'review')
    .flatMap((activity: Record<string, any>) => activityTopics(activity));
  const session = (active?.activities ?? [])
    .filter(
      (activity: Record<string, any>) =>
        activity.kind === 'review' && ['planned', 'in_progress'].includes(activity.status),
    )
    .flatMap((activity: Record<string, any>) => activityTopics(activity));
  const [cards, logs, focusedConcepts] = await Promise.all([
    db.select().from(reviewCards).where(eq(reviewCards.userId, userId)),
    db
      .select({ cardId: reviewLogs.cardId, createdAt: reviewLogs.createdAt })
      .from(reviewLogs)
      .innerJoin(reviewCards, eq(reviewLogs.cardId, reviewCards.id))
      .where(eq(reviewCards.userId, userId)),
    focusedConceptIds(),
  ]);
  const gradedToday = new Set(
    logs
      .filter((log) => localDateKey(log.createdAt, timezone) === localDateKey(now, timezone))
      .map((log) => log.cardId),
  );
  const dueEligibleTopics = new Set(
    cards
      .filter((card) => {
        const concept = content.conceptsById.get(card.conceptId);
        return (
          concept &&
          concept.status !== 'stub' &&
          card.dueAt <= now &&
          !gradedToday.has(card.id) &&
          hasEligibleReviewExercise(card.conceptId, card.dimension) &&
          (!focusedConcepts || focusedConcepts.has(card.conceptId))
        );
      })
      .map((card) => card.conceptId),
  );
  const due = (reviews.topics ?? [])
    .filter((topic: Record<string, any>) => topic.due)
    .filter((topic: Record<string, any>) => dueEligibleTopics.has(topic.conceptId))
    .map((topic: Record<string, any>) => topic.conceptId);
  const failures: string[] = [];
  if (
    active &&
    JSON.stringify([...new Set(home)].sort()) !== JSON.stringify([...new Set(session)].sort())
  )
    failures.push(
      `Home review topics ${[...new Set(home)]} differ from active session ${[...new Set(session)]}`,
    );
  if (JSON.stringify([...new Set(home)].sort()) !== JSON.stringify([...new Set(due)].sort()))
    failures.push(
      `Home review topics ${[...new Set(home)]} differ from Reviews dueNow topics ${[...new Set(due)]}`,
    );
  if (today.dueReviews !== new Set(home).size)
    failures.push(`Home dueReviews=${today.dueReviews}, planned topics=${new Set(home).size}`);
  if (sessionStartMismatch) failures.push(sessionStartMismatch);
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
        if (topics[i] === topics[i - 1])
          failures.push(`${activity.id}: adjacent exercises repeat ${topics[i]}`);
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

async function step(method: string, path: string, now: Date, body?: unknown) {
  const response = await app.request(`/api${path}`, {
    method,
    headers: headersAt(now),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = (await response.json()) as Record<string, any>;
  if (path === '/today') lastHomeFirst = data.plan?.activities?.[0];
  if (path === '/sessions' && response.ok && lastHomeFirst) {
    const first = data.activities?.[0];
    if (
      JSON.stringify(
        first && { kind: first.kind, conceptId: first.conceptId, exerciseIds: first.exerciseIds },
      ) !==
      JSON.stringify({
        kind: (lastHomeFirst as any).kind,
        conceptId: (lastHomeFirst as any).conceptId,
        exerciseIds: (lastHomeFirst as any).exerciseIds,
      })
    ) {
      sessionStartMismatch = `Start learning first=${JSON.stringify(first && { kind: first.kind, conceptId: first.conceptId, exerciseIds: first.exerciseIds })}; Home first=${JSON.stringify({ kind: (lastHomeFirst as any).kind, conceptId: (lastHomeFirst as any).conceptId, exerciseIds: (lastHomeFirst as any).exerciseIds })}`;
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
    prefs: { scheduleMinutes: 600 },
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
  lastHomeFirst = undefined;
  sessionStartMismatch = undefined;
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
      await step('POST', `/sessions/${session.id}/activities/${activity.id}/progress`, nowAtDay, {
        complete: true,
      });
    }
    if (dateIndex === 0) {
      const later = (session.activities ?? []).find(
        (activity: Record<string, any>) => activity.status === 'planned',
      );
      if (later) await step('POST', `/sessions/${session.id}/replan`, nowAtDay, {});
    }
    const endOfDayCards = await db.select().from(reviewCards).where(eq(reviewCards.userId, userId));
    const endOfDayLogs = await db
      .select({ cardId: reviewLogs.cardId, createdAt: reviewLogs.createdAt })
      .from(reviewLogs)
      .innerJoin(reviewCards, eq(reviewLogs.cardId, reviewCards.id))
      .where(eq(reviewCards.userId, userId));
    const gradedAtEndOfDay = new Set(
      endOfDayLogs
        .filter((log) => localDateKey(log.createdAt, timezone) === localDateKey(nowAtDay, timezone))
        .map((log) => log.cardId),
    );
    for (const card of endOfDayCards) {
      const concept = content.conceptsById.get(card.conceptId);
      if (
        !concept ||
        concept.status === 'stub' ||
        card.dueAt > nowAtDay ||
        gradedAtEndOfDay.has(card.id) ||
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
  const failedAttempts =
    name === 'I4' ? `\nRejected attempts: ${simulationAttemptFailures.join('\n')}` : '';
  expect(
    found,
    `${name} violations:\n${found.join('\n')}\nAudited ${simulationStepCount} API steps${failedAttempts}`,
  ).toEqual([]);
}

// I1: session replan can schedule an already-covered topic again.
it.fails('I1 review scheduling invariant', () => assertInvariant('I1'));
// I2: completing a review does not reliably keep its topics out of Home.
it.fails('I2 review scheduling invariant', () => assertInvariant('I2'));
// I3: due cards with eligible exercises can be omitted from the plan.
it.fails('I3 review scheduling invariant', () => assertInvariant('I3'));
// I4: completed activities can leave covered cards ungraded.
it.fails('I4 review scheduling invariant', () => assertInvariant('I4'));
// I5: double-Again can move a graded prerequisite card before tomorrow.
it.fails('I5 review scheduling invariant', () => assertInvariant('I5'));
// I6: partial answers can disappear when another session starts.
it.fails('I6 review scheduling invariant', () => assertInvariant('I6'));
// I7: Home, the active session, and Reviews can show different due topics.
it.fails('I7 review scheduling invariant', () => assertInvariant('I7'));
// I8: mixed reviews can repeat a topic before switching to another.
it.fails('I8 review scheduling invariant', () => assertInvariant('I8'));
it('I9 review scheduling invariant', () => assertInvariant('I9'));

it('S2 preserves a partial review in the next plan', async () => {
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
  const found = [...(violations.get('I6') ?? [])];
  expect(
    found,
    'I6 should report partial ungraded review answers hidden from the next plan',
  ).not.toHaveLength(0);
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
  expect(found, 'I1 should report a topic planned in two activities after replan').not.toHaveLength(
    0,
  );
});

it('S3 Home and the active session expose the same review topics', async () => {
  const now = atLocalNoon(startDate);
  await seedLearner(now);
  await seedCards(now);
  await step('GET', '/today', now);
  await step('POST', '/sessions', now, { budgetMinutes: 600, focusConceptId: 'vectors' });
  const found = [...(violations.get('I7') ?? [])];
  expect(
    found,
    'I7 should report a Home/active-session mismatch when Start learning changes the plan',
  ).not.toHaveLength(0);
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
  expect(
    found,
    'I6 should report a partial answer hidden after starting a new session',
  ).not.toHaveLength(0);
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
    'Reviews should retain a due topic omitted from Home after an ungraded attempt',
  ).not.toHaveLength(0);
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

it('S6 does not grade a card repeatedly outside a review activity', async () => {
  const now = atLocalNoon(startDate);
  await seedLearner(now);
  await seedCards(now);
  for (const exerciseId of ['vectors-fixture-practice-1', 'vectors-fixture-practice-2']) {
    await step('POST', '/attempts', now, {
      exerciseId,
      answer: answerFor(exerciseId),
      mode: 'review',
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
  expect(
    logs.length,
    'S6 expected more than one FSRS update for out-of-activity review attempts',
  ).toBeGreaterThan(1);
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

// S7: double-Again leaves a covered hard prerequisite due after the review.
it.fails('S7 checks double-Again on a prerequisite card', async () => {
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
  expect(prerequisite?.dueAt.getTime()).toBe(now.getTime());
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
    await step('POST', `/sessions/${session.id}/activities/${first.id}/progress`, completedAt, {
      complete: true,
    });
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
