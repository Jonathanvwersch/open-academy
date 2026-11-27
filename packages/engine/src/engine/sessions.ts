import { z } from 'zod';
import type { SessionActivity, SessionPayload } from '../api/sessions.js';
import { replanSessionActivities as replanCourseSession } from '../course/progress-commands.js';
import { sessionActivityIsInContent } from '../graph/content-filters.js';
import { labActivityReady, masteryKey } from '../graph/prerequisites.js';
import { answerDisplay } from '../lessons/answer-display.js';
import { answerOptionsFor } from '../lessons/answer-options.js';
import { initialLearnProgress } from '../lessons/initial-learn-progress.js';
import { readLessonReviewStatus } from '../lessons/run-state.js';
import { attemptAllowsRetry } from '../memory/retry.js';
import { withReviewTopics } from '../planner/home-plan.js';
import { attemptedExerciseIdsByActivity } from '../planner/review-topics.js';
import type { SessionPreferences } from '../planner/scheduler.js';
import { createSession, replacePlannedActivities } from '../planner/session-commands.js';
import { updateSessionProgress } from '../planner/session-progress.js';
import { localDateKey, xpGoalFor } from '../progress/xp.js';
import type { EngineLearnerRepository } from './repository.js';
import { type EngineRequest, type EngineResult, respond } from './types.js';

export function createSessionOperation(
  request: EngineRequest,
  input: unknown,
): Promise<EngineResult> {
  return request.store.transaction(async (tx) => {
    await tx.lockLearner(request.userId, 'no_key_update');
    return createSessionRequest(
      { ...request, store: tx, repo: request.freshRepo(tx, false) },
      input,
    );
  });
}

async function createSessionRequest(request: EngineRequest, input: unknown) {
  const body = z
    .object({
      kind: z.enum(['weekday', 'saturday', 'sunday', 'custom']).optional(),
      budgetMinutes: z.number().int().positive().max(600).optional(),
      focusConceptId: z.string().optional(),
    })
    .safeParse(input);
  if (!body.success) {
    return respond({ error: 'Invalid session request', issues: body.error.issues }, 400);
  }
  const { store, userId, repo } = request;
  const outcome = await createSession(
    store,
    userId,
    request.content,
    request.now(),
    request.timeZone,
    body.data,
    {
      schedulerState: (date, course) => repo.schedulerState(date, course),
      preferences: async () => ((await repo.user())?.prefs ?? {}) as SessionPreferences,
      initialProgress: (activity, lesson) => initialLearnProgress(store, userId, activity, lesson),
    },
  );
  return outcome.kind === 'created'
    ? respond(outcome.session, 201)
    : respond({ error: outcome.error }, outcome.kind === 'not_found' ? 404 : 409);
}

const uncontinuedLesson = (item: SessionActivity) =>
  item.kind === 'learn' &&
  item.status === 'completed' &&
  Boolean(item.conceptId) &&
  !item.progress?.quizContinued;

const completedFinal = (item: SessionActivity) =>
  item.kind === 'learn' &&
  (item.status === 'completed' || item.status === 'in_progress') &&
  item.progress?.lessonRunnerContinued &&
  !item.progress.finalQuestionContinued &&
  (item.progress.completedExerciseIds ?? []).some((id) => item.exerciseIds.includes(id));

function activeActivity(activities: SessionActivity[]) {
  return (
    activities.find((item) => item.status === 'in_progress') ??
    activities.find((item) => item.status === 'planned')
  );
}

export function currentActivity(
  activities: SessionActivity[],
  runStatuses: ReadonlyMap<string, { status: string } | undefined>,
  content: Pick<EngineRequest['content'], 'lessonsByConcept'>,
): { activities: SessionActivity[]; current: SessionPayload['current'] } {
  const withLessonState: SessionActivity[] = activities.map((activity) => {
    if (activity.kind !== 'learn') return activity;
    const lesson = activity.conceptId
      ? content.lessonsByConcept.get(activity.conceptId)
      : undefined;
    const runStatus = activity.conceptId ? runStatuses.get(activity.conceptId)?.status : undefined;
    return {
      ...activity,
      lessonRunner: Boolean(
        activity.conceptId &&
          lesson?.knowledge_points?.length &&
          (!activity.progress?.lessonRunnerContinued ||
            (activity.progress.finalQuestionContinued && !activity.progress.quizContinued)),
      ),
      lessonQuiz: Boolean(
        activity.conceptId && !activity.progress?.quizContinued && runStatus === 'quiz',
      ),
    };
  });
  const lesson = withLessonState.find((item) => {
    if (!uncontinuedLesson(item) || !item.conceptId) return false;
    const runStatus = runStatuses.get(item.conceptId)?.status;
    return (
      runStatus === 'completed' ||
      (runStatus === 'quiz' &&
        (item.progress?.finalQuestionContinued || item.exerciseIds.length === 0))
    );
  });
  const final = withLessonState.find(completedFinal);
  const active = activeActivity(withLessonState);
  const selected = lesson ?? final ?? active;
  const sessionActivities = withLessonState.map((activity) => {
    const completedIds = new Set(activity.progress?.completedExerciseIds ?? []);
    const exerciseId =
      activity.id === final?.id
        ? activity.exerciseIds.find((id) => completedIds.has(id))
        : activity.exerciseIds.find((id) => !completedIds.has(id));
    return { ...activity, ...(exerciseId ? { exerciseId } : {}) };
  });
  return {
    activities: sessionActivities,
    current: {
      ...(selected ? { activityId: selected.id } : {}),
      ...(final ? { completedFinalId: final.id } : {}),
      openableIds:
        active && !lesson && !final
          ? withLessonState
              .filter((item) => ['completed', 'in_progress', 'planned'].includes(item.status))
              .map((item) => item.id)
          : [],
    },
  };
}

export async function sessionById(request: EngineRequest, sessionId: string) {
  const { store, userId, repo } = request;
  const index = request.content;
  const session = await repo.session(sessionId);
  const [masteryRows, runRows] = await Promise.all([
    store.listMastery(userId),
    store.listLessonRuns(userId),
  ]);
  const masteryByKey = new Map(
    masteryRows.map((record) => [
      masteryKey(record.conceptId, record.dimension),
      { state: record.state, inferred: record.inferred },
    ]),
  );
  const runs = runRows.map(({ conceptId, status }) => ({ conceptId, status }));
  const runsByConcept = new Map(runRows.map((run) => [run.conceptId, run] as const));
  const activities =
    session?.activities.filter(
      (activity) =>
        sessionActivityIsInContent(index, activity) &&
        ((activity.status !== 'planned' && activity.status !== 'in_progress') ||
          labActivityReady(activity, masteryByKey, runs, index)),
    ) ?? [];
  const runStatuses = new Map<string, { status: string }>();
  await Promise.all(
    activities.map(async (activity) => {
      if (activity.kind !== 'learn' || !activity.conceptId) return;
      const run = runsByConcept.get(activity.conceptId);
      const lesson = index.lessonsByConcept.get(activity.conceptId);
      if (!run || !lesson?.knowledge_points?.length) return;
      const status =
        run.status === 'needs_retry'
          ? run.status
          : await readLessonReviewStatus(store, userId, run, lesson, index);
      if (status) runStatuses.set(activity.conceptId, { status });
    }),
  );
  const activityIds = activities.map((activity) => activity.id);
  const activityAttempts = activityIds.length
    ? (await store.listAttempts(userId, { activityIds })).sort(
        (left, right) =>
          right.createdAt.getTime() - left.createdAt.getTime() || right.attemptNo - left.attemptNo,
      )
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
          store.listXpEvents(userId, { since: sessionStartedAt, through: sessionEndedAt }),
          store.listXpEvents(userId, { localDate: todayLocal }),
        ]);
        return {
          session: sessionEvents.reduce((total, event) => total + event.amount, 0),
          today: todayEvents.reduce((total, event) => total + event.amount, 0),
          goal: xpGoalFor(todayLocal, (user?.prefs ?? {}) as SessionPreferences),
        };
      })()
    : undefined;
  if (!session) return respond({ error: 'Session not found' }, 404);
  const serializedActivities: SessionActivity[] = activities.map((activity) => ({
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
    progress: activity.progress as SessionActivity['progress'],
    lessonAvailable: activity.conceptId ? index.lessonsByConcept.has(activity.conceptId) : false,
    startedAt: activity.startedAt === null ? null : activity.startedAt?.toISOString(),
    lastAttempt: activityAttempts
      .filter(
        (attempt) =>
          attempt.activityId === activity.id && activity.exerciseIds.includes(attempt.exerciseId),
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
          status: (feedback.status ?? 'graded') as string,
          correct: attempt.correct,
          outcome: attempt.correct > 0 ? ('correct' as const) : ('incorrect' as const),
          attemptNo: attempt.attemptNo,
          retryAllowed,
          ...(followUp ? { followUp: true } : {}),
          ...(answerOptions ? { answerOptions } : {}),
          feedback: (feedback.message ?? '') as string,
          rubric: feedback.rubric as NonNullable<SessionActivity['lastAttempt']>['rubric'],
          ...(!answerWithheld
            ? {
                exemplar: feedback.exemplar as NonNullable<
                  SessionActivity['lastAttempt']
                >['exemplar'],
                solution: feedback.solution as NonNullable<
                  SessionActivity['lastAttempt']
                >['solution'],
              }
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
  }));
  const sessionActivities = currentActivity(serializedActivities, runStatuses, request.content);
  return respond({
    ...session,
    quizFollowUp: (session.plan as { quizFollowUp?: string }).quizFollowUp,
    xp,
    activities: sessionActivities.activities,
    current: sessionActivities.current,
    serverNow: request.now(),
    tutorEnabled: request.tutorEnabled,
  });
}

export async function activeSession(request: EngineRequest) {
  const now = request.now();
  const session = await request.repo.activeSession(now);
  const fullSession = session ? await request.repo.session(session.id, session) : null;
  const activities =
    fullSession?.activities.filter((activity) =>
      sessionActivityIsInContent(request.content, activity),
    ) ?? [];
  const reviewIds = activities
    .filter((activity) => activity.kind === 'review' && activity.status === 'in_progress')
    .map((activity) => activity.id);
  const attemptedByActivity = await request.repo.attemptedExerciseIdsByActivity(reviewIds);
  return respond(
    fullSession && activities.length
      ? {
          ...fullSession,
          activities: activities.map((activity) =>
            withReviewTopics(
              {
                ...activity,
                conceptTitle: activity.conceptId
                  ? request.content.conceptsById.get(activity.conceptId)?.title
                  : undefined,
              },
              request.content,
              attemptedByActivity.get(activity.id),
            ),
          ),
          serverNow: now,
        }
      : null,
  );
}

type LockedSession = Parameters<typeof updateSessionProgress>[8] extends {
  session: (id: string) => Promise<infer S>;
}
  ? S
  : never;

export function activityProgressOperation(
  request: EngineRequest,
  sessionId: string,
  activityId: string,
  body: unknown,
): Promise<EngineResult> {
  return request.store.transaction(async (tx) => {
    const session = await tx.lockSession(request.userId, sessionId);
    const locked = session && { ...session, userId: request.userId };
    return activityProgress(
      { ...request, store: tx, repo: request.freshRepo(tx, true) },
      sessionId,
      activityId,
      body,
      locked,
    );
  });
}

export function continueActivityOperation(
  request: EngineRequest,
  sessionId: string,
  activityId: string,
): Promise<EngineResult> {
  return request.store.transaction(async (tx) => {
    const session = await tx.lockSession(request.userId, sessionId);
    const locked = session && { ...session, userId: request.userId };
    const repo = request.freshRepo(tx, true);
    const current = await repo.session(sessionId, locked);
    const activity = current?.activities.find((item) => item.id === activityId);
    if (!activity) return respond({ error: 'Activity not found' }, 404);
    if (activity.kind !== 'learn' || !activity.conceptId)
      return respond({ error: 'Nothing to continue' }, 409);

    const lesson = request.content.lessonsByConcept.get(activity.conceptId);
    const progress = (activity.progress ?? {}) as Record<string, unknown>;
    const completedExerciseIds = Array.isArray(progress.completedExerciseIds)
      ? progress.completedExerciseIds.filter((id): id is string => typeof id === 'string')
      : [];
    const finalPending = Boolean(lesson?.final && !completedExerciseIds.includes(lesson.final));
    const run = await tx.getLessonRun(request.userId, { conceptId: activity.conceptId });
    let body: Record<string, unknown>;

    if (
      !progress.lessonRunnerContinued ||
      (progress.finalQuestionContinued && !progress.quizContinued)
    ) {
      if (run?.status === 'completed' || (run?.status === 'quiz' && !finalPending)) {
        body = {
          lessonRunnerContinued: true,
          finalQuestionContinued: true,
          quizContinued: true,
          complete: true,
        };
      } else if (run?.status === 'quiz' && finalPending) {
        body = { lessonRunnerContinued: true };
      } else {
        return respond({ error: 'Nothing to continue' }, 409);
      }
    } else if (!progress.finalQuestionContinued && !finalPending) {
      body = { finalQuestionContinued: true };
    } else {
      return respond({ error: 'Nothing to continue' }, 409);
    }

    return activityProgress({ ...request, store: tx, repo }, sessionId, activityId, body, locked);
  });
}

async function activityProgress(
  request: EngineRequest,
  sessionId: string,
  activityId: string,
  body: unknown,
  locked: Parameters<EngineLearnerRepository['session']>[1],
) {
  const { store, userId, repo } = request;
  const parsedBody = z.record(z.string(), z.unknown()).safeParse(body);
  if (!parsedBody.success) return respond({ error: 'Invalid progress' }, 400);
  let loaded = locked;
  const result = await updateSessionProgress(
    store,
    userId,
    sessionId,
    activityId,
    parsedBody.data,
    request.now,
    request.timeZone,
    request.fsrsFuzz,
    {
      content: async () => request.content,
      session: (id) => {
        const session = id === sessionId ? loaded : undefined;
        loaded = undefined;
        return repo.session(id, session) as Promise<LockedSession>;
      },
      schedulerState: (date, index) => repo.schedulerState(date, index),
      attemptedExerciseIdsByActivity: (ids) => repo.attemptedExerciseIdsByActivity(ids),
      replanBlocked: async (index, date, session, state, blocked, activate) =>
        replanCourseSession(store, {
          userId,
          content: index,
          now: date,
          session,
          skipActivityIds: blocked,
          activatePlannedActivityId: activate,
          schedulerState: state ?? (await repo.schedulerState(date, index)),
        }),
    },
  );
  return respond(
    result.body,
    result.kind === 'not_found' ? 404 : result.kind === 'conflict' ? 409 : 200,
  );
}

export function replanSessionOperation(
  request: EngineRequest,
  sessionId: string,
  input: unknown = {},
): Promise<EngineResult> {
  return request.store.transaction(async (tx) => {
    const session = await tx.lockSession(request.userId, sessionId);
    const locked = session && { ...session, userId: request.userId };
    return replanSession(
      { ...request, store: tx, repo: request.freshRepo(tx, true) },
      sessionId,
      input,
      locked,
    );
  });
}

async function replanSession(
  request: EngineRequest,
  sessionId: string,
  input: unknown,
  locked: Parameters<EngineLearnerRepository['session']>[1],
) {
  const { store, userId, repo } = request;
  const session = await repo.session(sessionId, locked);
  if (!session) return respond({ error: 'Session not found' }, 404);
  const now = request.now();
  const body = z
    .object({ remainingBudgetMinutes: z.number().int().min(0).max(600).optional() })
    .safeParse(input);
  if (!body.success) return respond({ error: 'Invalid replan request' }, 400);
  return respond(
    await replacePlannedActivities(
      store,
      userId,
      session,
      request.content,
      now,
      body.data.remainingBudgetMinutes,
      {
        schedulerState: (date, course) => repo.schedulerState(date, course),
        attemptedExerciseIdsByActivity: (ids) => repo.attemptedExerciseIdsByActivity(ids),
        initialProgress: (activity, lesson) =>
          initialLearnProgress(store, userId, activity, lesson),
      },
    ),
  );
}
