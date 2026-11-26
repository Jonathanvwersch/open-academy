import { emptyAnswerMessage } from '@academy/shared/answer-validation';
import { Rating } from 'ts-fsrs';
import { serializeExercise } from '../course/serialize.js';
import { studyCourseIds } from '../course/study-set.js';
import type { ContentIndex } from '../course/types.js';
import { gradeExercise } from '../lessons/grading/index.js';
import { newReviewCard, scheduleReviewWithDetails } from '../memory/fsrs.js';
import { calculateCredit } from '../memory/mastery.js';
import { applyImplicitRepetitions, getTopicSpeed } from '../memory/mastery-service.js';
import { updateActivityAndAdvance } from '../planner/activity-advance.js';
import { loadSchedulerState } from '../planner/load-scheduler-state.js';
import { buildReviewActivityForConcept } from '../planner/scheduler.js';
import { localDateKey } from '../progress/xp.js';
import type { FlowStore, TimedQuizItem, TimedQuizRun } from '../store/flow-store.js';
import type { LearnerStore } from '../store/learner-store.js';
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
  topicQuestions,
} from './mixed-quiz.js';
import { quizAccommodation, quizOffer, quizQuestionHistory } from './quiz-offer.js';

type QuizContext = {
  learnerId: string;
  timeZone: string;
  now: Date;
  content: ContentIndex;
  random: () => number;
  newId: () => string;
  enableFsrsFuzz: boolean;
};

function withQuizLock<T>(store: FlowStore, learnerId: string, work: (tx: FlowStore) => Promise<T>) {
  return store.transaction(async (tx) => {
    await tx.lockLearner(learnerId, 'no_key_update');
    return work(tx);
  });
}

async function runFor(store: FlowStore, learnerId: string, id: string | undefined) {
  if (id === undefined) return undefined;
  const [run] = await store.listTimedQuizRuns(learnerId, { id });
  return run;
}

async function sessionFor(store: FlowStore, learnerId: string, id: string) {
  const [session] = await store.listSessions(learnerId, { ids: [id] });
  if (!session) return undefined;
  return { ...session, activities: await store.listActivities(learnerId, { sessionIds: [id] }) };
}

async function currentQuizItems(
  store: FlowStore,
  learnerId: string,
  run: TimedQuizRun,
  content: ContentIndex,
  now: Date,
) {
  const items = await store.listTimedQuizItems(learnerId, [run.id]);
  if (run.finalizedAt) return items;
  const removed = items.filter(
    ({ question, answeredAt }) =>
      !answeredAt && !question.withdrawn && !content.exercisesById.has(question.exercise.id),
  );
  if (!removed.length) return items;
  const expired = quizAnswerIsLate(now, run.deadline);
  const usedKeys = expired
    ? new Set<string>()
    : (await quizQuestionHistory(store, learnerId)).usedKeys;
  for (const { reserve } of items) if (reserve) usedKeys.add(reserve.key);
  for (const item of removed) {
    const [replacement] = expired
      ? []
      : topicQuestions({
          content,
          topic: item.conceptId,
          difficulty: run.difficulty,
          seed: run.seed,
          count: 1,
          usedKeys,
        });
    if (replacement) {
      usedKeys.add(replacement.key);
      item.question = {
        ...replacement,
        previousKeys: [...(item.question.previousKeys ?? []), item.question.key],
      };
    } else {
      item.question = { ...item.question, withdrawn: true };
    }
    await store.patchTimedQuizItem(learnerId, run.id, item.position, { question: item.question });
  }
  return items;
}

async function retakeStatus(
  store: FlowStore,
  learnerId: string,
  run: TimedQuizRun,
  items: TimedQuizItem[],
) {
  const [retake] = await store.listTimedQuizRuns(learnerId, { retakeOf: run.id });
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
  store: FlowStore,
  learnerId: string,
  run: TimedQuizRun,
  content: ContentIndex,
  now: Date,
) {
  const items = (await currentQuizItems(store, learnerId, run, content, now)).filter(
    ({ question }) => !question.withdrawn,
  );
  const [activity] =
    run.finalizedAt && run.activityId
      ? await store.listActivities(learnerId, { ids: [run.activityId] })
      : [];
  const next = items.find((item) => !item.answeredAt);
  const exercise = next && serializeExercise(next.question.exercise, learnerId);
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
            number: items.indexOf(next) + 1,
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
      retake: await retakeStatus(store, learnerId, run, items),
    },
  };
}

function insertQuiz(
  store: FlowStore,
  learnerId: string,
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
  return store.insertTimedQuiz(
    learnerId,
    {
      seed: input.seed,
      difficulty: input.difficulty,
      startedAt: input.now,
      deadline: new Date(input.now.getTime() + quizDurationMs(questions, input.accommodation)),
      plannedMinutes: quizPlannedMinutes(questions, input.accommodation),
      activityId: input.activityId ?? null,
      retakeOf: input.retakeOf ?? null,
      finalizedAt: null,
      score: null,
      xpAwarded: null,
    },
    input.questions.map(({ question, reserve }, position) => ({
      position,
      conceptId: question.exercise.concept,
      question,
      reserve: reserve ?? null,
      answeredAt: null,
      latencyMs: null,
      correct: null,
      submission: null,
      followUp: false,
      followUpActivityId: null,
    })),
  );
}

function rejected(kind: 'not_found' | 'conflict' | 'invalid', error: string) {
  return { kind, error };
}

function ok<T>(body: T) {
  return { kind: 'ok' as const, body };
}

function created<T>(body: T) {
  return { kind: 'created' as const, body };
}

export function startQuiz(
  store: FlowStore,
  context: QuizContext,
  input: { sessionId: string; activityId: string },
) {
  const { learnerId, content, now } = context;
  return withQuizLock(store, learnerId, async (tx) => {
    const session = await sessionFor(tx, learnerId, input.sessionId);
    const activity = session?.activities.find(
      (row) => row.id === input.activityId && row.kind === 'mixed_quiz',
    );
    if (!session || !activity) return rejected('not_found', 'Quiz activity not found');
    const [previous] = await tx.listTimedQuizRuns(learnerId, { activityId: activity.id });
    if (previous) return ok(await quizPayload(tx, learnerId, previous, content, now));
    if (session.status !== 'active' || activity.status !== 'in_progress') {
      return rejected('conflict', 'This quiz is not the current activity');
    }
    const settings = await tx.getSettings(learnerId);
    const offer = await quizOffer(
      tx,
      learnerId,
      content,
      now,
      settings?.activeCourseId ?? null,
      settings ?? null,
    );
    if (offer.active) {
      const active = await tx.patchTimedQuizRun(learnerId, offer.active.id, {
        activityId: activity.id,
      });
      return ok(await quizPayload(tx, learnerId, active, content, now));
    }
    if (!offer.selection || (offer.plannedMinutes ?? Infinity) > activity.plannedMinutes) {
      return rejected('conflict', 'This quiz is not available');
    }
    const run = await insertQuiz(tx, learnerId, {
      ...offer.selection,
      activityId: activity.id,
      now,
    });
    return created(await quizPayload(tx, learnerId, run, content, now));
  });
}

export async function getQuiz(
  store: FlowStore,
  learnerId: string,
  id: string | undefined,
  content: () => Promise<ContentIndex>,
  now: () => Date,
) {
  const index = await content();
  return withQuizLock(store, learnerId, async (tx) => {
    const run = await runFor(tx, learnerId, id);
    if (!run) return rejected('not_found', 'Quiz not found');
    return ok(await quizPayload(tx, learnerId, run, index, now()));
  });
}

export function answerQuiz(
  store: FlowStore,
  context: QuizContext,
  id: string | undefined,
  input: { position: number; questionId: string; answer: unknown },
) {
  const { learnerId, content, now, random } = context;
  return withQuizLock(store, learnerId, async (tx) => {
    const run = await runFor(tx, learnerId, id);
    if (!run) return rejected('not_found', 'Quiz not found');
    if (run.finalizedAt || quizAnswerIsLate(now, run.deadline)) {
      return rejected('conflict', 'This quiz has ended');
    }
    const storedItems = await currentQuizItems(tx, learnerId, run, content, now);
    const requested = storedItems.find(({ position }) => position === input.position);
    if (
      requested &&
      (requested.question.withdrawn || requested.question.exercise.id !== input.questionId)
    ) {
      return rejected('conflict', 'Question changed. Answer the current question.');
    }
    const items = storedItems.filter(({ question }) => !question.withdrawn);
    const current = items.find((item) => !item.answeredAt);
    if (!current || current.position !== input.position) {
      return rejected('conflict', 'This is not the current quiz question');
    }
    const emptyMessage = emptyAnswerMessage(current.question.exercise.type, input.answer);
    if (emptyMessage) return rejected('invalid', emptyMessage);
    const grade = await gradeExercise(current.question.exercise, input.answer, { random });
    if (grade.status !== 'graded') return rejected('invalid', grade.feedback);
    const shownAt = items[items.indexOf(current) - 1]?.answeredAt ?? run.startedAt;
    await tx.patchTimedQuizItem(learnerId, run.id, current.position, {
      answeredAt: now,
      latencyMs: Math.max(0, now.getTime() - shownAt.getTime()),
      correct: grade.correct >= 1,
      submission: {
        answer: input.answer,
        correct: grade.correct,
        gradedBy: grade.graded_by ?? 'deterministic',
      },
    });
    return ok(await quizPayload(tx, learnerId, run, content, now));
  });
}

async function applyQuizReview(
  store: LearnerStore,
  context: QuizContext,
  exercise: QuizQuestion['exercise'],
  outcome: ReturnType<typeof quizItemOutcome>,
  attemptId: string | undefined,
) {
  const { learnerId, now, timeZone, enableFsrsFuzz } = context;
  const speed = await getTopicSpeed(store, learnerId, exercise.concept);
  return store.recordReview(learnerId, exercise.concept, exercise.dimension, (current) => {
    const scheduled = scheduleReviewWithDetails(
      current?.fsrs ?? newReviewCard(now),
      now,
      outcome.rating,
      timeZone,
      enableFsrsFuzz,
      outcome.followUp ? 1 : speed,
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
        fsrsLog: { ...scheduled.log, source: 'mixed_quiz', effectiveDueAt: dueAt },
        attemptId,
        speed,
        rawDueAt: scheduled.rawDueAt,
        createdAt: now,
      },
    };
  });
}

export function finalizeQuiz(store: FlowStore, context: QuizContext, id: string | undefined) {
  const { learnerId, content, now, timeZone, newId, enableFsrsFuzz } = context;
  return withQuizLock(store, learnerId, async (tx) => {
    const run = await runFor(tx, learnerId, id);
    if (!run) return rejected('not_found', 'Quiz not found');
    if (run.finalizedAt) return ok(await quizPayload(tx, learnerId, run, content, now));
    const items = (await currentQuizItems(tx, learnerId, run, content, now)).filter(
      ({ question }) => !question.withdrawn,
    );
    if (!quizAnswerIsLate(now, run.deadline) && items.some((item) => !item.answeredAt)) {
      return rejected('conflict', 'Answer the remaining quiz questions');
    }
    const outcomes = items.map((item) =>
      quizItemOutcome(
        item.correct === true,
        item.latencyMs,
        quizTargetSeconds(item.question.exercise),
      ),
    );
    const attemptIds = new Map<number, string>();
    for (const item of items) {
      if (!item.answeredAt || !item.submission) continue;
      const { exercise } = item.question;
      const { answer, correct, gradedBy } = item.submission;
      const attempt = await tx.insertAttempt(learnerId, {
        id: newId(),
        activityId: run.activityId,
        sessionId: null,
        exerciseId: exercise.id,
        exerciseVersion: exercise.contentVersion,
        conceptId: item.conceptId,
        dimension: exercise.dimension,
        mode: 'assessment',
        answer,
        correct,
        credit: calculateCredit({ correct, gradedBy, hintsUsed: 0, attemptNo: 1 }),
        gradedBy,
        hintsUsed: 0,
        attemptNo: 1,
        feedback: {},
        mistakeCategory: null,
        durationMs: item.latencyMs,
        createdAt: now,
      });
      attemptIds.set(item.position, attempt.id);
      if (gradedBy === 'deterministic') {
        await tx.addTopicSpeedAnswer(learnerId, item.conceptId, correct >= 1, now);
      }
    }
    for (const [i, item] of items.entries()) {
      const outcome = outcomes[i];
      await tx.patchTimedQuizItem(learnerId, run.id, item.position, {
        correct: outcome.correct,
        followUp: outcome.followUp,
      });
      const reviewed = await applyQuizReview(
        tx,
        context,
        item.question.exercise,
        outcome,
        attemptIds.get(item.position),
      );
      if (reviewed && outcome.rating === Rating.Good) {
        await applyImplicitRepetitions(tx, {
          learnerId,
          conceptId: item.conceptId,
          rating: outcome.rating,
          index: content,
          now,
          timeZone,
          enableFuzz: enableFsrsFuzz,
          activeOnly: true,
        });
      }
    }
    const score = quizScore(outcomes);
    const xpAwarded = quizXp(run.plannedMinutes, score, run.retakeOf !== null);
    if (run.retakeOf === null) {
      await tx.insertXpEventOnce(learnerId, {
        kind: 'mixed_quiz',
        sourceKey: `mixed-quiz:${run.id}`,
        conceptId: null,
        amount: xpAwarded,
        earnedAt: now,
        localDate: localDateKey(now, timeZone),
      });
    }
    if (run.activityId) {
      const [activity] = await tx.listActivities(learnerId, { ids: [run.activityId] });
      if (activity) {
        const session = await sessionFor(tx, learnerId, activity.sessionId);
        await updateActivityAndAdvance(tx, {
          userId: learnerId,
          activityId: activity.id,
          completed: true,
          now,
          session: session?.status === 'active' ? session : undefined,
        });
      }
    }
    const finished = await tx.patchTimedQuizRun(learnerId, run.id, {
      finalizedAt: now,
      score,
      xpAwarded,
    });
    return ok(await quizPayload(tx, learnerId, finished, content, now));
  });
}

export function startQuizRetake(store: FlowStore, context: QuizContext, id: string | undefined) {
  const { learnerId, content, now } = context;
  return withQuizLock(store, learnerId, async (tx) => {
    const original = await runFor(tx, learnerId, id);
    if (!original?.finalizedAt) return rejected('not_found', 'Quiz result not found');
    const items = (await tx.listTimedQuizItems(learnerId, [original.id])).filter(
      ({ question }) => !question.withdrawn,
    );
    const status = await retakeStatus(tx, learnerId, original, items);
    if (status.id) {
      const existing = await runFor(tx, learnerId, status.id);
      if (existing) return ok(await quizPayload(tx, learnerId, existing, content, now));
    }
    if (!status.eligible) return rejected('conflict', 'Complete the follow-up reviews first');
    const [active] = await tx.listTimedQuizRuns(learnerId, { active: true });
    if (active) return rejected('conflict', 'Finish the current quiz first');
    const seed = quizSeed(original.seed, 'retake') & 0x7fffffff;
    const history = await quizQuestionHistory(tx, learnerId);
    const seenKeys = new Set(
      history.items.flatMap(({ question }) => [question.key, ...(question.previousKeys ?? [])]),
    );
    for (const { reserve } of items) if (reserve) history.usedKeys.add(reserve.key);
    const questions: Array<{ question: QuizQuestion }> = [];
    for (const { reserve, conceptId } of items) {
      const [question] =
        reserve && content.exercisesById.has(reserve.exercise.id) && !seenKeys.has(reserve.key)
          ? [reserve]
          : topicQuestions({
              content,
              topic: conceptId,
              difficulty: original.difficulty,
              seed,
              count: 1,
              usedKeys: history.usedKeys,
            });
      if (!question) continue;
      seenKeys.add(question.key);
      history.usedKeys.add(question.key);
      questions.push({ question });
    }
    if (questions.length === 0) {
      return rejected('conflict', 'Fresh retake questions are not available');
    }
    const settings = await tx.getSettings(learnerId);
    const run = await insertQuiz(tx, learnerId, {
      questions,
      now,
      seed,
      difficulty: original.difficulty,
      retakeOf: original.id,
      accommodation: quizAccommodation(settings?.prefs),
    });
    return created(await quizPayload(tx, learnerId, run, content, now));
  });
}

export function startQuizFollowUps(store: FlowStore, context: QuizContext, id: string | undefined) {
  const { learnerId, content, now, enableFsrsFuzz } = context;
  return withQuizLock(store, learnerId, async (tx) => {
    const run = await runFor(tx, learnerId, id);
    if (!run?.finalizedAt) return rejected('not_found', 'Quiz result not found');
    const items = (await tx.listTimedQuizItems(learnerId, [run.id])).filter(
      (item) => item.followUp && !item.followUpActivityId,
    );
    if (!items.length) return rejected('conflict', 'No follow-up reviews remain');
    const active = (await tx.listSessions(learnerId, { status: 'active' })).find(
      (session) => (session.plan as { quizFollowUp?: unknown } | null)?.quizFollowUp === run.id,
    );
    if (active) return ok({ sessionId: active.id });

    const settings = await tx.getSettings(learnerId);
    const state = await loadSchedulerState(tx, learnerId, content, now, {
      settings: settings ?? null,
      studyCourseIds: studyCourseIds(tx, learnerId, content, () => now, settings),
      enableFsrsFuzz,
    });
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
    if (!activities.length) return rejected('conflict', 'No follow-up questions are available');
    const session = await tx.insertSession(learnerId, {
      kind: 'custom',
      startedAt: now,
      endedAt: null,
      status: 'active',
      plannedMinutes: activities.reduce((total, activity) => total + activity.plannedMinutes, 0),
      plan: { quizFollowUp: run.id },
      activeSeconds: 0,
    });
    await tx.insertActivities(
      learnerId,
      session.id,
      activities.map((activity, idx) => ({
        idx,
        kind: activity.kind,
        conceptId: activity.conceptId ?? null,
        projectId: null,
        exerciseIds: activity.exerciseIds,
        plannedMinutes: activity.plannedMinutes,
        reason: activity.reason,
        status: idx === 0 ? 'in_progress' : 'planned',
        startedAt: idx === 0 ? now : null,
        completedAt: null,
        progress: {},
      })),
    );
    return created({ sessionId: session.id });
  });
}
