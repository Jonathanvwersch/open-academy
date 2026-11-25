import type { ContentIndex, IndexedLesson } from '../course/types.js';
import type { LessonRun, LessonStore } from '../store/lesson-store.js';
import { QUIZ_PASS_MARK, selectQuizItems } from './lesson-quiz.js';
import { isLessonRetryReady } from './lesson-retry.js';
import { deriveLessonState, xpForPassedPoint } from './lesson-runner.js';
import { type LessonRuntime, loadRunSnapshot } from './run-recovery.js';

export async function readLessonState(
  store: LessonStore,
  userId: string,
  run: LessonRun,
  lesson: IndexedLesson,
  index: ContentIndex,
  runtime: LessonRuntime,
) {
  const now = runtime.now();
  const loaded = await loadRunSnapshot(store, userId, run, lesson, index, now, runtime);
  if (!loaded) return null;
  run = loaded.current;
  const { rows, derived, quizAttempts, quizItems } = loaded;
  const [lastAttempt] = derived.lastAnswered?.attemptId
    ? await store.listAttempts(userId, { ids: [derived.lastAnswered.attemptId] })
    : [];
  const earnedEvents = await store.listXpEvents(userId, {
    sourcePrefix: `kp:${run.id}:`,
  });
  const earnedByPoint = new Map(earnedEvents.map((event) => [event.sourceKey, event.amount]));
  const needsProgressSync = derived.points.some(
    (point) =>
      point.status === 'passed' &&
      !earnedByPoint.has(`kp:${run.id}:${point.id}`) &&
      rows.some(
        (row) =>
          !row.practiceOnly &&
          row.assisted &&
          row.knowledgePointId === point.id &&
          row.round === point.round &&
          row.answeredAt !== null &&
          row.position <= (point.passedOn?.position ?? 0),
      ),
  );
  const practicePending = rows.find((row) => row.practiceOnly && row.answeredAt === null);
  const itemsFor = (attemptId: string) =>
    quizItems.filter((item) => item.quizAttemptId === attemptId);
  const currentAttempt = quizAttempts.find((attempt) => attempt.submittedAt === null);
  const latestQuizAttempt = [...quizAttempts]
    .reverse()
    .find((attempt) => attempt.submittedAt !== null);
  const firstPassedAttempt = quizAttempts.find((attempt) => attempt.passed === true);
  const lastItems = latestQuizAttempt ? itemsFor(latestQuizAttempt.id) : [];
  const previousAttemptItems = latestQuizAttempt ? itemsFor(latestQuizAttempt.id) : [];
  const previewItems = selectQuizItems({
    lesson,
    exercises: index.exercisesById,
    servedProblems: rows.map((row) => ({ exerciseId: row.exerciseId, seed: row.seed })),
    previousAttemptItems,
    usedSeeds: new Set([
      ...rows.flatMap((row) => (row.seed === null ? [] : [row.seed])),
      ...quizItems.flatMap((item) => (item.seed === null ? [] : [item.seed])),
    ]),
    seed: 0,
  });
  const currentItems = currentAttempt ? itemsFor(currentAttempt.id) : [];
  const quizQuestionCount = currentAttempt
    ? currentItems.length
    : lastItems.length || previewItems.length;
  const quizStatus = run.quizPassedAt
    ? 'passed'
    : currentAttempt
      ? 'in_progress'
      : latestQuizAttempt
        ? latestQuizAttempt.passed
          ? 'passed'
          : 'failed'
        : 'not_started';
  const quizLast =
    latestQuizAttempt?.submittedAt &&
    latestQuizAttempt.score !== null &&
    latestQuizAttempt.passed !== null
      ? {
          attemptId: latestQuizAttempt.id,
          attemptNo: latestQuizAttempt.attemptNo,
          score: latestQuizAttempt.score,
          correctCount: lastItems.filter((item) => item.correct === 1).length,
          total: lastItems.length,
          passed: latestQuizAttempt.passed,
          perStep: (lesson.knowledge_points ?? []).map((knowledgePoint) => {
            const stepItems = lastItems.filter(
              (item) => item.knowledgePointId === knowledgePoint.id,
            );
            return {
              pointId: knowledgePoint.id,
              title: knowledgePoint.title,
              correct: stepItems.filter((item) => item.correct === 1).length,
              total: stepItems.length,
            };
          }),
        }
      : undefined;
  const latestQuizSubmittedAt = latestQuizAttempt?.submittedAt;
  const reviewRequired =
    !run.quizPassedAt && latestQuizAttempt?.passed === false && latestQuizSubmittedAt
      ? (lesson.knowledge_points ?? []).flatMap((knowledgePoint) => {
          const missed = lastItems.some(
            (item) =>
              item.knowledgePointId === knowledgePoint.id &&
              item.correct !== null &&
              item.correct < 1,
          );
          if (!missed) return [];
          const answered = Math.min(
            3,
            rows.filter(
              (row) =>
                row.practiceOnly &&
                row.knowledgePointId === knowledgePoint.id &&
                row.answeredAt !== null &&
                row.answeredAt > latestQuizSubmittedAt,
            ).length,
          );
          return [{ pointId: knowledgePoint.id, title: knowledgePoint.title, answered, needed: 3 }];
        })
      : [];
  const quizXpAwarded =
    latestQuizAttempt?.passed && firstPassedAttempt?.id === latestQuizAttempt.id
      ? lastItems.length
      : 0;
  const quiz = {
    status: quizStatus,
    passMark: QUIZ_PASS_MARK,
    questionCount: quizQuestionCount,
    ...(quizLast ? { last: quizLast } : {}),
    reviewRequired,
    bestPassed: Boolean(run.quizPassedAt || quizAttempts.some((attempt) => attempt.passed)),
    xpAwarded: quizXpAwarded,
  };
  const retryFlags =
    run.status === 'needs_retry'
      ? await store.listRemediationFlags(userId, { conceptId: run.conceptId, status: 'open' })
      : [];
  const reviewFirstIds = [
    ...new Set(retryFlags.map((flag) => flag.targetPrereqId ?? run.conceptId)),
  ];
  const retry =
    run.status === 'needs_retry'
      ? {
          after: run.retryAfter,
          ready: isLessonRetryReady(run.retryAfter, retryFlags.length > 0, now),
          reviewFirst: reviewFirstIds.map((id) => ({
            id,
            title: index.conceptsById.get(id)?.title ?? id,
          })),
        }
      : undefined;
  return {
    run,
    derived,
    lastAttempt,
    practicePending,
    needsProgressSync,
    retry,
    points: derived.points.map((point) => ({
      ...point,
      xpEarned:
        point.status === 'passed'
          ? (earnedByPoint.get(`kp:${run.id}:${point.id}`) ?? xpForPassedPoint(point.answered))
          : 0,
    })),
    xpEarned: earnedEvents.reduce((sum, event) => sum + event.amount, 0),
    quiz,
    currentQuiz: currentAttempt && { attemptId: currentAttempt.id, items: currentItems },
  };
}

export async function readPassedQuiz(
  store: LessonStore,
  userId: string,
  conceptId: string,
  attemptId: string,
) {
  const run = await store.getLessonRun(userId, { conceptId });
  if (!run) return;
  const quiz = await store.readLessonQuiz(userId, run.id);
  const attempt = quiz.quizAttempts.find((item) => item.id === attemptId);
  if (!attempt?.submittedAt || attempt.passed !== true) return;
  return quiz.quizItems.filter((item) => item.quizAttemptId === attempt.id);
}

export async function readLessonReviewStatus(
  store: LessonStore,
  userId: string,
  run: LessonRun | undefined,
  lesson: IndexedLesson,
  index: ContentIndex,
) {
  if (!run || !lesson.knowledge_points?.length) return null;
  const problems = await store.listLessonProblems(userId, run.id);
  return deriveLessonState(lesson, problems, index.exercisesById, run.quizPassedAt, run.attempt)
    .status;
}
