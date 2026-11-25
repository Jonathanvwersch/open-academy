import { sessionActivityIsInContent } from '@academy/aesop/graph/content-filters';
import { labActivityReady, masteryKey } from '@academy/aesop/graph/prerequisites';
import { answerDisplay } from '@academy/aesop/lessons/answer-display';
import { answerOptionsFor } from '@academy/aesop/lessons/answer-options';
import { initialLearnProgress } from '@academy/aesop/lessons/initial-learn-progress';
import { attemptAllowsRetry } from '@academy/aesop/memory/retry';
import { loadHomePlan, withReviewTopics } from '@academy/aesop/planner/home-plan';
import { attemptedExerciseIdsByActivity } from '@academy/aesop/planner/review-topics';
import type { SessionPreferences } from '@academy/aesop/planner/scheduler';
import {
  createSession,
  endSession,
  replacePlannedActivities,
} from '@academy/aesop/planner/session-commands';
import { type OwnedSession, updateSessionProgress } from '@academy/aesop/planner/session-progress';
import { localDateKey, xpGoalFor } from '@academy/aesop/progress/xp';
import { and, desc, eq, gte, inArray, lte } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../../db/client.js';
import { drizzleLearnerStore } from '../../db/learner-store.js';
import { LearnerRepository } from '../../db/repository.js';
import { attempts, lessonRuns, mastery, xpEvents } from '../../db/schema.js';
import { fsrsFuzzEnabled } from '../../learning/fsrs-fuzz.js';
import { linkTimedQuizFollowUp } from '../../learning/timed-review-follow-up.js';
import { type FeatureRequest, type FeatureServices, serviceResult } from '../../service-context.js';
import { replanSessionActivities } from '../course/service.js';
import { quizOffer } from '../quizzes/offer.js';

export async function getToday(deps: FeatureServices, request: FeatureRequest) {
  const index = await deps.content();
  const { repo } = request;
  return serviceResult(
    await loadHomePlan(
      drizzleLearnerStore(deps.db),
      request.userId,
      {
        schedulerState: (now, content) => repo.schedulerState(now, content),
        user: () => repo.user(),
        activeSession: (now) => repo.activeSession(now),
        courseEnrollments: () => repo.courseEnrollments(),
        session: (id) => repo.session(id),
        attemptedExerciseIdsByActivity: (ids) => repo.attemptedExerciseIdsByActivity(ids),
        completeCourses: (ids, now) => repo.completeCourses(ids, now),
        quizOffer: (content, now, courseId) => quizOffer(repo, content, now, courseId),
      },
      index,
      request.now(),
      request.timeZone,
      deps.tutorProvider !== null,
    ),
  );
}

export async function postSessions(deps: FeatureServices, request: FeatureRequest) {
  return deps.db.transaction(async (tx) => {
    await drizzleLearnerStore(tx).lockLearner(request.userId, 'no_key_update');
    const db = tx as unknown as Database;
    return createSessionRequest(
      { ...deps, db },
      { ...request, repo: new LearnerRepository(db, request.userId) },
    );
  });
}

async function createSessionRequest(deps: FeatureServices, request: FeatureRequest) {
  const { db, content } = deps;
  const body = z
    .object({
      kind: z.enum(['weekday', 'saturday', 'sunday', 'custom']).optional(),
      budgetMinutes: z.number().int().positive().max(600).optional(),
      focusConceptId: z.string().optional(),
    })
    .safeParse(request.body);
  if (!body.success) {
    return serviceResult({ error: 'Invalid session request', issues: body.error.issues }, 400);
  }
  const [index, repo] = [await content(), request.repo];
  const now = request.now();
  const outcome = await createSession(
    drizzleLearnerStore(db),
    request.userId,
    index,
    now,
    request.timeZone,
    body.data,
    {
      schedulerState: (date, course) => repo.schedulerState(date, course),
      preferences: async () => ((await repo.user())?.prefs ?? {}) as SessionPreferences,
      quizOffer: (course, date, courseId) => quizOffer(repo, course, date, courseId),
      initialProgress: (activity, lesson) =>
        initialLearnProgress(drizzleLearnerStore(db), request.userId, activity, lesson),
    },
  );
  return outcome.kind === 'created'
    ? serviceResult(outcome.session, 201)
    : serviceResult({ error: outcome.error }, outcome.kind === 'not_found' ? 404 : 409);
}

export async function getSessionsActive(deps: FeatureServices, request: FeatureRequest) {
  const { content } = deps;
  const now = request.now();
  const session = await request.repo.activeSession(now);
  const index = await content();
  const fullSession = session ? await request.repo.session(session.id, session) : null;
  const activities =
    fullSession?.activities.filter((activity) => sessionActivityIsInContent(index, activity)) ?? [];
  const inProgressReviewIds = activities
    .filter((activity) => activity.kind === 'review' && activity.status === 'in_progress')
    .map((activity) => activity.id);
  const attemptedByActivity =
    await request.repo.attemptedExerciseIdsByActivity(inProgressReviewIds);
  return serviceResult(
    fullSession && activities.length
      ? {
          ...fullSession,
          activities: activities.map((activity) =>
            withReviewTopics(
              {
                ...activity,
                conceptTitle: activity.conceptId
                  ? index.conceptsById.get(activity.conceptId)?.title
                  : undefined,
              },
              index,
              attemptedByActivity.get(activity.id),
            ),
          ),
          serverNow: now,
        }
      : null,
  );
}

export async function getSessionsById(deps: FeatureServices, request: FeatureRequest) {
  const { db, content, tutorProvider } = deps;
  const repo = request.repo;
  const session = await repo.session(request.params.id);
  const index = await content();
  const [masteryRows, runRows] = await Promise.all([
    db
      .select({
        conceptId: mastery.conceptId,
        dimension: mastery.dimension,
        state: mastery.state,
        inferred: mastery.inferred,
      })
      .from(mastery)
      .where(eq(mastery.userId, request.userId)),
    db
      .select({ conceptId: lessonRuns.conceptId, status: lessonRuns.status })
      .from(lessonRuns)
      .where(eq(lessonRuns.userId, request.userId)),
  ]);
  const masteryByKey = new Map(
    masteryRows.map((record) => [
      masteryKey(record.conceptId, record.dimension),
      { state: record.state, inferred: record.inferred },
    ]),
  );
  const activities =
    session?.activities.filter(
      (activity) =>
        sessionActivityIsInContent(index, activity) &&
        ((activity.status !== 'planned' && activity.status !== 'in_progress') ||
          labActivityReady(activity, masteryByKey, runRows, index)),
    ) ?? [];
  const activityIds = activities.map((activity) => activity.id);
  const activityAttempts = activityIds.length
    ? await db
        .select()
        .from(attempts)
        .where(and(eq(attempts.userId, request.userId), inArray(attempts.activityId, activityIds)))
        .orderBy(desc(attempts.createdAt), desc(attempts.attemptNo))
    : [];
  const attemptedByActivity = attemptedExerciseIdsByActivity(activityAttempts);
  const xp = session
    ? await (async () => {
        const now = request.now();
        const todayLocal = localDateKey(now, request.timeZone);
        const sessionStartedAt = session.startedAt ?? now;
        const sessionEndedAt = session.endedAt ?? now;
        const [user, sessionEvents, todayEvents] = await Promise.all([
          repo.user(),
          db
            .select({ amount: xpEvents.amount })
            .from(xpEvents)
            .where(
              and(
                eq(xpEvents.userId, request.userId),
                gte(xpEvents.earnedAt, sessionStartedAt),
                lte(xpEvents.earnedAt, sessionEndedAt),
              ),
            ),
          drizzleLearnerStore(db).listXpEvents(request.userId, { localDate: todayLocal }),
        ]);
        return {
          session: sessionEvents.reduce((total, event) => total + event.amount, 0),
          today: todayEvents.reduce((total, event) => total + event.amount, 0),
          goal: xpGoalFor(todayLocal, (user?.prefs ?? {}) as SessionPreferences),
        };
      })()
    : undefined;
  return session
    ? serviceResult({
        ...session,
        quizFollowUp: (session.plan as { quizFollowUp?: string }).quizFollowUp,
        xp,
        activities: activities.map((activity) => ({
          ...withReviewTopics(
            {
              ...activity,
              conceptTitle: activity.conceptId
                ? index.conceptsById.get(activity.conceptId)?.title
                : undefined,
            },
            index,
            attemptedByActivity.get(activity.id),
          ),
          lessonAvailable: activity.conceptId
            ? index.lessonsByConcept.has(activity.conceptId)
            : false,
          lastAttempt: activityAttempts
            .filter(
              (attempt) =>
                attempt.activityId === activity.id &&
                activity.exerciseIds.includes(attempt.exerciseId),
            )
            .map((attempt) => {
              const feedback = attempt.feedback as Record<string, unknown>;
              const answer = attempt.answer;
              const followUp = feedback.followUp === true;
              const retryAllowed = attemptAllowsRetry(attempt);
              const answerWithheld = retryAllowed;
              const exercise = index.exercisesById.get(attempt.exerciseId);
              const answerOptions = exercise
                ? answerOptionsFor(exercise, answer, !answerWithheld)
                : undefined;
              return {
                exerciseId: attempt.exerciseId,
                status: feedback.status ?? 'graded',
                correct: attempt.correct,
                attemptNo: attempt.attemptNo,
                retryAllowed,
                ...(followUp ? { followUp: true } : {}),
                ...(answerOptions ? { answerOptions } : {}),
                feedback: feedback.message ?? '',
                rubric: feedback.rubric,
                ...(!answerWithheld
                  ? { exemplar: feedback.exemplar, solution: feedback.solution }
                  : {}),
                yourAnswer:
                  (typeof feedback.yourAnswer === 'string' && feedback.yourAnswer) ||
                  (typeof answer === 'object' &&
                  answer !== null &&
                  !Array.isArray(answer) &&
                  'text' in answer &&
                  typeof answer.text === 'string'
                    ? answer.text
                    : exercise
                      ? answerDisplay(exercise, answer)
                      : undefined),
              };
            })[0],
        })),
        serverNow: request.now(),
        tutorEnabled: tutorProvider !== null,
      })
    : serviceResult({ error: 'Session not found' }, 404);
}

export async function postSessionsByIdActivitiesByAidProgress(
  deps: FeatureServices,
  request: FeatureRequest,
) {
  if (!z.string().uuid().safeParse(request.params.id).success)
    return serviceResult({ error: 'Session not found' }, 404);
  return deps.db.transaction(async (tx) => {
    const store = drizzleLearnerStore(tx);
    const session = await store.lockSession(request.userId, request.params.id);
    const locked = session && { ...session, userId: request.userId };
    const db = tx as unknown as Database;
    return updateActivityProgress(
      { ...deps, db },
      {
        ...request,
        repo: new LearnerRepository(db, request.userId, undefined, {
          load: deps.content,
          now: request.now,
        }),
      },
      locked,
    );
  });
}

async function updateActivityProgress(
  deps: FeatureServices,
  request: FeatureRequest,
  locked: OwnedSession | undefined,
) {
  const { db, content } = deps;
  const body = z.record(z.string(), z.unknown()).safeParse(request.body);
  if (!body.success) {
    return serviceResult({ error: 'Invalid progress' }, 400);
  }
  const { repo, params, userId, timeZone, now } = request;
  let loaded = locked;
  const result = await updateSessionProgress(
    drizzleLearnerStore(db),
    userId,
    params.id,
    params.aid,
    body.data,
    now,
    timeZone,
    fsrsFuzzEnabled(),
    {
      content,
      session: (id) => {
        const session = id === params.id ? loaded : undefined;
        loaded = undefined;
        return repo.session(id, session);
      },
      schedulerState: (date, index) => repo.schedulerState(date, index),
      attemptedExerciseIdsByActivity: (ids) => repo.attemptedExerciseIdsByActivity(ids),
      linkTimedQuizFollowUp: (id, activityId, concepts) =>
        linkTimedQuizFollowUp(db, id, activityId, concepts),
      replanBlocked: (index, date, session, state, blocked, activate) =>
        replanSessionActivities({
          db,
          repo,
          userId,
          content: index,
          now: date,
          session,
          skipActivityIds: blocked,
          activatePlannedActivityId: activate,
          schedulerState: state,
        }),
    },
  );
  return serviceResult(
    result.body,
    result.kind === 'not_found' ? 404 : result.kind === 'conflict' ? 409 : 200,
  );
}

export async function postSessionsByIdReplan(deps: FeatureServices, request: FeatureRequest) {
  if (!z.string().uuid().safeParse(request.params.id).success)
    return serviceResult({ error: 'Session not found' }, 404);
  return deps.db.transaction(async (tx) => {
    const store = drizzleLearnerStore(tx);
    const session = await store.lockSession(request.userId, request.params.id);
    const locked = session && { ...session, userId: request.userId };
    const db = tx as unknown as Database;
    return replanSession(
      { ...deps, db },
      {
        ...request,
        repo: new LearnerRepository(db, request.userId, undefined, {
          load: deps.content,
          now: request.now,
        }),
      },
      locked,
    );
  });
}

async function replanSession(
  deps: FeatureServices,
  request: FeatureRequest,
  locked: OwnedSession | undefined,
) {
  const { db, content } = deps;
  const session = await request.repo.session(request.params.id, locked);
  if (!session) {
    return serviceResult({ error: 'Session not found' }, 404);
  }
  const now = request.now();
  const index = await content();
  const body = z
    .object({ remainingBudgetMinutes: z.number().int().min(0).max(600).optional() })
    .safeParse(request.body);
  if (!body.success) return serviceResult({ error: 'Invalid replan request' }, 400);
  return serviceResult(
    await replacePlannedActivities(
      drizzleLearnerStore(db),
      request.userId,
      session,
      index,
      now,
      body.data.remainingBudgetMinutes,
      {
        schedulerState: (date, course) => request.repo.schedulerState(date, course),
        attemptedExerciseIdsByActivity: (ids) => request.repo.attemptedExerciseIdsByActivity(ids),
        initialProgress: (activity, lesson) =>
          initialLearnProgress(drizzleLearnerStore(db), request.userId, activity, lesson),
      },
    ),
  );
}

export async function postSessionsByIdEnd(deps: FeatureServices, request: FeatureRequest) {
  const { db } = deps;
  const previous = await request.repo.session(request.params.id);
  if (!previous) return serviceResult({ error: 'Session not found' }, 404);
  if (previous.status === 'completed') return serviceResult(previous);
  const session = await endSession(
    drizzleLearnerStore(db),
    request.userId,
    previous,
    request.now(),
  );
  return session ? serviceResult(session) : serviceResult({ error: 'Session not found' }, 404);
}
