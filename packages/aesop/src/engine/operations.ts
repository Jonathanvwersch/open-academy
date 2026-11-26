import { z } from 'zod';
import {
  getCourseCatalog,
  getCourseDetail,
  setActiveCourse,
  startCourseFromBeginning,
} from '../course/course-reads.js';
import { getLearnHome } from '../course/learn-home.js';
import { serializeExercise } from '../course/serialize.js';
import {
  getPlacementRun,
  placementNext,
  placementResults,
  startPlacement,
} from '../placement/diagnostic-commands.js';
import { loadHomePlan } from '../planner/home-plan.js';
import { endSession } from '../planner/session-commands.js';
import {
  answerQuiz,
  finalizeQuiz,
  getQuiz,
  startQuiz,
  startQuizFollowUps,
  startQuizRetake,
} from '../quizzes/quiz-commands.js';
import { exerciseAttempt, placementAnswer, placementCommand } from './attempts.js';
import { lessonOperation } from './lessons.js';
import type { EngineLearnerRepository } from './repository.js';
import {
  activityProgressOperation,
  createSessionOperation,
  replanSessionOperation,
  sessionById,
} from './sessions.js';
import { type EngineOperation, type EngineRequest, type EngineResult, respond } from './types.js';

export async function runEngineOperation(
  request: EngineRequest,
  operation: EngineOperation,
): Promise<EngineResult> {
  const { store, userId, content, repo } = request;
  switch (operation.kind) {
    case 'today':
      return respond(
        await loadHomePlan(
          store,
          userId,
          homeReads(repo),
          content,
          request.now(),
          request.timeZone,
          request.tutorEnabled,
        ),
      );
    case 'learn':
      return respond(await getLearnHome(store, await courseInput(request)));
    case 'courseCatalog':
      return respond(await getCourseCatalog(store, await courseInput(request)));
    case 'course': {
      if (!content.coursesById.has(operation.courseId)) {
        return respond({ error: 'Course not found' }, 404);
      }
      const payload = await getCourseDetail(store, await courseInput(request), operation.courseId);
      return payload ? respond(payload) : respond({ error: 'Course not found' }, 404);
    }
    case 'setActiveCourse': {
      const courseId = operation.body.courseId;
      if (typeof courseId !== 'string') return respond({ error: 'Invalid courseId' }, 400);
      if (!content.coursesById.has(courseId)) return respond({ error: 'Unknown course' }, 404);
      return respond(await setActiveCourse(store, userId, courseId));
    }
    case 'startCourse': {
      if (!content.coursesById.has(operation.courseId)) {
        return respond({ error: 'Course not found' }, 404);
      }
      if (operation.body.method !== 'beginning') {
        return respond({ error: 'Invalid course start method' }, 400);
      }
      return respond(
        await startCourseFromBeginning(store, await courseInput(request), operation.courseId),
      );
    }
    case 'createSession':
      return createSessionOperation(request, operation.body);
    case 'session':
      return sessionById(request, operation.sessionId);
    case 'activityProgress':
      return activityProgressOperation(
        request,
        operation.sessionId,
        operation.activityId,
        operation.body,
      );
    case 'replanSession':
      return replanSessionOperation(request, operation.sessionId);
    case 'endSession': {
      const previous = await repo.session(operation.sessionId);
      if (!previous) return respond({ error: 'Session not found' }, 404);
      if (previous.status === 'completed') return respond(previous);
      const session = await endSession(store, userId, previous, request.now());
      return session ? respond(session) : respond({ error: 'Session not found' }, 404);
    }
    case 'startLessonRun':
    case 'practiceLessonPoint':
    case 'answerLessonProblem':
    case 'startLessonQuiz':
    case 'answerLessonQuiz':
    case 'submitLessonQuiz':
      return lessonOperation(request, operation.kind, operation.conceptId, operation.body);
    case 'exerciseAttempt':
      return exerciseAttempt(request, operation.body);
    case 'startPlacement': {
      const courseId = operation.body.courseId;
      const result = await startPlacement(
        store,
        placementCommand(request),
        typeof courseId === 'string' ? courseId : undefined,
        async () => content,
      );
      if (result.kind === 'no_course') return respond({ error: 'No active course' }, 404);
      return respond({ id: result.id }, result.kind === 'created' ? 201 : 200);
    }
    case 'placementNext': {
      const run = await getPlacementRun(store, userId, operation.placementId);
      if (!run) return respond({ error: 'Placement not found' }, 404);
      const next = await placementNext(store, userId, run, content);
      return respond(
        next.complete ? next : { ...next, exercise: serializeExercise(next.exercise, userId) },
      );
    }
    case 'placementAnswer':
      return placementAnswer(request, operation.placementId, operation.body);
    case 'placementResults': {
      const run = await getPlacementRun(store, userId, operation.placementId);
      if (!run) return respond({ error: 'Placement not found' }, 404);
      if (run.status !== 'completed') return respond({ error: 'Placement is not complete' }, 409);
      const result = await placementResults(store, placementCommand(request), run, content);
      return result ? respond(result) : respond({ error: 'Placement course not found' }, 404);
    }
    case 'startTimedQuiz':
      return quizResponse(await startQuiz(store, quizContext(request), operation.body));
    case 'timedQuiz':
      return quizResponse(
        await getQuiz(store, userId, operation.quizId, async () => content, request.now),
      );
    case 'answerTimedQuiz': {
      const body = z
        .object({
          position: z.number().int().nonnegative(),
          questionId: z.string().min(1).optional(),
          answer: z.unknown(),
        })
        .safeParse(operation.body);
      if (!body.success) return respond({ error: 'Invalid quiz answer' }, 400);
      return quizResponse(
        await answerQuiz(store, quizContext(request), operation.quizId, body.data, request.grade),
      );
    }
    case 'finalizeTimedQuiz':
      return quizResponse(await finalizeQuiz(store, quizContext(request), operation.quizId));
    case 'retakeTimedQuiz':
      return quizResponse(await startQuizRetake(store, quizContext(request), operation.quizId));
    case 'timedQuizFollowUps':
      return quizResponse(await startQuizFollowUps(store, quizContext(request), operation.quizId));
  }
}

function homeReads(repo: EngineLearnerRepository) {
  return {
    schedulerState: (now: Date, index: EngineRequest['content']) => repo.schedulerState(now, index),
    user: () => repo.user(),
    activeSession: (now: Date) => repo.activeSession(now),
    courseEnrollments: () => repo.courseEnrollments(),
    session: (id: string) => repo.session(id),
    attemptedExerciseIdsByActivity: (ids: readonly string[]) =>
      repo.attemptedExerciseIdsByActivity(ids),
    completeCourses: (ids: readonly string[], now: Date) => repo.completeCourses(ids, now),
  };
}

async function courseInput(request: EngineRequest) {
  return {
    userId: request.userId,
    content: request.content,
    timeZone: request.timeZone,
    settings: (await request.repo.settings()) ?? null,
    now: request.now,
    enableFsrsFuzz: request.fsrsFuzz,
  };
}

function quizContext(request: EngineRequest) {
  return {
    learnerId: request.userId,
    timeZone: request.timeZone,
    now: request.now(),
    content: request.content,
    random: request.random,
    newId: request.newId,
    enableFsrsFuzz: request.fsrsFuzz,
  };
}

type QuizResult<T> =
  | { kind: 'ok' | 'created'; body: T }
  | { kind: 'not_found' | 'conflict' | 'invalid'; error: string };

function quizResponse<T>(result: QuizResult<T>) {
  return 'error' in result
    ? respond(
        { error: result.error },
        ({ not_found: 404, conflict: 409, invalid: 422 } as const)[result.kind],
      )
    : respond(result.body, result.kind === 'created' ? 201 : 200);
}
