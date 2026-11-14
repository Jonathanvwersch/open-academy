import { and, desc, eq, gte, inArray, lte } from 'drizzle-orm';
import { z } from 'zod';
import {
  attempts,
  masteryEvents,
  sessionActivities,
  studySessions,
  xpEvents,
} from '../../db/schema.js';
import { answerDisplay } from '../../learning/answer-display.js';
import { answerOptionsFor } from '../../learning/answer-options.js';
import {
  filterSchedulerStateForContent,
  sessionActivityIsInContent,
} from '../../learning/content-filters.js';
import { buildCourseStartState, needsCourseChoice } from '../../learning/course-start.js';
import { initialLearnProgress } from '../../learning/initial-learn-progress.js';
import { recordLessonViewed } from '../../learning/mastery.js';
import {
  activeCourseFor,
  compareOutlinePosition,
  masteryKey,
  prerequisiteMet,
} from '../../learning/prerequisites.js';
import { attemptAllowsRetry } from '../../learning/retry.js';
import type { PlannedActivity, SessionPreferences } from '../../learning/scheduler.js';
import {
  currentLearnerUnit,
  planSession,
  replan,
  sessionBudget,
} from '../../learning/scheduler.js';
import { masteryRank } from '../../learning/types.js';
import { localDateKey, sessionKindForDate, xpGoalFor } from '../../learning/xp.js';
import { type FeatureRequest, type FeatureServices, serviceResult } from '../../service-context.js';

export async function getToday(deps: FeatureServices, request: FeatureRequest) {
  const { content, tutorProvider } = deps;
  const [index, repo] = [await content(), request.repo];
  const now = request.now();
  const state = filterSchedulerStateForContent(index, await repo.schedulerState(now));
  const user = await repo.user();
  const prefs = (user?.prefs ?? {}) as SessionPreferences & { goal?: string };
  const subjectTitle = index.curriculum?.subject?.title;
  const sessionKind = sessionKindForDate(localDateKey(now, request.timeZone));
  const budget = sessionBudget(sessionKind, prefs, localDateKey(now, request.timeZone));
  const plan = planSession(state, index, now, budget, sessionKind);
  const [active, enrollments, placementRuns] = await Promise.all([
    repo.activeSession(now),
    repo.courseEnrollments(),
    repo.activePlacementRuns(),
  ]);
  const activeSession = active ? await repo.session(active.id) : undefined;
  const hasCurrentActivity =
    !activeSession ||
    activeSession.activities.length === 0 ||
    activeSession.activities.some(
      (activity) =>
        (activity.status === 'planned' || activity.status === 'in_progress') &&
        sessionActivityIsInContent(index, activity),
    );
  const activeSessionId = hasCurrentActivity ? (active?.id ?? null) : null;
  const startState = buildCourseStartState({
    content: index,
    activeCourseId: state.activeCourseId,
    mastery: state.mastery,
    lessonRuns: state.lessonRuns ?? [],
    enrollments,
    placementRuns,
  });
  const course = activeCourseFor(index, state.activeCourseId);
  const unit = currentLearnerUnit(state, index);
  const unitFocus = course?.units[unit - 1];
  return serviceResult({
    needsCourseChoice: needsCourseChoice({
      activeCourseId: state.activeCourseId,
      mastery: state.mastery,
      lessonRuns: state.lessonRuns ?? [],
    }),
    courseStart: startState.courseStart,
    objective:
      unitFocus?.title ??
      prefs.goal ??
      (subjectTitle ? `Make steady progress in ${subjectTitle}.` : 'Make steady progress.'),
    courseTitle: course?.title ?? '',
    unitTitle: unitFocus?.title ?? `Unit ${unit}`,
    unit,
    dueReviews: plan.activities.filter((activity) => activity.kind === 'review').length,
    budgetMinutes: budget,
    sessionKind,
    activeSessionId,
    tutorEnabled: tutorProvider !== null,
    plan: {
      ...plan,
      activities: plan.activities.map((activity) => ({
        ...activity,
        conceptTitle: activity.conceptId
          ? index.conceptsById.get(activity.conceptId)?.title
          : undefined,
      })),
    },
  });
}

export async function postSessions(deps: FeatureServices, request: FeatureRequest) {
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
  const sessionKind = body.data.kind ?? sessionKindForDate(localDateKey(now, request.timeZone));
  const state = filterSchedulerStateForContent(index, await repo.schedulerState(now));
  const user = await repo.user();
  const prefs = (user?.prefs ?? {}) as SessionPreferences;
  const budgetMinutes =
    body.data.budgetMinutes ??
    sessionBudget(sessionKind, prefs, localDateKey(now, request.timeZone));
  if (body.data.focusConceptId) {
    const focusConcept = index.conceptsById.get(body.data.focusConceptId);
    if (!focusConcept) {
      return serviceResult({ error: 'Concept not found' }, 404);
    }
    if (focusConcept.status === 'stub') {
      return serviceResult({ error: 'Concept is not yet authored' }, 409);
    }
    const masteryByKey = new Map(
      state.mastery.map((record) => [masteryKey(record.conceptId, record.dimension), record]),
    );
    const unmetPrerequisite = focusConcept.prereqs
      .filter((prerequisite) => prerequisite.strength === 'hard')
      .slice()
      .sort((left, right) => compareOutlinePosition(left.id, right.id, index, state.activeCourseId))
      .find(
        (prerequisite) =>
          !prerequisiteMet(prerequisite.id, masteryByKey, state.lessonRuns ?? [], index),
      );
    if (unmetPrerequisite) {
      const prerequisiteTitle =
        index.conceptsById.get(unmetPrerequisite.id)?.title ?? unmetPrerequisite.id;
      return serviceResult({ error: `Finish ${prerequisiteTitle} first` }, 409);
    }
    state.inProgressConceptId = body.data.focusConceptId;
  }
  const plan = planSession(state, index, now, budgetMinutes, sessionKind);
  if (body.data.focusConceptId) {
    const inProgressLessonConcepts = new Set(
      (state.lessonRuns ?? [])
        .filter(
          (run) =>
            run.status === 'in_progress' || run.status === 'needs_retry' || run.status === 'quiz',
        )
        .map((run) => run.conceptId),
    );
    const keptActivities = plan.activities
      .map((activity, index) => ({ activity, reason: plan.reasons[index] }))
      .filter(
        ({ activity }) =>
          activity.kind !== 'learn' ||
          activity.conceptId === body.data.focusConceptId ||
          inProgressLessonConcepts.has(activity.conceptId ?? ''),
      );
    plan.activities = keptActivities.map(({ activity }) => activity);
    plan.reasons = keptActivities.flatMap(({ reason }) => (reason ? [reason] : []));
  }
  if (
    body.data.focusConceptId &&
    !plan.activities.some(
      (activity) => activity.kind === 'learn' && activity.conceptId === body.data.focusConceptId,
    )
  ) {
    const concept = index.conceptsById.get(body.data.focusConceptId);
    const lesson = index.lessonsByConcept.get(body.data.focusConceptId);
    const exercise = lesson?.final
      ? index.exercisesById.get(lesson.final)
      : index.exercisesByConcept
          .get(body.data.focusConceptId)
          ?.find((item) => item.role === 'core' || item.role === 'check');
    if (!concept || !exercise) {
      return serviceResult({ error: 'No eligible exercise exists for this concept.' }, 409);
    }
    const priorEvidence = state.mastery.some(
      (record) =>
        record.conceptId === concept.id &&
        (record.inferred || masteryRank(record.state) >= masteryRank('assisted')),
    );
    const reason = {
      terms: { goal: 0, week_fit: 0, project: 0, unlock: 0, gap: 0, review: 0, cost: 0 },
      summary: 'Manual study override selected from the knowledge map.',
    };
    plan.activities.unshift({
      kind: lesson ? 'learn' : priorEvidence ? 'practice' : 'learn',
      conceptId: concept.id,
      exerciseIds: [exercise.id],
      plannedMinutes: exercise.est_minutes,
      reason,
    });
    plan.reasons.unshift(reason);
  }
  if (body.data.focusConceptId) {
    const focusedIndex = plan.activities.findIndex(
      (activity) => activity.kind === 'learn' && activity.conceptId === body.data.focusConceptId,
    );
    if (focusedIndex > 0) {
      const [focusedActivity] = plan.activities.splice(focusedIndex, 1);
      const [focusedReason] = plan.reasons.splice(focusedIndex, 1);
      if (focusedActivity && focusedReason) {
        plan.activities.unshift(focusedActivity);
        plan.reasons.unshift(focusedReason);
      }
    }
  }
  await db
    .update(studySessions)
    .set({ status: 'abandoned', endedAt: now })
    .where(and(eq(studySessions.userId, request.userId), eq(studySessions.status, 'active')));
  const [session] = await db
    .insert(studySessions)
    .values({
      userId: request.userId,
      kind: sessionKind,
      plannedMinutes: budgetMinutes,
      startedAt: now,
      status: 'active',
      plan: { activities: plan.activities, reasons: plan.reasons, schedulerVersion: '1' },
    })
    .returning();
  const createdActivities = await Promise.all(
    plan.activities.map(async (activity, idx) => {
      const progress = await initialLearnProgress(
        db,
        request.userId,
        activity,
        activity.conceptId ? index.lessonsByConcept.get(activity.conceptId) : undefined,
      );
      return db
        .insert(sessionActivities)
        .values({
          sessionId: session.id,
          idx,
          kind: activity.kind,
          conceptId: activity.conceptId,
          projectId: activity.projectId,
          exerciseIds: activity.exerciseIds,
          plannedMinutes: activity.plannedMinutes,
          status: idx === 0 ? 'in_progress' : 'planned',
          reason: activity.reason,
          ...(progress ? { progress } : {}),
        })
        .returning();
    }),
  );
  return serviceResult({ ...session, activities: createdActivities.flat() }, 201);
}

export async function getSessionsActive(deps: FeatureServices, request: FeatureRequest) {
  const { content } = deps;
  const now = request.now();
  const session = await request.repo.activeSession(now);
  const index = await content();
  const fullSession = session ? await request.repo.session(session.id) : null;
  const activities =
    fullSession?.activities.filter((activity) => sessionActivityIsInContent(index, activity)) ?? [];
  return serviceResult(
    fullSession && activities.length
      ? {
          ...fullSession,
          activities: activities.map((activity) => ({
            ...activity,
            conceptTitle: activity.conceptId
              ? index.conceptsById.get(activity.conceptId)?.title
              : undefined,
          })),
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
  const activities =
    session?.activities.filter((activity) => sessionActivityIsInContent(index, activity)) ?? [];
  const activityIds = activities.map((activity) => activity.id);
  const activityAttempts = activityIds.length
    ? await db
        .select()
        .from(attempts)
        .where(and(eq(attempts.userId, request.userId), inArray(attempts.activityId, activityIds)))
        .orderBy(desc(attempts.createdAt), desc(attempts.attemptNo))
    : [];
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
          db
            .select({ amount: xpEvents.amount })
            .from(xpEvents)
            .where(and(eq(xpEvents.userId, request.userId), eq(xpEvents.localDate, todayLocal))),
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
        xp,
        activities: activities.map((activity) => ({
          ...activity,
          conceptTitle: activity.conceptId
            ? index.conceptsById.get(activity.conceptId)?.title
            : undefined,
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
              const exercise = index.exercisesById.get(attempt.exerciseId);
              const answerOptions = exercise
                ? answerOptionsFor(exercise, answer, !retryAllowed)
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
                exemplar: feedback.exemplar,
                solution: feedback.solution,
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
  const { db, content } = deps;
  const body = z.record(z.string(), z.unknown()).safeParse(request.body);
  if (!body.success) {
    return serviceResult({ error: 'Invalid progress' }, 400);
  }
  const session = await request.repo.session(request.params.id);
  const activity = session?.activities.find((item) => item.id === request.params.aid);
  if (!activity) {
    return serviceResult({ error: 'Activity not found' }, 404);
  }
  const completed = body.data.complete === true;
  const { complete: _complete, ...progress } = body.data;
  const now = request.now();
  const lessonIndex =
    body.data.lessonRunnerContinued === true &&
    !completed &&
    activity.kind === 'learn' &&
    activity.conceptId
      ? await content()
      : null;
  const lesson = activity.conceptId
    ? lessonIndex?.lessonsByConcept.get(activity.conceptId)
    : undefined;
  const exerciseIds =
    lesson?.knowledge_points?.length && lesson.final ? [lesson.final] : activity.exerciseIds;
  const [updated] = await db
    .update(sessionActivities)
    .set({
      progress,
      status: completed ? 'completed' : 'in_progress',
      startedAt: activity.startedAt ?? now,
      completedAt: completed ? now : null,
      ...(exerciseIds !== activity.exerciseIds ? { exerciseIds } : {}),
    })
    .where(eq(sessionActivities.id, activity.id))
    .returning();
  if (activity.kind === 'learn' && activity.conceptId && body.data.lessonViewed === true) {
    const index = await content();
    const concept = index.conceptsById.get(activity.conceptId);
    for (const dimension of concept?.dimensions ?? []) {
      const viewed = recordLessonViewed(
        await request.repo.masteryRecord(activity.conceptId, dimension),
        activity.conceptId,
        dimension,
        request.now(),
      );
      await request.repo.saveMastery(viewed.mastery);
      if (viewed.event) {
        await db.insert(masteryEvents).values({
          userId: request.userId,
          conceptId: viewed.event.conceptId,
          dimension: viewed.event.dimension,
          fromState: viewed.event.fromState,
          toState: viewed.event.toState,
          rule: viewed.event.rule,
          createdAt: request.now(),
        });
      }
    }
  }
  if (completed && session) {
    const nextActivity = session.activities
      .filter((item) => item.status === 'planned')
      .sort((left, right) => left.idx - right.idx)[0];
    if (nextActivity) {
      await db
        .update(sessionActivities)
        .set({ status: 'in_progress', startedAt: now })
        .where(eq(sessionActivities.id, nextActivity.id));
    }
  }
  return serviceResult(updated);
}

export async function postSessionsByIdReplan(deps: FeatureServices, request: FeatureRequest) {
  const { db, content } = deps;
  const session = await request.repo.session(request.params.id);
  if (!session) {
    return serviceResult({ error: 'Session not found' }, 404);
  }
  const now = request.now();
  const body = z
    .object({ remainingBudgetMinutes: z.number().int().min(0).optional() })
    .safeParse(request.body);
  const state = await request.repo.schedulerState(now);
  const activities = session.activities as unknown as PlannedActivity[];
  const existingMinutes = activities
    .filter((activity) => activity.status === 'completed' || activity.status === 'in_progress')
    .reduce((total, activity) => total + activity.plannedMinutes, 0);
  const remaining = body.success
    ? (body.data.remainingBudgetMinutes ?? Math.max(0, session.plannedMinutes - existingMinutes))
    : Math.max(0, session.plannedMinutes - existingMinutes);
  const index = await content();
  const plan = replan(state, index, now, remaining, activities, session.kind);
  const planned = session.activities.filter((activity) => activity.status === 'planned');
  await Promise.all(
    planned.map((activity) =>
      db.delete(sessionActivities).where(eq(sessionActivities.id, activity.id)),
    ),
  );
  const preserved = session.activities.filter((activity) => activity.status !== 'planned');
  const created = await Promise.all(
    plan.activities
      .filter((activity) => activity.status !== 'in_progress')
      .map(async (activity, idx) => {
        const progress = await initialLearnProgress(
          db,
          request.userId,
          activity,
          activity.conceptId ? index.lessonsByConcept.get(activity.conceptId) : undefined,
        );
        return db
          .insert(sessionActivities)
          .values({
            sessionId: session.id,
            idx: preserved.length + idx,
            kind: activity.kind,
            conceptId: activity.conceptId,
            projectId: activity.projectId,
            exerciseIds: activity.exerciseIds,
            plannedMinutes: activity.plannedMinutes,
            status: 'planned',
            reason: activity.reason,
            ...(progress ? { progress } : {}),
          })
          .returning();
      }),
  );
  return serviceResult({ activities: [...preserved, ...created.flat()] });
}

export async function postSessionsByIdEnd(deps: FeatureServices, request: FeatureRequest) {
  const { db } = deps;
  const previous = await request.repo.session(request.params.id);
  if (!previous) return serviceResult({ error: 'Session not found' }, 404);
  if (previous.status === 'completed') return serviceResult(previous);
  const endedAt = request.now();
  const elapsedSeconds = previous.startedAt
    ? Math.max(0, Math.floor((endedAt.getTime() - previous.startedAt.getTime()) / 1000))
    : 0;
  const [session] = await db
    .update(studySessions)
    .set({
      endedAt,
      status: 'completed',
      activeSeconds: previous.activeSeconds + elapsedSeconds,
    })
    .where(and(eq(studySessions.id, request.params.id), eq(studySessions.userId, request.userId)))
    .returning();
  return session ? serviceResult(session) : serviceResult({ error: 'Session not found' }, 404);
}
