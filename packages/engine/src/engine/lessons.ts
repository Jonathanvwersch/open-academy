import { emptyAnswerMessage } from '@open-academy/engine/api/answer-validation';
import { z } from 'zod';
import { getLessonPrerequisites } from '../course/index.js';
import { serializeExercise } from '../course/serialize.js';
import { formatTemplateNumber } from '../course/templates.js';
import type { ContentIndex, IndexedExercise, IndexedLesson } from '../course/types.js';
import { lessonCourseContext } from '../graph/lesson-course-context.js';
import { answerDisplay, answerText } from '../lessons/answer-display.js';
import { answerOptionsFor } from '../lessons/answer-options.js';
import { MULTIPLE_CHOICE_FALLBACK_FEEDBACK } from '../lessons/grading/multiple-choice.js';
import type { GradeResult } from '../lessons/grading/types.js';
import {
  answerLessonProblem,
  answerLessonQuiz,
  type LessonGrader,
  practiceLessonPoint,
  resolveLessonExercise,
  startLessonQuiz,
  startLessonRun,
  submitLessonQuiz,
} from '../lessons/run-commands.js';
import type { LessonRuntime } from '../lessons/run-recovery.js';
import { readLessonState } from '../lessons/run-state.js';
import { applyMastery } from '../memory/mastery-service.js';
import type { LessonRun } from '../store/lesson-store.js';
import { type EngineRequest, type EngineResult, respond } from './types.js';

function correctAnswerDisplay(exercise: IndexedExercise): string {
  if (exercise.type === 'mc') {
    return exercise.options
      .filter((option) => option.correct)
      .map((option) => option.text)
      .join('\n');
  }
  if (exercise.type === 'numeric') {
    return 'answer' in exercise ? formatTemplateNumber(exercise.answer) : '';
  }
  if ('answer' in exercise) return answerText(exercise.answer);
  if ('accept' in exercise) return exercise.accept.join(', ');
  if (exercise.type === 'explain') return exercise.exemplar;
  if (exercise.type === 'debug') {
    return exercise.fix_options
      .filter((option) => option.correct)
      .map((option) => option.text)
      .join('\n');
  }
  return '';
}

function runtime(request: EngineRequest): LessonRuntime {
  return {
    now: request.now,
    random: request.random,
    newId: request.newId,
    enableFsrsFuzz: request.fsrsFuzz,
  };
}

async function lessonCourse(request: EngineRequest, conceptId: string, activityId?: string) {
  const { content, store, userId } = request;
  const containing = content.courses.filter((course) =>
    course.units.some((unit) => unit.concepts.includes(conceptId)),
  );
  let preferredCourseId: string | undefined;
  let studyCourseIds: string[] = [];
  if (containing.length > 1) {
    const activities = await store.listActivities(userId, {
      conceptId,
      ...(activityId ? { ids: [activityId] } : {}),
    });
    const sessions = await store.listSessions(userId, {
      ids: [...new Set(activities.map((activity) => activity.sessionId))],
    });
    const startedAt = new Map(sessions.map((session) => [session.id, session.startedAt]));
    const time = (id: string) => startedAt.get(id)?.getTime() ?? Number.POSITIVE_INFINITY;
    preferredCourseId = [...activities]
      .sort((left, right) => time(right.sessionId) - time(left.sessionId) || right.idx - left.idx)
      .map(({ reason }) => {
        const value = (reason as { courseId?: unknown }).courseId;
        return typeof value === 'string' ? value : undefined;
      })
      .find((value) => value !== undefined);
    studyCourseIds = await request.repo.activeStudyCourseIds(content);
  }
  const result = lessonCourseContext(content, { conceptId, preferredCourseId, studyCourseIds });
  return result
    ? {
        id: result.courseId,
        title: result.courseTitle,
        unitNumber: result.unitNumber,
        unitTitle: result.unitTitle,
        position: result.position,
      }
    : null;
}

async function runState(
  request: EngineRequest,
  lesson: IndexedLesson,
  index: ContentIndex,
  run: LessonRun,
) {
  const { userId } = request;
  const snapshot = await readLessonState(
    request.store,
    userId,
    run,
    lesson,
    index,
    runtime(request),
  );
  if (!snapshot) return null;
  ({ run } = snapshot);
  const { derived, lastAttempt, practicePending, needsProgressSync, retry, currentQuiz } = snapshot;
  const point = lesson.knowledge_points?.find((item) => item.id === derived.currentPointId);
  const buildInstance = resolveLessonExercise;
  const pendingRow = derived.pending;
  const pendingExercise = pendingRow ? index.exercisesById.get(pendingRow.exerciseId) : undefined;
  const pendingInstance =
    pendingExercise && pendingRow ? buildInstance(pendingExercise, pendingRow.seed) : undefined;
  const lastRow = derived.lastAnswered;
  const lastExercise = lastRow ? index.exercisesById.get(lastRow.exerciseId) : undefined;
  const lastInstance =
    lastExercise && lastRow ? buildInstance(lastExercise, lastRow.seed) : undefined;
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
      ? buildInstance(practiceExercise, practicePending.seed)
      : undefined;
  const quiz = currentQuiz
    ? {
        ...snapshot.quiz,
        current: {
          attemptId: currentQuiz.attemptId,
          items: currentQuiz.items.map((item) => {
            const indexed = index.exercisesById.get(item.exerciseId);
            const instance = indexed ? buildInstance(indexed, item.seed) : undefined;
            return {
              id: item.id,
              position: item.position,
              exercise: instance ? serializeExercise(instance, userId) : null,
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
        ? { ...pendingRow, exercise: serializeExercise(pendingInstance, userId) }
        : undefined,
    pendingPracticeProblem:
      practicePending && practiceInstance
        ? { ...practicePending, exercise: serializeExercise(practiceInstance, userId) }
        : undefined,
    lastAnswered: lastInstance ? lastRow : undefined,
    lastAnsweredProblem:
      lastRow && lastInstance
        ? {
            ...lastRow,
            activityId: lastAttempt?.activityId ?? null,
            exercise: serializeExercise(lastInstance, userId),
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

async function verifyActivity(
  request: EngineRequest,
  activityId: string | undefined,
  conceptId: string,
) {
  if (!activityId) return { activity: undefined, session: undefined };
  const [activityRow] = await request.store.listActivities(request.userId, { ids: [activityId] });
  const session = activityRow ? await request.repo.session(activityRow.sessionId) : undefined;
  const activity = session?.activities.find((item) => item.id === activityId);
  if (activity?.kind !== 'learn' || activity.conceptId !== conceptId) return undefined;
  return { activity, session };
}

type LessonBody = Record<string, unknown> & { activityId?: string };

/** The lesson routes in `features/lessons/run-routes.ts`, called on the memory store. */
export async function lessonOperation(
  request: EngineRequest,
  kind:
    | 'startLessonRun'
    | 'practiceLessonPoint'
    | 'answerLessonProblem'
    | 'startLessonQuiz'
    | 'answerLessonQuiz'
    | 'submitLessonQuiz',
  conceptId: string,
  input: unknown,
): Promise<EngineResult> {
  const parsed = {
    startLessonRun: z
      .object({
        activityId: z.string().optional(),
        reconcileProgress: z.boolean().optional(),
      })
      .safeParse(input),
    practiceLessonPoint: z
      .object({
        pointId: z.string().min(1),
        activityId: z.string().optional(),
        warmup: z.boolean().optional(),
      })
      .safeParse(input),
    answerLessonProblem: z
      .object({
        problemId: z.string(),
        answer: z.unknown(),
        activityId: z.string().optional(),
        durationMs: z.number().int().nonnegative().optional(),
      })
      .safeParse(input),
    startLessonQuiz: z.object({ activityId: z.string().optional() }).safeParse(input),
    answerLessonQuiz: z
      .object({
        itemId: z.string(),
        answer: z.unknown(),
        activityId: z.string().optional(),
        durationMs: z.number().int().nonnegative().optional(),
      })
      .safeParse(input),
    submitLessonQuiz: z.object({ activityId: z.string().optional() }).safeParse(input),
  }[kind];
  if (!parsed.success) {
    const errors = {
      startLessonRun: 'Invalid lesson run request',
      practiceLessonPoint: 'Invalid practice request',
      answerLessonProblem: 'Invalid lesson answer',
      startLessonQuiz: 'Invalid quiz request',
      answerLessonQuiz: 'Invalid quiz answer',
      submitLessonQuiz: 'Invalid quiz submission',
    };
    return respond({ error: errors[kind] }, 400);
  }
  const body = parsed.data as LessonBody;
  const { store, userId, timeZone } = request;
  const index = request.content;
  const lesson = index.lessonsByConcept.get(conceptId);
  if (!lesson?.knowledge_points?.length) {
    return respond({ error: 'Knowledge-point lesson not found' }, 404);
  }
  const resolved = { index, lesson };
  const command = { userId, timeZone, conceptId, resolved };
  const activity = await verifyActivity(request, body.activityId, conceptId);
  if (!activity) return respond({ error: 'Learn activity not found' }, 403);
  const state = async (runId: string) => {
    const run = await store.getLessonRun(userId, { runId });
    return run ? await runState(request, lesson, index, run) : null;
  };
  const course = () => lessonCourse(request, conceptId, body.activityId);
  const sessionId = activity.activity ? activity.session?.id : undefined;
  const grade: LessonGrader = async (exercise, answer, { random, requireAnswer }) => {
    const feedback = requireAnswer ? emptyAnswerMessage(exercise.type, answer) : null;
    return feedback
      ? { status: 'invalid', feedback, graded_by: 'deterministic' }
      : ((await request.grade(exercise, answer, { random })) as GradeResult);
  };
  switch (kind) {
    case 'startLessonRun': {
      const run = await startLessonRun(store, runtime(request), {
        ...command,
        reconcileProgress: body.reconcileProgress as boolean | undefined,
      });
      if (run.kind === 'retry_tomorrow') {
        return respond({ error: 'This lesson comes back tomorrow.' }, 409);
      }
      if (run.kind === 'review_first') {
        return respond({ error: `Review ${run.titles.join(' and ')} first.` }, 409);
      }
      return respond({
        course: await course(),
        run: await runState(request, lesson, index, run.run),
      });
    }
    case 'practiceLessonPoint': {
      const result = await practiceLessonPoint(store, runtime(request), {
        ...command,
        ...(body as { pointId: string; activityId?: string; warmup?: boolean }),
      });
      if (result.kind === 'not_found') return respond({ error: 'Lesson step not found' }, 404);
      if (result.kind === 'not_passed') {
        return respond({ error: 'Only a passed step can be practised again' }, 409);
      }
      if (result.kind === 'review_complete') {
        return respond({ error: 'Quiz practice is complete for this step' }, 409);
      }
      if (result.kind === 'no_problem') {
        return respond({ error: 'No practice question is available' }, 409);
      }
      return respond({ course: await course(), run: await state(result.run.id) });
    }
    case 'answerLessonProblem': {
      const result = await answerLessonProblem(
        store,
        runtime(request),
        {
          ...command,
          ...(body as {
            problemId: string;
            answer: unknown;
            activityId?: string;
            durationMs?: number;
          }),
          sessionId,
        },
        { applyMastery, grade, hasTutorReply: request.hasTutorReply },
      );
      if (result.kind === 'not_found') return respond({ error: 'Lesson problem not found' }, 404);
      if (result.kind === 'invalid') return respond({ error: 'Invalid answer' }, 422);
      if (result.kind === 'conflict') {
        return respond(
          { error: 'Lesson problem has already been answered.', state: await state(result.runId) },
          409,
        );
      }
      return respond({
        correct: result.correct,
        feedback: result.feedback,
        solution: result.solution,
        xpAwarded: result.xpAwarded,
        state: await state(result.runId),
      });
    }
    case 'startLessonQuiz': {
      const result = await startLessonQuiz(store, runtime(request), command);
      if (result.kind === 'not_found') return respond({ error: 'Lesson run not found' }, 404);
      if (result.kind === 'steps_incomplete') {
        return respond({ error: 'Finish every lesson step before starting the quiz' }, 409);
      }
      if (result.kind === 'review_required') {
        return respond({ error: 'Review the steps you missed before retaking the quiz' }, 409);
      }
      if (result.kind === 'no_questions') {
        return respond({ error: 'No lesson quiz questions are available' }, 409);
      }
      return respond({ course: await course(), run: await state(result.runId) });
    }
    case 'answerLessonQuiz': {
      const result = await answerLessonQuiz(
        store,
        runtime(request),
        {
          ...command,
          ...(body as {
            itemId: string;
            answer: unknown;
            activityId?: string;
            durationMs?: number;
          }),
        },
        grade,
      );
      if (result.kind === 'not_found') return respond({ error: 'Quiz item not found' }, 404);
      if (result.kind === 'invalid') return respond({ error: 'Invalid answer' }, 422);
      if (result.kind === 'conflict') {
        return respond({ error: 'Quiz item has already been answered.' }, 409);
      }
      const run = await state(result.runId);
      return respond({ saved: true, course: await course(), run });
    }
    case 'submitLessonQuiz': {
      const result = await submitLessonQuiz(
        store,
        runtime(request),
        { ...command, activityId: body.activityId, sessionId },
        { grade, applyMastery },
      );
      if (result.kind === 'not_found') return respond({ error: 'Lesson quiz not found' }, 404);
      if (result.kind === 'unanswered') {
        return respond({ error: 'Answer every quiz question before submitting' }, 409);
      }
      if (result.kind === 'invalid_answer') {
        return respond({ error: 'A saved quiz answer could not be graded' }, 422);
      }
      const run = await state(result.runId);
      return respond({
        run,
        course: await course(),
        xpAwarded: result.kind === 'submitted' ? result.xpAwarded : 0,
      });
    }
  }
}
