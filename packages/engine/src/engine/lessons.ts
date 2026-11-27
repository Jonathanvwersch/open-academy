import { z } from 'zod';
import { emptyAnswerMessage } from '../api/answer-validation.js';
import { lessonStudyCourseIds, resolveLessonCourse } from '../lessons/course-context.js';
import type { GradeResult } from '../lessons/grading/types.js';
import { lessonRunState } from '../lessons/reads.js';
import {
  answerLessonProblem,
  answerLessonQuiz,
  type LessonGrader,
  practiceLessonPoint,
  startLessonQuiz,
  startLessonRun,
  submitLessonQuiz,
} from '../lessons/run-commands.js';
import type { LessonRuntime } from '../lessons/run-recovery.js';
import { applyMastery } from '../memory/mastery-service.js';
import { type EngineRequest, type EngineResult, respond } from './types.js';

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
  const studyCourseIds = await lessonStudyCourseIds(content, conceptId, () =>
    request.repo.activeStudyCourseIds(content),
  );
  return resolveLessonCourse(store, content, {
    userId,
    conceptId,
    activityId,
    includeActivitiesWithoutSession: true,
    studyCourseIds,
  });
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
    return run ? await lessonRunState(request, lesson, index, run) : null;
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
        run: await lessonRunState(request, lesson, index, run.run),
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
