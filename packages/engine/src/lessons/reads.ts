import { z } from 'zod';
import { courseTopicState } from '../course/course-payload.js';
import { getLessonPrerequisites } from '../course/index.js';
import { serializeExercise, serializeLesson } from '../course/serialize.js';
import { isTemplate } from '../course/templates.js';
import type { ContentIndex, IndexedLesson } from '../course/types.js';
import type { EngineRequest, EngineResult } from '../engine/types.js';
import { respond } from '../engine/types.js';
import { masteryRank } from '../memory/types.js';
import type { LessonRun } from '../store/lesson-store.js';
import { answerDisplay, correctAnswerDisplay } from './answer-display.js';
import { answerOptionsFor } from './answer-options.js';
import { lessonStudyCourseIds, resolveLessonCourse } from './course-context.js';
import { MULTIPLE_CHOICE_FALLBACK_FEEDBACK } from './grading/multiple-choice.js';
import { resolveLessonExercise } from './run-commands.js';
import type { LessonRuntime } from './run-recovery.js';
import { readLessonReviewStatus, readLessonState } from './run-state.js';

export async function readLesson(request: EngineRequest, conceptId: string): Promise<EngineResult> {
  const { content, store, userId } = request;
  const lesson = content.lessonsByConcept.get(conceptId);
  const priorEvidence = (await store.listMastery(userId)).some(
    (record) =>
      record.conceptId === conceptId &&
      (record.inferred || masteryRank(record.state) >= masteryRank('assisted')),
  );
  const presentedLesson =
    lesson && priorEvidence
      ? {
          ...lesson,
          blocks: lesson.blocks.filter(
            (block) =>
              block.kind === 'objective' ||
              block.kind === 'summary' ||
              !lesson.fast_path.includes(block.kind),
          ),
        }
      : lesson;
  return presentedLesson
    ? respond(
        serializeLesson({
          ...presentedLesson,
          prerequisites: getLessonPrerequisites(content, conceptId),
        }),
      )
    : respond({ error: 'Lesson not found' }, 404);
}

export async function readLessonReview(
  request: EngineRequest,
  conceptId: string,
): Promise<EngineResult> {
  const { content, store, userId } = request;
  const lesson = content.lessonsByConcept.get(conceptId);
  const concept = content.conceptsById.get(conceptId);
  if (!lesson || !concept) return respond({ error: 'Lesson not found' }, 404);
  const checkAnswers = Object.fromEntries(
    lesson.blocks.flatMap((block) =>
      block.kind === 'check' && block.exercise
        ? [[block.exercise, content.exercisesById.get(block.exercise)?.solution ?? '']]
        : [],
    ),
  );
  const visibleChecks = lesson.blocks.filter(
    (block) =>
      block.kind === 'check' &&
      (!lesson.knowledge_points?.length || block.exercise === lesson.final),
  );
  const checks = Object.fromEntries(
    visibleChecks.flatMap((block) => {
      if (block.kind !== 'check') return [];
      const exercise = block.exercise ? content.exercisesById.get(block.exercise) : undefined;
      return exercise && !isTemplate(exercise)
        ? [[exercise.id, serializeExercise(exercise, userId)]]
        : [];
    }),
  );
  const runRowsPromise = store.listLessonRuns(userId);
  const studyCourseIds = await lessonStudyCourseIds(content, conceptId, () =>
    request.repo.activeStudyCourseIds(content),
  );
  const [runRows, masteryRecords, course] = await Promise.all([
    runRowsPromise,
    runRowsPromise.then((rows) =>
      rows.some((row) => row.conceptId === conceptId) ? [] : store.listMastery(userId),
    ),
    resolveLessonCourse(store, content, { userId, conceptId, studyCourseIds }),
  ]);
  const run = runRows.find((row) => row.conceptId === conceptId);
  const runStatus = await readLessonReviewStatus(store, userId, run, lesson, content);
  const topicState = courseTopicState(content, masteryRecords, runRows, new Set())(concept);
  return respond({
    course,
    canRestart:
      runRows.some((row) => row.conceptId === conceptId) ||
      topicState.dimensionStates.some((state) => state !== 'not_assessed'),
    lesson: serializeLesson({
      ...lesson,
      prerequisites: getLessonPrerequisites(content, conceptId),
    }),
    checkAnswers,
    checks,
    runStatus,
    conceptTitle: content.conceptsById.get(conceptId)?.title ?? conceptId,
  });
}

export async function lessonRunState(
  request: EngineRequest,
  lesson: IndexedLesson,
  index: ContentIndex,
  initialRun: LessonRun,
) {
  const runtime: LessonRuntime = {
    now: request.now,
    random: request.random,
    newId: request.newId,
    enableFsrsFuzz: request.fsrsFuzz,
  };
  const snapshot = await readLessonState(
    request.store,
    request.userId,
    initialRun,
    lesson,
    index,
    runtime,
  );
  if (!snapshot) return null;
  const run = snapshot.run;
  const { derived, lastAttempt, practicePending, needsProgressSync, retry, currentQuiz } = snapshot;
  const point = lesson.knowledge_points?.find((item) => item.id === derived.currentPointId);
  const pendingRow = derived.pending;
  const pendingExercise = pendingRow ? index.exercisesById.get(pendingRow.exerciseId) : undefined;
  const pendingInstance =
    pendingExercise && pendingRow
      ? resolveLessonExercise(pendingExercise, pendingRow.seed)
      : undefined;
  const lastRow = derived.lastAnswered;
  const lastExercise = lastRow ? index.exercisesById.get(lastRow.exerciseId) : undefined;
  const lastInstance =
    lastExercise && lastRow ? resolveLessonExercise(lastExercise, lastRow.seed) : undefined;
  const attemptFeedback = (lastAttempt?.feedback as { message?: string } | null)?.message;
  const lastAnswerOptions =
    lastAttempt && lastInstance
      ? answerOptionsFor(lastInstance, lastAttempt.answer, true)
      : undefined;
  const feedback =
    lastInstance?.type === 'mc' && attemptFeedback === MULTIPLE_CHOICE_FALLBACK_FEEDBACK
      ? ''
      : (attemptFeedback ??
        (lastRow?.correct === 1 ? 'Correct.' : MULTIPLE_CHOICE_FALLBACK_FEEDBACK));
  const practiceExercise = practicePending
    ? index.exercisesById.get(practicePending.exerciseId)
    : undefined;
  const practiceInstance =
    practiceExercise && practicePending
      ? resolveLessonExercise(practiceExercise, practicePending.seed)
      : undefined;
  const quiz = currentQuiz
    ? {
        ...snapshot.quiz,
        current: {
          attemptId: currentQuiz.attemptId,
          items: currentQuiz.items.map((item) => {
            const indexed = index.exercisesById.get(item.exerciseId);
            const instance = indexed ? resolveLessonExercise(indexed, item.seed) : undefined;
            return {
              id: item.id,
              position: item.position,
              exercise: instance ? serializeExercise(instance, request.userId) : null,
              answered: item.answeredAt !== null,
              ...(item.answeredAt !== null ? { answer: item.answer } : {}),
              locked: item.attemptId !== null,
            };
          }),
        },
      }
    : snapshot.quiz;
  return {
    id: run.id,
    ...(needsProgressSync ? { needsProgressSync: true } : {}),
    status: run.status === 'needs_retry' ? 'needs_retry' : derived.status,
    ...(retry ? { retry: { ...retry, after: retry.after?.toISOString() ?? null } } : {}),
    ...(derived.halted ? { halted: derived.halted } : {}),
    where_this_fits: lesson.where_this_fits,
    prerequisites: getLessonPrerequisites(index, lesson.concept),
    points: snapshot.points,
    currentPointId: derived.currentPointId,
    currentPoint: point
      ? {
          id: point.id,
          title: point.title,
          tldr: point.tldr,
          explain: point.explain,
          worked: point.worked,
        }
      : undefined,
    pending: pendingRow,
    pendingProblem:
      pendingRow && pendingInstance
        ? { ...pendingRow, exercise: serializeExercise(pendingInstance, request.userId) }
        : undefined,
    pendingPracticeProblem:
      practicePending && practiceInstance
        ? { ...practicePending, exercise: serializeExercise(practiceInstance, request.userId) }
        : undefined,
    lastAnswered: lastInstance ? lastRow : undefined,
    lastAnsweredProblem:
      lastRow && lastInstance
        ? {
            ...lastRow,
            activityId: lastAttempt?.activityId ?? null,
            exercise: serializeExercise(lastInstance, request.userId),
            result: {
              correct: lastRow.correct,
              attemptNo: lastAttempt?.attemptNo ?? 1,
              feedback,
              solution: lastInstance.solution,
              yourAnswer: answerDisplay(lastInstance, lastAttempt?.answer),
              correctAnswer: correctAnswerDisplay(lastInstance),
              ...(lastAnswerOptions ? { answerOptions: lastAnswerOptions } : {}),
            },
          }
        : undefined,
    xpEarned: snapshot.xpEarned,
    quiz,
  };
}

export async function readLessonRun(
  request: EngineRequest,
  conceptId: string,
  activityId?: string,
) {
  const { content, store, userId } = request;
  const lesson = content.lessonsByConcept.get(conceptId);
  if (!lesson?.knowledge_points?.length)
    return respond({ error: 'Knowledge-point lesson not found' }, 404);
  const run = await store.getLessonRun(userId, { conceptId });
  const studyCourseIds = await lessonStudyCourseIds(content, conceptId, () =>
    request.repo.activeStudyCourseIds(content),
  );
  return respond({
    course: await resolveLessonCourse(store, content, {
      userId,
      conceptId,
      activityId,
      studyCourseIds,
    }),
    run: run ? await lessonRunState(request, lesson, content, run) : null,
  });
}

export async function readLessonQuizReview(
  request: EngineRequest,
  conceptId: string,
  rawAttemptId: string,
) {
  if (!z.string().uuid().safeParse(rawAttemptId).success) {
    return respond({ error: 'Quiz attempt not found' }, 404);
  }
  const { content, store, userId } = request;
  const lesson = content.lessonsByConcept.get(conceptId);
  if (!lesson?.knowledge_points?.length)
    return respond({ error: 'Knowledge-point lesson not found' }, 404);
  const attemptId = rawAttemptId.toLowerCase();
  const run = await store.getLessonRun(userId, { conceptId });
  const quiz = run ? await store.readLessonQuiz(userId, run.id) : undefined;
  const attempt = quiz?.quizAttempts.find(
    (row) => row.id === attemptId && row.submittedAt !== null && row.passed === true,
  );
  if (!attempt) return respond({ error: 'Quiz review is available after passing' }, 403);
  const items = (quiz?.quizItems ?? [])
    .filter((item) => item.quizAttemptId === attemptId)
    .sort((left, right) => left.position - right.position || left.id.localeCompare(right.id));
  const body = items.flatMap((item) => {
    const indexed = content.exercisesById.get(item.exerciseId);
    const exercise = indexed ? resolveLessonExercise(indexed, item.seed) : undefined;
    if (!exercise) return [];
    return [
      {
        id: item.id,
        position: item.position,
        pointId: item.knowledgePointId,
        title:
          lesson.knowledge_points?.find((point) => point.id === item.knowledgePointId)?.title ??
          item.knowledgePointId,
        exercise: serializeExercise(exercise, userId),
        yourAnswer: answerDisplay(exercise, item.answer),
        correctAnswer: correctAnswerDisplay(exercise),
        answerOptions: answerOptionsFor(exercise, item.answer, true),
        solution: exercise.solution ?? '',
        correct: item.correct,
        durationMs: item.durationMs,
      },
    ];
  });
  return respond({ attemptId, items: body });
}
