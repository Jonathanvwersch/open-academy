import { and, desc, eq, sql } from 'drizzle-orm';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { z } from 'zod';
import { loadContent } from '../content/load.js';
import { serializeConcept, serializeExercise, serializeLesson } from '../content/serialize.js';
import type { ContentIndex, IndexedExercise } from '../content/types.js';
import type { Database } from '../db/client.js';
import { LearnerRepository } from '../db/repository.js';
import {
  attempts,
  diagnosticRuns,
  hintEvents,
  masteryEvents,
  remediationFlags,
  reviewCards,
  reviewLogs,
  sessionActivities,
  studySessions,
  users,
} from '../db/schema.js';
import { gradeExercise } from '../grading/index.js';
import { deriveLearningDebt } from '../learning/debt.js';
import {
  createDiagnosticState,
  diagnosticComplete,
  markDiagnosticUnassessed,
  nextDiagnosticExercise,
  recordDiagnosticAnswer,
} from '../learning/diagnostic.js';
import {
  mapReviewRating,
  newReviewCard,
  scheduleInitialReview,
  scheduleReview,
} from '../learning/fsrs.js';
import { countHintsSincePreviousAttempt } from '../learning/hints.js';
import {
  calculateCredit,
  DefaultMasteryModel,
  inferPrerequisite,
  recordLessonViewed,
} from '../learning/mastery.js';
import type { PlannedActivity } from '../learning/scheduler.js';
import { currentCurriculumWeek, planSession, replan } from '../learning/scheduler.js';
import type { LearningMode, MasteryRecord } from '../learning/types.js';
import { initialMastery, masteryRank } from '../learning/types.js';

type ApiEnv = { Variables: { userId: string } };

export function createApiRoutes(deps: { db: Database; content?: ContentIndex }) {
  const api = new Hono<ApiEnv>();
  const contentPromise = deps.content ? Promise.resolve(deps.content) : loadContent();
  const db = deps.db;

  api.use('*', async (context, next) => {
    const [user] = await db.select().from(users).limit(1);
    if (!user) {
      return context.json({ error: 'Seed the default learner before using the API.' }, 503);
    }
    context.set('userId', user.id);
    await next();
  });

  const withRepo = (context: Context<ApiEnv>) => new LearnerRepository(db, context.get('userId'));
  const content = () => contentPromise;

  api.get('/today', async (context) => {
    const [index, repo] = [await content(), withRepo(context)];
    const now = requestNow(context);
    const state = await repo.schedulerState(now);
    const user = await repo.user();
    const prefs = (user?.prefs ?? {}) as { scheduleMinutes?: number; goal?: string };
    const budget = Math.max(5, Number(prefs.scheduleMinutes ?? 60));
    const plan = planSession(state, index, now, budget);
    const active = await repo.activeSession();
    const diagnostic = await repo.latestDiagnosticRun();
    const week = currentCurriculumWeek(state.startDate, now);
    const weekFocus = index.curriculum?.weeks.find((entry) => entry.week === week);
    return context.json({
      needsDiagnostic: (!diagnostic || diagnostic.status === 'active') && Boolean(index.diagnostic),
      diagnosticActive: diagnostic?.status === 'active',
      diagnosticRunId: diagnostic?.status === 'active' ? diagnostic.id : null,
      objective: weekFocus?.title ?? prefs.goal ?? 'Build a steady foundation in machine learning.',
      weekTitle: weekFocus?.title ?? `Week ${week}`,
      week,
      dueReviews: plan.activities.filter((activity) => activity.kind === 'review').length,
      budgetMinutes: budget,
      activeSessionId: active?.id ?? null,
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
  });

  api.post('/sessions', async (context) => {
    const body = z
      .object({
        kind: z.enum(['weekday', 'saturday', 'sunday', 'custom']).default('weekday'),
        budgetMinutes: z.number().int().positive().max(600).optional(),
        focusConceptId: z.string().optional(),
      })
      .safeParse(await context.req.json().catch(() => ({})));
    if (!body.success) {
      return context.json({ error: 'Invalid session request', issues: body.error.issues }, 400);
    }
    const [index, repo] = [await content(), withRepo(context)];
    const now = requestNow(context);
    const state = await repo.schedulerState(now);
    if (body.data.focusConceptId) {
      const focusConcept = index.conceptsById.get(body.data.focusConceptId);
      if (!focusConcept) {
        return context.json({ error: 'Concept not found' }, 404);
      }
      if (focusConcept.status === 'stub') {
        return context.json({ error: 'Concept is not yet authored' }, 409);
      }
      state.inProgressConceptId = body.data.focusConceptId;
    }
    const plan = planSession(state, index, now, body.data.budgetMinutes ?? 60, body.data.kind);
    if (
      body.data.focusConceptId &&
      !plan.activities.some((activity) => activity.conceptId === body.data.focusConceptId)
    ) {
      const concept = index.conceptsById.get(body.data.focusConceptId);
      const exercise = index.exercisesByConcept
        .get(body.data.focusConceptId)
        ?.find((item) => item.role === 'core' || item.role === 'check');
      if (!concept || !exercise) {
        return context.json({ error: 'No eligible exercise exists for this concept.' }, 409);
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
        kind: priorEvidence ? 'practice' : 'learn',
        conceptId: concept.id,
        exerciseIds: [exercise.id],
        plannedMinutes: exercise.est_minutes,
        reason,
      });
      plan.reasons.unshift(reason);
    }
    const [session] = await db
      .insert(studySessions)
      .values({
        userId: context.get('userId'),
        kind: body.data.kind,
        plannedMinutes: body.data.budgetMinutes ?? 60,
        startedAt: now,
        status: 'active',
        plan: { activities: plan.activities, reasons: plan.reasons, schedulerVersion: '1' },
      })
      .returning();
    const createdActivities = await Promise.all(
      plan.activities.map((activity, idx) =>
        db
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
          })
          .returning(),
      ),
    );
    return context.json({ ...session, activities: createdActivities.flat() }, 201);
  });

  api.get('/sessions/active', async (context) => {
    const session = await withRepo(context).activeSession();
    const index = await content();
    const fullSession = session ? await withRepo(context).session(session.id) : null;
    return context.json(
      fullSession
        ? {
            ...fullSession,
            activities: fullSession.activities.map((activity) => ({
              ...activity,
              conceptTitle: activity.conceptId
                ? index.conceptsById.get(activity.conceptId)?.title
                : undefined,
            })),
            serverNow: requestNow(context),
          }
        : null,
    );
  });

  api.get('/sessions/:id', async (context) => {
    const session = await withRepo(context).session(context.req.param('id'));
    const index = await content();
    return session
      ? context.json({
          ...session,
          activities: session.activities.map((activity) => ({
            ...activity,
            conceptTitle: activity.conceptId
              ? index.conceptsById.get(activity.conceptId)?.title
              : undefined,
          })),
          serverNow: requestNow(context),
        })
      : context.json({ error: 'Session not found' }, 404);
  });

  api.post('/sessions/:id/activities/:aid/progress', async (context) => {
    const body = z
      .record(z.string(), z.unknown())
      .safeParse(await context.req.json().catch(() => ({})));
    if (!body.success) {
      return context.json({ error: 'Invalid progress' }, 400);
    }
    const session = await withRepo(context).session(context.req.param('id'));
    const activity = session?.activities.find((item) => item.id === context.req.param('aid'));
    if (!activity) {
      return context.json({ error: 'Activity not found' }, 404);
    }
    const completed = body.data.complete === true;
    const { complete: _complete, ...progress } = body.data;
    const now = requestNow(context);
    const [updated] = await db
      .update(sessionActivities)
      .set({
        progress,
        status: completed ? 'completed' : 'in_progress',
        startedAt: activity.startedAt ?? now,
        completedAt: completed ? now : null,
      })
      .where(eq(sessionActivities.id, activity.id))
      .returning();
    if (activity.kind === 'learn' && activity.conceptId && body.data.lessonViewed === true) {
      const index = await content();
      const concept = index.conceptsById.get(activity.conceptId);
      for (const dimension of concept?.dimensions ?? []) {
        const viewed = recordLessonViewed(
          await withRepo(context).masteryRecord(activity.conceptId, dimension),
          activity.conceptId,
          dimension,
          requestNow(context),
        );
        await withRepo(context).saveMastery(viewed.mastery);
        if (viewed.event) {
          await db.insert(masteryEvents).values({
            userId: context.get('userId'),
            conceptId: viewed.event.conceptId,
            dimension: viewed.event.dimension,
            fromState: viewed.event.fromState,
            toState: viewed.event.toState,
            rule: viewed.event.rule,
            createdAt: requestNow(context),
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
    return context.json(updated);
  });

  api.post('/sessions/:id/replan', async (context) => {
    const session = await withRepo(context).session(context.req.param('id'));
    if (!session) {
      return context.json({ error: 'Session not found' }, 404);
    }
    const now = requestNow(context);
    const body = z
      .object({ remainingBudgetMinutes: z.number().int().min(0).optional() })
      .safeParse(await context.req.json().catch(() => ({})));
    const state = await withRepo(context).schedulerState(now);
    const activities = session.activities as unknown as PlannedActivity[];
    const existingMinutes = activities
      .filter((activity) => activity.status === 'completed' || activity.status === 'in_progress')
      .reduce((total, activity) => total + activity.plannedMinutes, 0);
    const remaining = body.success
      ? (body.data.remainingBudgetMinutes ?? Math.max(0, session.plannedMinutes - existingMinutes))
      : Math.max(0, session.plannedMinutes - existingMinutes);
    const plan = replan(state, await content(), now, remaining, activities, session.kind);
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
        .map((activity, idx) =>
          db
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
            })
            .returning(),
        ),
    );
    return context.json({ activities: [...preserved, ...created.flat()] });
  });

  api.post('/sessions/:id/end', async (context) => {
    const [session] = await db
      .update(studySessions)
      .set({ endedAt: requestNow(context), status: 'completed' })
      .where(
        and(
          eq(studySessions.id, context.req.param('id')),
          eq(studySessions.userId, context.get('userId')),
        ),
      )
      .returning();
    return session ? context.json(session) : context.json({ error: 'Session not found' }, 404);
  });

  api.get('/exercises/:id', async (context) => {
    const exercise = (await content()).exercisesById.get(context.req.param('id'));
    return exercise
      ? context.json(serializeExercise(exercise, context.get('userId')))
      : context.json({ error: 'Exercise not found' }, 404);
  });

  api.get('/lessons/:conceptId', async (context) => {
    const index = await content();
    const conceptId = context.req.param('conceptId');
    const lesson = index.lessonsByConcept.get(conceptId);
    const priorEvidence = (await withRepo(context).masteryRecords()).some(
      (record) =>
        record.conceptId === conceptId &&
        (record.inferred || masteryRank(record.state) >= masteryRank('assisted')),
    );
    const presentedLesson =
      lesson && priorEvidence
        ? {
            ...lesson,
            blocks: lesson.blocks.filter((block) => !lesson.fast_path.includes(block.kind)),
          }
        : lesson;
    return presentedLesson
      ? context.json(serializeLesson(presentedLesson))
      : context.json({ error: 'Lesson not found' }, 404);
  });

  api.post('/hints', async (context) => {
    const body = z
      .object({
        exerciseId: z.string(),
        activityId: z.string().uuid().optional(),
        mode: z.enum(['practice', 'review', 'assessment', 'diagnostic']).default('practice'),
        stuck: z.boolean().default(false),
      })
      .safeParse(await context.req.json().catch(() => ({})));
    if (!body.success) {
      return context.json({ error: 'Invalid hint request' }, 400);
    }
    if (body.data.mode === 'assessment' || body.data.mode === 'diagnostic') {
      return context.json({ error: 'Hints are unavailable in assessment mode.' }, 403);
    }
    if (body.data.mode === 'review' && !body.data.stuck) {
      return context.json(
        { error: 'Confirm that you are stuck before requesting review help.' },
        400,
      );
    }
    const exercise = (await content()).exercisesById.get(body.data.exerciseId);
    if (!exercise) {
      return context.json({ error: 'Exercise not found' }, 404);
    }
    if (exercise.role === 'diagnostic') {
      return context.json({ error: 'Diagnostic exercises do not allow hints.' }, 403);
    }
    if (body.data.activityId) {
      const [activityRow] = await db
        .select()
        .from(sessionActivities)
        .where(eq(sessionActivities.id, body.data.activityId))
        .limit(1);
      const session = activityRow
        ? await withRepo(context).session(activityRow.sessionId)
        : undefined;
      const activity = session?.activities.find((item) => item.id === body.data.activityId);
      if (!activity?.exerciseIds.includes(exercise.id)) {
        return context.json({ error: 'Activity or exercise not found' }, 404);
      }
      if (activity.kind === 'quick_check' || activity.kind === 'diagnostic') {
        return context.json({ error: 'Assessment activities do not allow hints.' }, 403);
      }
      if (
        (activity.kind === 'review' && body.data.mode !== 'review') ||
        (activity.kind !== 'review' && body.data.mode !== 'practice')
      ) {
        return context.json({ error: 'Hint mode does not match this activity.' }, 400);
      }
    }
    const hintsUsed = await hintsSincePreviousAttempt(
      db,
      context.get('userId'),
      exercise.id,
      body.data.activityId,
    );
    const level = hintsUsed + 1;
    if (level > 5) {
      return context.json({ error: 'The solution has already been revealed.' }, 409);
    }
    const hints = (exercise as IndexedExercise & { hints?: string[] }).hints ?? [];
    const text =
      level === 5
        ? exercise.solution
        : (hints[level - 1] ?? 'No further authored hint is available at this level.');
    const [event] = await withRepo(context).saveHintEvent({
      activityId: body.data.activityId,
      exerciseId: exercise.id,
      level,
      text,
      createdAt: requestNow(context),
    });
    return context.json({ level, text, revealedSolution: level === 5, hintEventId: event?.id });
  });

  api.post('/attempts', async (context) => {
    const body = z
      .object({
        exerciseId: z.string(),
        activityId: z.string().uuid().optional(),
        answer: z.unknown(),
        mode: z.enum(['practice', 'assessment', 'diagnostic', 'review']).default('practice'),
        durationMs: z.number().int().nonnegative().optional(),
      })
      .safeParse(await context.req.json().catch(() => ({})));
    if (!body.success) {
      return context.json({ error: 'Invalid attempt' }, 400);
    }
    const index = await content();
    const exercise = index.exercisesById.get(body.data.exerciseId);
    if (!exercise) {
      return context.json({ error: 'Exercise not found' }, 404);
    }
    const repo = withRepo(context);
    const [activityRow] = body.data.activityId
      ? await db
          .select()
          .from(sessionActivities)
          .where(eq(sessionActivities.id, body.data.activityId))
          .limit(1)
      : [];
    const session = activityRow ? await repo.session(activityRow.sessionId) : undefined;
    const activity = session?.activities.find((item) => item.id === body.data.activityId);
    if (activityRow && !activity) {
      return context.json({ error: 'Activity not found' }, 404);
    }
    if (activity && !activity.exerciseIds.includes(exercise.id)) {
      return context.json({ error: 'Exercise is not part of this activity.' }, 400);
    }
    if (
      activity &&
      (activity.kind === 'diagnostic' || activity.kind === 'quick_check') &&
      body.data.mode !== 'diagnostic' &&
      body.data.mode !== 'assessment'
    ) {
      return context.json({ error: 'This activity requires assessment mode.' }, 400);
    }
    if (activity?.kind === 'review' && body.data.mode !== 'review') {
      return context.json({ error: 'Review attempts must use review mode.' }, 400);
    }
    if (
      activity &&
      activity.kind !== 'review' &&
      activity.kind !== 'quick_check' &&
      activity.kind !== 'diagnostic' &&
      body.data.mode !== 'practice'
    ) {
      return context.json({ error: 'This activity requires practice mode.' }, 400);
    }
    if (activity && activity.kind !== 'review' && body.data.mode === 'review') {
      return context.json({ error: 'Review mode is only available for review activities.' }, 400);
    }
    const previousAttempts = body.data.activityId
      ? await repo.attemptsForActivity(body.data.activityId, exercise.id)
      : [];
    if (body.data.mode === 'practice' && previousAttempts.length >= 2) {
      return context.json({ error: 'No retries remain.', solution: exercise.solution }, 409);
    }
    if (body.data.mode !== 'practice' && previousAttempts.length >= 1) {
      return context.json({ error: 'This activity allows one attempt.' }, 409);
    }
    const attemptNo = previousAttempts.length + 1;
    const result = await gradeExercise(exercise, body.data.answer);
    if (result.status !== 'graded') {
      return context.json(result, result.status === 'invalid' ? 422 : 200);
    }
    const now = requestNow(context);
    const attemptId = crypto.randomUUID();
    const gradedBy = result.graded_by ?? 'deterministic';
    const hintsUsed = await hintsSincePreviousAttempt(
      db,
      context.get('userId'),
      exercise.id,
      body.data.activityId,
    );
    const credit = calculateCredit({
      correct: result.correct,
      hintsUsed,
      attemptNo,
      gradedBy,
    });
    const sessionId = activityRow?.sessionId;
    await db.insert(attempts).values({
      id: attemptId,
      userId: context.get('userId'),
      sessionId,
      activityId: body.data.activityId,
      exerciseId: exercise.id,
      exerciseVersion: exercise.contentVersion,
      conceptId: exercise.concept,
      dimension: exercise.dimension,
      mode: body.data.mode,
      answer: body.data.answer,
      correct: result.correct,
      credit,
      hintsUsed,
      attemptNo,
      gradedBy,
      feedback: { message: result.feedback },
      mistakeCategory: result.mistake_category,
      durationMs: body.data.durationMs,
      createdAt: now,
    });
    const masteryResult = await applyMastery({
      repo,
      userId: context.get('userId'),
      exercise,
      attemptId,
      correct: result.correct,
      credit,
      hintsUsed,
      attemptNo,
      mode: body.data.mode,
      gradedBy,
      now,
    });
    if (body.data.mode === 'review') {
      const [card] = await db
        .select()
        .from(reviewCards)
        .where(
          and(
            eq(reviewCards.userId, context.get('userId')),
            eq(reviewCards.conceptId, exercise.concept),
            eq(reviewCards.dimension, exercise.dimension),
          ),
        )
        .limit(1);
      if (card) {
        const rating = mapReviewRating({ correct: result.correct, hintsUsed, attemptNo });
        const scheduled = scheduleReview(
          card.fsrs as never,
          now,
          rating,
          process.env.NODE_ENV !== 'test',
        );
        await db
          .update(reviewCards)
          .set({
            fsrs: scheduled.card,
            dueAt: scheduled.card.due,
            lastReviewAt: now,
            reps: scheduled.card.reps,
            lapses: scheduled.card.lapses,
          })
          .where(eq(reviewCards.id, card.id));
        await db.insert(reviewLogs).values({
          cardId: card.id,
          attemptId,
          rating: String(rating),
          fsrsLog: scheduled.log,
          createdAt: now,
        });
      }
    }
    const retryAllowed = body.data.mode === 'practice' && result.correct === 0 && attemptNo < 2;
    const revealSolution = body.data.mode === 'practice' && result.correct === 0 && attemptNo >= 2;
    if (activityRow && activity && (result.correct > 0 || !retryAllowed)) {
      const progress = activity.progress as {
        completedExerciseIds?: string[];
        outcomes?: Record<string, 'correct' | 'incorrect'>;
      };
      const outcomes = {
        ...(progress.outcomes ?? {}),
        [exercise.id]: result.correct > 0 ? 'correct' : 'incorrect',
      };
      const completedExerciseIds = [
        ...new Set([...(progress.completedExerciseIds ?? []), exercise.id]),
      ];
      let exerciseIds = activity.exerciseIds;
      let learningGoalMet = false;
      if (activity.kind === 'learn' && activity.conceptId) {
        const mastery = masteryResult.mastery as MasteryRecord;
        learningGoalMet = mastery.independentItemIds.length >= 2 && mastery.lastIndependentCorrect;
        if (!learningGoalMet) {
          const recentIds = new Set(
            (await repo.recentAttempts(100))
              .filter((attempt) => now.getTime() - attempt.createdAt.getTime() < 7 * 86_400_000)
              .map((attempt) => attempt.exerciseId),
          );
          const nextExercise = (index.exercisesByConcept.get(activity.conceptId) ?? []).find(
            (candidate) =>
              candidate.dimension === exercise.dimension &&
              (candidate.role === 'core' || candidate.role === 'check') &&
              !exerciseIds.includes(candidate.id) &&
              !recentIds.has(candidate.id),
          );
          if (nextExercise) {
            exerciseIds = [...exerciseIds, nextExercise.id];
          }
        }
      }
      const completed =
        learningGoalMet || exerciseIds.every((id) => completedExerciseIds.includes(id));
      await db
        .update(sessionActivities)
        .set({
          exerciseIds,
          progress: { ...progress, completedExerciseIds, outcomes },
          status: completed ? 'completed' : 'in_progress',
          completedAt: completed ? now : null,
        })
        .where(eq(sessionActivities.id, activity.id));
      if (completed) {
        const nextActivity = session?.activities
          .filter((item) => item.status === 'planned')
          .sort((left, right) => left.idx - right.idx)[0];
        if (nextActivity) {
          await db
            .update(sessionActivities)
            .set({ status: 'in_progress', startedAt: now })
            .where(eq(sessionActivities.id, nextActivity.id));
        }
      }
    }
    return context.json({
      ...result,
      attemptId,
      attemptNo,
      hintsUsed,
      credit,
      mastery: masteryResult,
      retryAllowed,
      ...(result.correct === 0 && (body.data.mode !== 'practice' || revealSolution)
        ? { solution: exercise.solution }
        : {}),
    });
  });

  api.post('/diagnostic', async (context) => {
    const active = await db
      .select()
      .from(diagnosticRuns)
      .where(
        and(eq(diagnosticRuns.userId, context.get('userId')), eq(diagnosticRuns.status, 'active')),
      )
      .orderBy(desc(diagnosticRuns.startedAt))
      .limit(1);
    if (active[0]) {
      return context.json(active[0]);
    }
    const state = createDiagnosticState(await content());
    const [run] = await db
      .insert(diagnosticRuns)
      .values({
        userId: context.get('userId'),
        kind: 'baseline',
        state,
        startedAt: requestNow(context),
      })
      .returning();
    return context.json(run, 201);
  });

  api.get('/diagnostic/:id/next', async (context) => {
    const repo = withRepo(context);
    const run = await repo.diagnosticRun(context.req.param('id'));
    if (!run) {
      return context.json({ error: 'Diagnostic not found' }, 404);
    }
    const exercise = nextDiagnosticExercise(run.state as never, await content());
    if (!exercise) {
      return context.json({ complete: true });
    }
    const concept = (await content()).conceptsById.get(exercise.concept);
    return context.json({
      complete: false,
      domain: concept?.domain,
      domainId: concept?.domain,
      domainTitle:
        (await content()).curriculum?.domains.find((entry) => entry.id === concept?.domain)
          ?.title ?? concept?.domain,
      exercise: serializeExercise(exercise, context.get('userId')),
    });
  });

  api.post('/diagnostic/:id/skip', async (context) => {
    const body = z
      .object({ domain: z.string() })
      .safeParse(await context.req.json().catch(() => ({})));
    if (!body.success) {
      return context.json({ error: 'Invalid domain' }, 400);
    }
    const repo = withRepo(context);
    const run = await repo.diagnosticRun(context.req.param('id'));
    if (!run) {
      return context.json({ error: 'Diagnostic not found' }, 404);
    }
    const index = await content();
    const state = markDiagnosticUnassessed(
      run.state as never,
      body.data.domain,
      requestNow(context),
      index,
    );
    const complete = diagnosticComplete(state as never);
    await db
      .update(diagnosticRuns)
      .set({
        state,
        status: complete ? 'completed' : 'active',
        completedAt: complete ? requestNow(context) : null,
        summary: complete ? state : {},
      })
      .where(eq(diagnosticRuns.id, run.id));
    return context.json({ complete, state });
  });

  api.post('/diagnostic/:id/answer', async (context) => {
    const body = z
      .object({ exerciseId: z.string(), answer: z.unknown() })
      .safeParse(await context.req.json());
    if (!body.success) {
      return context.json({ error: 'Invalid diagnostic answer' }, 400);
    }
    const repo = withRepo(context);
    const run = await repo.diagnosticRun(context.req.param('id'));
    const index = await content();
    const exercise = index.exercisesById.get(body.data.exerciseId);
    if (!run || !exercise) {
      return context.json({ error: 'Diagnostic or exercise not found' }, 404);
    }
    const nextExercise = nextDiagnosticExercise(run.state as never, index);
    if (nextExercise?.id !== exercise.id) {
      return context.json({ error: 'This is not the current diagnostic item.' }, 409);
    }
    const result = await gradeExercise(exercise, body.data.answer);
    if (result.status !== 'graded') {
      return context.json(result, result.status === 'invalid' ? 422 : 200);
    }
    const now = requestNow(context);
    const currentState = run.state as never;
    const answer = recordDiagnosticAnswer(currentState, exercise, result.correct >= 1, index, now);
    const attemptId = crypto.randomUUID();
    const [attempt] = await db
      .insert(attempts)
      .values({
        id: attemptId,
        userId: context.get('userId'),
        exerciseId: exercise.id,
        exerciseVersion: exercise.contentVersion,
        conceptId: exercise.concept,
        dimension: exercise.dimension,
        mode: 'diagnostic',
        answer: body.data.answer,
        correct: result.correct,
        credit: result.correct,
        hintsUsed: 0,
        attemptNo: 1,
        gradedBy: result.graded_by ?? 'deterministic',
        feedback: { message: result.feedback },
        createdAt: now,
      })
      .returning();
    await applyMastery({
      repo,
      userId: context.get('userId'),
      exercise,
      attemptId,
      correct: result.correct,
      credit: result.correct,
      hintsUsed: 0,
      attemptNo: 1,
      mode: 'diagnostic',
      gradedBy: result.graded_by ?? 'deterministic',
      now,
    });
    const nextState = answer.state;
    for (const prerequisiteId of answer.inferredPrerequisiteIds) {
      const prerequisite = index.conceptsById.get(prerequisiteId);
      for (const dimension of prerequisite?.dimensions ?? []) {
        const inferred = inferPrerequisite(
          await repo.masteryRecord(prerequisiteId, dimension),
          prerequisiteId,
          dimension,
          now,
        );
        await repo.saveMastery(inferred.mastery);
        if (inferred.event) {
          await db.insert(masteryEvents).values({
            userId: context.get('userId'),
            conceptId: inferred.event.conceptId,
            dimension: inferred.event.dimension,
            fromState: inferred.event.fromState,
            toState: inferred.event.toState,
            rule: inferred.event.rule,
            createdAt: now,
          });
        }
      }
    }
    if (diagnosticComplete(nextState)) {
      await db
        .update(diagnosticRuns)
        .set({ state: nextState, status: 'completed', completedAt: now, summary: nextState })
        .where(eq(diagnosticRuns.id, run.id));
    } else {
      await db
        .update(diagnosticRuns)
        .set({ state: nextState })
        .where(eq(diagnosticRuns.id, run.id));
    }
    return context.json({
      ...result,
      ...(result.correct === 0 ? { solution: exercise.solution } : {}),
      evidence: answer.evidence,
      complete: diagnosticComplete(nextState),
      attemptId: attempt.id,
    });
  });

  api.get('/diagnostic/:id/results', async (context) => {
    const repo = withRepo(context);
    const run = await repo.diagnosticRun(context.req.param('id'));
    const index = await content();
    const now = requestNow(context);
    const state = await repo.schedulerState(now);
    const user = await repo.user();
    const prefs = (user?.prefs ?? {}) as { scheduleMinutes?: number };
    const firstSession = planSession(
      state,
      index,
      now,
      Math.max(5, Number(prefs.scheduleMinutes ?? 60)),
    );
    const runState = run?.state as
      | {
          domains?: Record<
            string,
            {
              status: string;
              answers: number;
              correctConceptIds: string[];
              gapConceptIds: string[];
            }
          >;
        }
      | undefined;
    const curriculum = index.curriculum;
    return run
      ? context.json({
          ...run,
          state: run.state,
          mastery: await repo.masteryRecords(),
          domains: (curriculum?.domains ?? []).map((domain) => {
            const progress = runState?.domains?.[domain.id];
            const concepts = index.concepts.filter((concept) => concept.domain === domain.id);
            const titleFor = (id: string) => index.conceptsById.get(id)?.title ?? id;
            return {
              id: domain.id,
              title: domain.title,
              outcome: progress?.status === 'unassessed' ? 'unassessed' : 'assessed',
              answers: progress?.answers ?? 0,
              knownConcepts: [...new Set(progress?.correctConceptIds ?? [])].map(titleFor),
              gaps: [...new Set(progress?.gapConceptIds ?? [])].map(titleFor),
              conceptCount: concepts.length,
            };
          }),
          plan: {
            firstWeek: curriculum?.weeks.find((entry) => entry.week === 1) ?? null,
            firstWeekConcepts:
              curriculum?.weeks
                .find((entry) => entry.week === 1)
                ?.concepts.map((id) => index.conceptsById.get(id)?.title ?? id) ?? [],
            firstSession: firstSession.activities.map((activity) => ({
              ...activity,
              conceptTitle: activity.conceptId
                ? index.conceptsById.get(activity.conceptId)?.title
                : undefined,
            })),
            ninetyDayPath: (curriculum?.weeks ?? [])
              .slice(0, 13)
              .map((entry) => ({ week: entry.week, title: entry.title })),
          },
        })
      : context.json({ error: 'Diagnostic not found' }, 404);
  });

  api.get('/map', async (context) => {
    const index = await content();
    const requestedDomain = context.req.query('domain');
    const currentWeek = currentCurriculumWeek(
      (await withRepo(context).user())?.startDate ?? new Date().toISOString(),
      requestNow(context),
    );
    const currentWeekDomain =
      index.curriculum?.weeks
        .find((entry) => entry.week === currentWeek)
        ?.concepts.map((id) => index.conceptsById.get(id)?.domain)
        .find((value): value is string => Boolean(value)) ??
      index.curriculum?.domains[0]?.id ??
      '';
    const domain = requestedDomain === 'all' ? '' : (requestedDomain ?? currentWeekDomain);
    const concepts = domain
      ? index.concepts.filter((concept) => concept.domain === domain)
      : index.concepts;
    const records = await withRepo(context).masteryRecords();
    const byKey = new Map(
      records.map((record) => [`${record.conceptId}:${record.dimension}`, record]),
    );
    const nodes = concepts.map((concept) => {
      const dimensions = Object.fromEntries(
        concept.dimensions.map((dimension) => [
          dimension,
          byKey.get(`${concept.id}:${dimension}`) ?? initialMastery(concept.id, dimension),
        ]),
      );
      const prereqs = concept.prereqs.filter((prereq) => prereq.strength === 'hard');
      const available = prereqs.every((prereq) =>
        index.conceptsById.get(prereq.id)?.dimensions.some((dimension) => {
          const record = byKey.get(`${prereq.id}:${dimension}`);
          return (
            record?.inferred ||
            masteryRank(record?.state ?? 'not_assessed') >= masteryRank('assisted')
          );
        }),
      );
      return { ...serializeConcept(concept), dimensions, available };
    });
    return context.json({
      nodes,
      edges: index.edges.filter((edge) =>
        concepts.some((concept) => concept.id === edge.conceptId),
      ),
      domains: (index.curriculum?.domains ?? []).map(({ id, title }) => ({ id, title })),
      currentWeekDomain,
    });
  });

  api.get('/concepts/:id', async (context) => {
    const index = await content();
    const concept = index.conceptsById.get(context.req.param('id'));
    if (!concept) {
      return context.json({ error: 'Concept not found' }, 404);
    }
    const repo = withRepo(context);
    const debt = deriveLearningDebt({
      mastery: await repo.masteryRecords(),
      events: (await repo.events(concept.id)).map((event) => ({
        conceptId: event.conceptId,
        dimension: event.dimension as MasteryRecord['dimension'],
        fromState: event.fromState,
        toState: event.toState,
        rule: event.rule,
        createdAt: event.createdAt.toISOString(),
      })),
      attempts: (await repo.recentAttempts()).map((attempt) => ({
        conceptId: attempt.conceptId,
        dimension: attempt.dimension as MasteryRecord['dimension'],
        correct: attempt.correct,
        hintsUsed: attempt.hintsUsed,
      })),
      remediationFlags: (await repo.openFlags()).map((flag) => ({
        conceptId: flag.conceptId,
        targetPrereqId: flag.targetPrereqId ?? undefined,
      })),
    });
    return context.json({
      concept: serializeConcept(concept),
      mastery: (await repo.masteryRecords()).filter((record) => record.conceptId === concept.id),
      events: await repo.events(concept.id),
      debt: debt.filter((entry) => entry.conceptId === concept.id),
    });
  });

  api.get('/settings', async (context) => {
    const user = await withRepo(context).user();
    return context.json({
      scheduleMinutes: 60,
      startDate: user?.startDate ?? '',
      ...(user?.prefs as object),
    });
  });

  api.put('/settings', async (context) => {
    const body = z
      .object({
        scheduleMinutes: z.number().int().min(5).max(600),
        startDate: z.string().min(1),
        goal: z.string().optional(),
      })
      .safeParse(await context.req.json().catch(() => ({})));
    if (!body.success) {
      return context.json({ error: 'Invalid settings' }, 400);
    }
    const [updated] = await db
      .update(users)
      .set({ startDate: body.data.startDate, prefs: body.data })
      .where(eq(users.id, context.get('userId')))
      .returning();
    return context.json(updated);
  });

  api.get('/progress', async (context) => {
    const records = await withRepo(context).masteryRecords();
    const attempts = await withRepo(context).recentAttempts(500);
    return context.json({
      mastery: records,
      attempts: attempts.length,
      correct: attempts.filter((attempt) => attempt.correct >= 1).length,
    });
  });

  api.get('/plan/week', async (context) => {
    const index = await content();
    const state = await withRepo(context).schedulerState(requestNow(context));
    return context.json({ weeks: index.curriculum?.weeks ?? [], mastery: state.mastery });
  });

  return api;
}

async function applyMastery(input: {
  repo: LearnerRepository;
  userId: string;
  exercise: IndexedExercise;
  attemptId: string;
  correct: number;
  credit: number;
  hintsUsed: number;
  attemptNo: number;
  mode: LearningMode;
  gradedBy: 'deterministic' | 'llm' | 'self';
  now: Date;
}) {
  const previous = await input.repo.masteryRecord(input.exercise.concept, input.exercise.dimension);
  const open = await input.repo.openFlags();
  const model = new DefaultMasteryModel();
  const result = model.applyAttempt(
    previous,
    {
      conceptId: input.exercise.concept,
      dimension: input.exercise.dimension,
      attemptId: input.attemptId,
      exerciseId: input.exercise.id,
      correct: input.correct,
      hintsUsed: input.hintsUsed,
      attemptNo: input.attemptNo,
      mode: input.mode,
      itemRole: input.exercise.role,
      gradedBy: input.gradedBy,
    },
    input.now,
    { remediationOpen: open.some((flag) => flag.conceptId === input.exercise.concept) },
  );
  await input.repo.saveMastery(result.mastery);
  if (result.event) {
    await input.repo.db.insert(masteryEvents).values({
      userId: input.userId,
      conceptId: result.event.conceptId,
      dimension: result.event.dimension,
      fromState: result.event.fromState,
      toState: result.event.toState,
      rule: result.event.rule,
      attemptId: result.event.attemptId,
      createdAt: input.now,
    });
  }
  if (
    result.remediationFlagOpen &&
    !open.some((flag) => flag.conceptId === input.exercise.concept)
  ) {
    await input.repo.db.insert(remediationFlags).values({
      userId: input.userId,
      conceptId: input.exercise.concept,
      status: 'open',
      openedByAttemptId: input.attemptId,
      createdAt: input.now,
    });
  }
  if (masteryRank(result.mastery.state) >= masteryRank('assisted')) {
    const existingCard = await input.repo.db
      .select()
      .from(reviewCards)
      .where(
        and(
          eq(reviewCards.userId, input.userId),
          eq(reviewCards.conceptId, input.exercise.concept),
          eq(reviewCards.dimension, input.exercise.dimension),
        ),
      )
      .limit(1);
    if (!existingCard[0]) {
      const card = newReviewCard(input.now);
      const rating = mapReviewRating({
        correct: input.correct,
        hintsUsed: input.hintsUsed,
        attemptNo: input.attemptNo,
      });
      const timezone = (await input.repo.user())?.timezone ?? 'UTC';
      const scheduled = scheduleInitialReview(
        card,
        input.now,
        rating,
        timezone,
        process.env.NODE_ENV !== 'test',
      );
      await input.repo.db.insert(reviewCards).values({
        userId: input.userId,
        conceptId: input.exercise.concept,
        dimension: input.exercise.dimension,
        fsrs: scheduled.card,
        dueAt: scheduled.card.due,
        lastReviewAt: input.now,
        reps: scheduled.card.reps,
        lapses: scheduled.card.lapses,
      });
    }
  }
  return { mastery: result.mastery, event: result.event, credit: result.credit };
}

function requestNow(context: { req: { header(name: string): string | undefined } }): Date {
  if (process.env.NODE_ENV === 'test') {
    const override = context.req.header('X-Now') ?? process.env.NOW_OVERRIDE;
    if (override) {
      const parsed = new Date(override);
      if (Number.isFinite(parsed.getTime())) {
        return parsed;
      }
    }
  }
  return new Date();
}

async function hintsSincePreviousAttempt(
  db: Database,
  userId: string,
  exerciseId: string,
  activityId?: string,
): Promise<number> {
  const scope = activityId ? eq(attempts.activityId, activityId) : sql`true`;
  const hintScope = activityId ? eq(hintEvents.activityId, activityId) : sql`true`;
  const [attemptRows, hintRows] = await Promise.all([
    db
      .select({
        userId: attempts.userId,
        exerciseId: attempts.exerciseId,
        activityId: attempts.activityId,
        createdAt: attempts.createdAt,
      })
      .from(attempts)
      .where(and(eq(attempts.userId, userId), eq(attempts.exerciseId, exerciseId), scope)),
    db
      .select({
        userId: hintEvents.userId,
        exerciseId: hintEvents.exerciseId,
        activityId: hintEvents.activityId,
        createdAt: hintEvents.createdAt,
      })
      .from(hintEvents)
      .where(and(eq(hintEvents.userId, userId), eq(hintEvents.exerciseId, exerciseId), hintScope)),
  ]);
  return countHintsSincePreviousAttempt({
    userId,
    exerciseId,
    activityId,
    attempts: attemptRows,
    hints: hintRows,
  });
}
