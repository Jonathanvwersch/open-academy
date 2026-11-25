import { serializeExercise } from '@academy/aesop/course/serialize';
import type { ContentIndex } from '@academy/aesop/course/types';
import { gradeExercise } from '@academy/aesop/lessons/grading/index';
import { newReviewCard, scheduleReview } from '@academy/aesop/memory/fsrs';
import { applyImplicitRepetitions } from '@academy/aesop/memory/mastery-service';
import { buildReviewActivityForConcept } from '@academy/aesop/planner/scheduler';
import { localDateKey } from '@academy/aesop/progress/xp';
import {
  type QuizQuestion,
  quizAnswerIsLate,
  quizDurationMs,
  quizItemOutcome,
  quizPlannedMinutes,
  quizRetakeEligible,
  quizScore,
  quizSeed,
  quizTargetSeconds,
  quizXp,
} from '@academy/aesop/quizzes/mixed-quiz';
import type { LearnerStore } from '@academy/aesop/store/learner-store';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { Rating } from 'ts-fsrs';
import { z } from 'zod';
import type { Database } from '../../db/client.js';
import { drizzleLearnerStore } from '../../db/learner-store.js';
import { LearnerRepository } from '../../db/repository.js';
import {
  quizItems,
  quizRuns,
  sessionActivities,
  studySessions,
  users,
  xpEvents,
} from '../../db/schema.js';
import { updateActivityAndAdvance } from '../../learning/activity-completion.js';
import { fsrsFuzzEnabled } from '../../learning/fsrs-fuzz.js';
import { type FeatureRequest, type FeatureServices, serviceResult } from '../../service-context.js';
import { type QuizRun, quizAccommodation, quizOffer } from './offer.js';

type QuizItem = typeof quizItems.$inferSelect;

function withQuizLock<T>(
  request: FeatureRequest,
  work: (repo: LearnerRepository) => Promise<T>,
): Promise<T> {
  return request.repo.db.transaction(async (tx) => {
    await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, request.userId))
      .for('no key update');
    return work(new LearnerRepository(tx as unknown as Database, request.userId));
  });
}

async function runFor(repo: LearnerRepository, id: string) {
  if (!z.uuid().safeParse(id).success) return undefined;
  const [run] = await repo.db
    .select()
    .from(quizRuns)
    .where(and(eq(quizRuns.id, id), eq(quizRuns.userId, repo.userId)));
  return run;
}

function itemsFor(repo: LearnerRepository, run: QuizRun) {
  return repo.db
    .select()
    .from(quizItems)
    .where(eq(quizItems.runId, run.id))
    .orderBy(asc(quizItems.position));
}

async function retakeStatus(repo: LearnerRepository, run: QuizRun, items: QuizItem[]) {
  const [retake] = await repo.db
    .select({ id: quizRuns.id })
    .from(quizRuns)
    .where(eq(quizRuns.retakeOf, run.id));
  const eligible =
    run.retakeOf === null &&
    quizRetakeEligible(
      items.map((item) => ({
        correct: item.correct === true,
        followUp: item.followUp,
        reviewed: item.followUpActivityId !== null,
      })),
      Boolean(retake),
    );
  return { eligible, id: retake?.id };
}

async function quizPayload(
  repo: LearnerRepository,
  run: QuizRun,
  content: ContentIndex,
  now: Date,
) {
  const items = await itemsFor(repo, run);
  const [activity] =
    run.finalizedAt && run.activityId
      ? await repo.db
          .select({ sessionId: sessionActivities.sessionId })
          .from(sessionActivities)
          .where(eq(sessionActivities.id, run.activityId))
      : [];
  const next = items.find((item) => !item.answeredAt);
  const exercise = next && serializeExercise(next.question.exercise, repo.userId);
  return {
    id: run.id,
    sessionId: activity?.sessionId,
    startedAt: run.startedAt.toISOString(),
    deadline: run.deadline.toISOString(),
    serverNow: now.toISOString(),
    totalItems: items.length,
    expired: quizAnswerIsLate(now, run.deadline),
    retake: run.retakeOf !== null,
    question:
      !run.finalizedAt && next && exercise && !quizAnswerIsLate(now, run.deadline)
        ? {
            position: next.position,
            exercise: {
              id: next.question.exercise.id,
              type: next.question.exercise.type,
              concept: next.conceptId,
              prompt: next.question.exercise.prompt,
              multi: exercise.multi,
              options: exercise.options,
            },
          }
        : null,
    result: run.finalizedAt && {
      score: run.score,
      xpAwarded: run.xpAwarded,
      topics: items
        .filter((item) => item.followUp)
        .map((item) => ({
          conceptId: item.conceptId,
          title: content.conceptsById.get(item.conceptId)?.title ?? item.conceptId,
          missed: item.correct !== true,
          reviewed: item.followUpActivityId !== null,
        })),
      retake: await retakeStatus(repo, run, items),
    },
  };
}

async function insertQuiz(
  repo: LearnerRepository,
  input: {
    now: Date;
    seed: number;
    difficulty: number;
    accommodation: number;
    questions: Array<{ question: QuizQuestion; reserve?: QuizQuestion }>;
    activityId?: string;
    retakeOf?: string;
  },
) {
  const questions = input.questions.map(({ question }) => question);
  const [run] = await repo.db
    .insert(quizRuns)
    .values({
      userId: repo.userId,
      seed: input.seed,
      difficulty: input.difficulty,
      startedAt: input.now,
      deadline: new Date(input.now.getTime() + quizDurationMs(questions, input.accommodation)),
      plannedMinutes: quizPlannedMinutes(questions, input.accommodation),
      activityId: input.activityId,
      retakeOf: input.retakeOf,
    })
    .returning();
  await repo.db.insert(quizItems).values(
    input.questions.map(({ question, reserve }, position) => ({
      runId: run.id,
      position,
      conceptId: question.exercise.concept,
      question,
      reserve,
    })),
  );
  return run;
}

export async function startQuiz(deps: FeatureServices, request: FeatureRequest) {
  const body = z.object({ sessionId: z.uuid(), activityId: z.uuid() }).safeParse(request.body);
  if (!body.success) return serviceResult({ error: 'Invalid quiz activity' }, 400);
  const now = request.now();
  const content = await deps.content();
  return withQuizLock(request, async (repo) => {
    const session = await repo.session(body.data.sessionId);
    const activity = session?.activities.find(
      (row) => row.id === body.data.activityId && row.kind === 'mixed_quiz',
    );
    if (!session || !activity) return serviceResult({ error: 'Quiz activity not found' }, 404);
    const [previous] = await repo.db
      .select()
      .from(quizRuns)
      .where(eq(quizRuns.activityId, activity.id));
    if (previous) return serviceResult(await quizPayload(repo, previous, content, now));
    if (session.status !== 'active' || activity.status !== 'in_progress') {
      return serviceResult({ error: 'This quiz is not the current activity' }, 409);
    }
    const offer = await quizOffer(repo, content, now, await repo.activeCourseId());
    if (offer.active) {
      const [active] = await repo.db
        .update(quizRuns)
        .set({ activityId: activity.id })
        .where(eq(quizRuns.id, offer.active.id))
        .returning();
      return serviceResult(await quizPayload(repo, active, content, now));
    }
    if (!offer.selection || (offer.plannedMinutes ?? Infinity) > activity.plannedMinutes) {
      return serviceResult({ error: 'This quiz is not available' }, 409);
    }
    const run = await insertQuiz(repo, {
      ...offer.selection,
      activityId: activity.id,
      now,
    });
    return serviceResult(await quizPayload(repo, run, content, now), 201);
  });
}

export async function getQuiz(deps: FeatureServices, request: FeatureRequest) {
  const run = await runFor(request.repo, request.params.id);
  if (!run) return serviceResult({ error: 'Quiz not found' }, 404);
  return serviceResult(await quizPayload(request.repo, run, await deps.content(), request.now()));
}

export async function answerQuiz(deps: FeatureServices, request: FeatureRequest) {
  const body = z
    .object({ position: z.number().int().nonnegative(), answer: z.unknown() })
    .safeParse(request.body);
  if (!body.success) return serviceResult({ error: 'Invalid quiz answer' }, 400);
  const now = request.now();
  const content = await deps.content();
  return withQuizLock(request, async (repo) => {
    const run = await runFor(repo, request.params.id);
    if (!run) return serviceResult({ error: 'Quiz not found' }, 404);
    if (run.finalizedAt || quizAnswerIsLate(now, run.deadline)) {
      return serviceResult({ error: 'This quiz has ended' }, 409);
    }
    const items = await itemsFor(repo, run);
    const current = items.find((item) => !item.answeredAt);
    if (!current || current.position !== body.data.position) {
      return serviceResult({ error: 'This is not the current quiz question' }, 409);
    }
    const grade = await gradeExercise(current.question.exercise, body.data.answer);
    if (grade.status !== 'graded') return serviceResult({ error: grade.feedback }, 422);
    const shownAt = items[current.position - 1]?.answeredAt ?? run.startedAt;
    await repo.db
      .update(quizItems)
      .set({
        answeredAt: now,
        latencyMs: Math.max(0, now.getTime() - shownAt.getTime()),
        correct: grade.correct >= 1,
      })
      .where(and(eq(quizItems.runId, run.id), eq(quizItems.position, current.position)));
    return serviceResult(await quizPayload(repo, run, content, now));
  });
}

async function applyQuizReview(
  store: LearnerStore,
  learnerId: string,
  exercise: QuizQuestion['exercise'],
  outcome: ReturnType<typeof quizItemOutcome>,
  now: Date,
  timeZone: string,
) {
  return store.recordReview(learnerId, exercise.concept, exercise.dimension, (current) => {
    const scheduled = scheduleReview(
      current?.fsrs ?? newReviewCard(now),
      now,
      outcome.rating,
      timeZone,
      fsrsFuzzEnabled(),
    );
    const dueAt = outcome.followUp ? now : scheduled.card.due;
    return {
      card: {
        fsrs: { ...scheduled.card, due: dueAt },
        dueAt,
        lastReviewAt: now,
        reps: scheduled.card.reps,
        lapses: scheduled.card.lapses,
      },
      log: {
        rating: outcome.rating,
        fsrsLog: { ...scheduled.log, source: 'mixed_quiz' },
        createdAt: now,
      },
    };
  });
}

export async function finalizeQuiz(deps: FeatureServices, request: FeatureRequest) {
  const now = request.now();
  const content = await deps.content();
  return withQuizLock(request, async (repo) => {
    const run = await runFor(repo, request.params.id);
    if (!run) return serviceResult({ error: 'Quiz not found' }, 404);
    if (run.finalizedAt) return serviceResult(await quizPayload(repo, run, content, now));
    const items = await itemsFor(repo, run);
    if (!quizAnswerIsLate(now, run.deadline) && items.some((item) => !item.answeredAt)) {
      return serviceResult({ error: 'Answer the remaining quiz questions' }, 409);
    }
    const outcomes = items.map((item) =>
      quizItemOutcome(
        item.correct === true,
        item.latencyMs,
        quizTargetSeconds(item.question.exercise),
      ),
    );
    const store = drizzleLearnerStore(repo.db, { activeReviewCardsOnly: true });
    for (const [i, item] of items.entries()) {
      const outcome = outcomes[i];
      await repo.db
        .update(quizItems)
        .set({ correct: outcome.correct, followUp: outcome.followUp })
        .where(and(eq(quizItems.runId, run.id), eq(quizItems.position, item.position)));
      const reviewed = await applyQuizReview(
        store,
        repo.userId,
        item.question.exercise,
        outcome,
        now,
        request.timeZone,
      );
      if (reviewed && outcome.rating === Rating.Good) {
        await applyImplicitRepetitions(store, {
          learnerId: repo.userId,
          conceptId: item.conceptId,
          rating: outcome.rating,
          index: content,
          now,
          timeZone: request.timeZone,
          enableFuzz: fsrsFuzzEnabled(),
        });
      }
    }
    const score = quizScore(outcomes);
    const xpAwarded = quizXp(run.plannedMinutes, score, run.retakeOf !== null);
    if (run.retakeOf === null) {
      await repo.db
        .insert(xpEvents)
        .values({
          userId: repo.userId,
          kind: 'mixed_quiz',
          sourceKey: `mixed-quiz:${run.id}`,
          amount: xpAwarded,
          earnedAt: now,
          localDate: localDateKey(now, request.timeZone),
        })
        .onConflictDoNothing();
    }
    if (run.activityId) {
      const [activity] = await repo.db
        .select()
        .from(sessionActivities)
        .where(eq(sessionActivities.id, run.activityId));
      if (activity) {
        const session = await repo.session(activity.sessionId);
        await updateActivityAndAdvance(repo.db, {
          activityId: activity.id,
          completed: true,
          now,
          session: session?.status === 'active' ? session : undefined,
        });
      }
    }
    const [finished] = await repo.db
      .update(quizRuns)
      .set({ finalizedAt: now, score, xpAwarded })
      .where(eq(quizRuns.id, run.id))
      .returning();
    return serviceResult(await quizPayload(repo, finished, content, now));
  });
}

export async function startQuizRetake(deps: FeatureServices, request: FeatureRequest) {
  const now = request.now();
  const content = await deps.content();
  return withQuizLock(request, async (repo) => {
    const original = await runFor(repo, request.params.id);
    if (!original?.finalizedAt) return serviceResult({ error: 'Quiz result not found' }, 404);
    const items = await itemsFor(repo, original);
    const status = await retakeStatus(repo, original, items);
    if (status.id) {
      const existing = await runFor(repo, status.id);
      if (existing) return serviceResult(await quizPayload(repo, existing, content, now));
    }
    if (!status.eligible)
      return serviceResult({ error: 'Complete the follow-up reviews first' }, 409);
    const [active] = await repo.db
      .select({ id: quizRuns.id })
      .from(quizRuns)
      .where(and(eq(quizRuns.userId, repo.userId), isNull(quizRuns.finalizedAt)));
    if (active) return serviceResult({ error: 'Finish the current quiz first' }, 409);
    const questions = items.flatMap((item) => (item.reserve ? [{ question: item.reserve }] : []));
    if (questions.length !== items.length) {
      return serviceResult({ error: 'Fresh retake questions are not available' }, 409);
    }
    const user = await repo.user();
    const run = await insertQuiz(repo, {
      questions,
      now,
      seed: quizSeed(original.seed, 'retake') & 0x7fffffff,
      difficulty: original.difficulty,
      retakeOf: original.id,
      accommodation: quizAccommodation(user?.prefs),
    });
    return serviceResult(await quizPayload(repo, run, content, now), 201);
  });
}

export async function startQuizFollowUps(deps: FeatureServices, request: FeatureRequest) {
  const now = request.now();
  const content = await deps.content();
  return withQuizLock(request, async (repo) => {
    const { db, userId } = repo;
    const run = await runFor(repo, request.params.id);
    if (!run?.finalizedAt) return serviceResult({ error: 'Quiz result not found' }, 404);
    const items = (await itemsFor(repo, run)).filter(
      (item) => item.followUp && !item.followUpActivityId,
    );
    if (!items.length) return serviceResult({ error: 'No follow-up reviews remain' }, 409);
    const [active] = await db
      .select({ id: studySessions.id })
      .from(studySessions)
      .where(
        and(
          eq(studySessions.userId, userId),
          eq(studySessions.status, 'active'),
          sql`${studySessions.plan}->>'quizFollowUp' = ${run.id}`,
        ),
      );
    if (active) return serviceResult({ sessionId: active.id });

    const state = await repo.schedulerState(now, content);
    const activities = items.flatMap(({ conceptId, question }) => {
      const cards = state.cards.filter((card) => card.conceptId === conceptId);
      if (!cards.some((card) => card.dimension === question.exercise.dimension)) return [];
      const activity = buildReviewActivityForConcept(
        { ...state, focusSubjectId: undefined, reviewedTodayConceptIds: [] },
        content,
        now,
        conceptId,
        cards.map((card) => ({ ...card, dueAt: now.toISOString() })),
      );
      return activity ? [activity] : [];
    });
    if (!activities.length)
      return serviceResult({ error: 'No follow-up questions are available' }, 409);
    const [session] = await db
      .insert(studySessions)
      .values({
        userId,
        kind: 'custom',
        startedAt: now,
        status: 'active',
        plannedMinutes: activities.reduce((total, activity) => total + activity.plannedMinutes, 0),
        plan: { quizFollowUp: run.id },
      })
      .returning();
    await db.insert(sessionActivities).values(
      activities.map((activity, idx): typeof sessionActivities.$inferInsert => ({
        sessionId: session.id,
        idx,
        kind: activity.kind,
        conceptId: activity.conceptId,
        exerciseIds: activity.exerciseIds,
        plannedMinutes: activity.plannedMinutes,
        reason: activity.reason,
        status: idx === 0 ? 'in_progress' : 'planned',
        startedAt: idx === 0 ? now : null,
      })),
    );
    return serviceResult({ sessionId: session.id }, 201);
  });
}
