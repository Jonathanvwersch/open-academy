import { z } from 'zod';
import {
  getCourse,
  getCourseCatalog,
  getCourseDetail,
  setActiveCourse,
  startActiveCourseFromBeginning,
  startCourseFromBeginning,
} from '../course/course-reads.js';
import { readExercise } from '../course/exercise-reads.js';
import { getLearnHome } from '../course/learn-home.js';
import { conceptDetail, planWeek, studyMap } from '../course/learning-reads.js';
import { restartTopic, updateLearningFocus } from '../course/progress-commands.js';
import { serializeExercise } from '../course/serialize.js';
import type { GradeResult } from '../lessons/grading/types.js';
import {
  readLesson,
  readLessonQuizReview,
  readLessonReview,
  readLessonRun,
} from '../lessons/reads.js';
import { hintOperation } from '../memory/hint-operations.js';
import { readReviews } from '../memory/review-reads.js';
import { paper, papers, savePaperProgress, submitPaperSummary } from '../papers/operations.js';
import {
  getPlacementRun,
  placementNext,
  placementResults,
  startPlacement,
} from '../placement/diagnostic-commands.js';
import { loadHomePlan } from '../planner/home-plan.js';
import { endSession } from '../planner/session-commands.js';
import { readProgress } from '../progress/progress.js';
import {
  projectOperation,
  projectsOperation,
  submitProjectResults,
} from '../projects/operations.js';
import {
  answerQuiz,
  finalizeQuiz,
  getQuiz,
  startQuiz,
  startQuizFollowUps,
  startQuizRetake,
} from '../quizzes/quiz-commands.js';
import { tutorContextOperation } from '../tutor/context.js';
import { exerciseAttempt, placementAnswer, placementCommand } from './attempts.js';
import { lessonOperation } from './lessons.js';
import type { EngineLearnerRepository } from './repository.js';
import {
  activeSession,
  activityProgressOperation,
  createSessionOperation,
  replanSessionOperation,
  sessionById,
} from './sessions.js';
import { saveSettingsOperation, settingsOperation } from './settings.js';
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
    case 'progress':
      return respond(
        await readProgress(store, {
          userId,
          content,
          timeZone: request.timeZone,
          now: request.now,
          studyCourseIds: () => repo.studyCourseIds(content),
        }),
      );
    case 'reviews': {
      const now = request.now();
      const studyCourseIds = await repo.studyCourseIds(content);
      return respond(
        await readReviews(store, {
          userId,
          content,
          now,
          timeZone: request.timeZone,
          studyCourseIds,
          activeCourseId: () => repo.activeCourseId(),
        }),
      );
    }
    case 'studyMap':
      return respond(
        await studyMap(store, {
          userId,
          content,
          courseIds: await repo.studyCourseIds(content),
        }),
      );
    case 'concept': {
      const payload = await conceptDetail(store, {
        userId,
        content,
        conceptId: operation.conceptId,
      });
      return payload ? respond(payload) : respond({ error: 'Concept not found' }, 404);
    }
    case 'planWeek':
      return respond(planWeek(content, await repo.schedulerState(request.now(), content)));
    case 'lesson':
      return readLesson(request, operation.conceptId);
    case 'lessonReview':
      return readLessonReview(request, operation.conceptId);
    case 'exercise':
      return readExercise(request, operation.id);
    case 'hint':
      return hintOperation(request, operation.body);
    case 'tutorContext':
      return tutorContextOperation(request, operation);
    case 'activeSession':
      return activeSession(request);
    case 'lessonRun':
      return readLessonRun(request, operation.conceptId, operation.activityId);
    case 'lessonQuizReview':
      return readLessonQuizReview(request, operation.conceptId, operation.attemptId);
    case 'learn':
      return respond(await getLearnHome(store, await courseInput(request)));
    case 'courseCatalog':
      return respond(await getCourseCatalog(store, await courseInput(request)));
    case 'settings':
      return settingsOperation(request);
    case 'saveSettings':
      return saveSettingsOperation(request, operation.body);
    case 'course': {
      if (operation.courseId === undefined) {
        return respond(await getCourse(store, await courseInput(request), operation.course));
      }
      if (!content.coursesById.has(operation.courseId)) {
        return respond({ error: 'Course not found' }, 404);
      }
      const payload = await getCourseDetail(store, await courseInput(request), operation.courseId);
      return payload ? respond(payload) : respond({ error: 'Course not found' }, 404);
    }
    case 'setActiveCourse': {
      const body = z.record(z.string(), z.unknown()).safeParse(operation.body);
      const courseId = body.success ? body.data.courseId : undefined;
      if (typeof courseId !== 'string') return respond({ error: 'Invalid courseId' }, 400);
      if (!content.coursesById.has(courseId)) return respond({ error: 'Unknown course' }, 404);
      return respond(await setActiveCourse(store, userId, courseId));
    }
    case 'setFocus': {
      const body = z
        .object({ subjectId: z.string().nullable() })
        .strict()
        .safeParse(operation.body);
      if (!body.success) return respond({ error: 'Invalid focus subject' }, 400);
      const { subjectId } = body.data;
      if (
        subjectId !== null &&
        !content.curriculum?.subjects?.some((subject) => subject.id === subjectId)
      ) {
        return respond({ error: 'Unknown focus subject' }, 400);
      }
      await updateLearningFocus(
        store,
        { userId, content, subjectId, now: request.now() },
        {
          settings: () => repo.settings(),
          activeSession: (now) => repo.activeSession(now),
          session: (id) => repo.session(id),
          schedulerState: (now, index) => repo.schedulerState(now, index),
        },
      );
      return respond({ focusSubjectId: subjectId });
    }
    case 'restartTopic':
      if (!content.conceptsById.has(operation.conceptId)) {
        return respond({ error: 'Concept not found' }, 404);
      }
      await restartTopic(store, { userId, conceptId: operation.conceptId, content });
      return respond({ conceptId: operation.conceptId });
    case 'setEnrollment': {
      if (!content.coursesById.has(operation.courseId)) {
        return respond({ error: 'Course not found' }, 404);
      }
      const body =
        operation.body && typeof operation.body === 'object'
          ? (operation.body as { status?: unknown })
          : null;
      if (body?.status !== 'active' && body?.status !== 'paused') {
        return respond({ error: 'Invalid enrollment status' }, 400);
      }
      const enrollment = await repo.courseEnrollment(operation.courseId);
      if (!enrollment) {
        return respond(
          { error: body.status === 'active' ? 'Start this course first' : 'Course is not active' },
          409,
        );
      }
      await repo.setCourseEnrollmentStatus(operation.courseId, body.status);
      return respond({ id: operation.courseId, status: body.status });
    }
    case 'startCourse': {
      if (operation.courseId !== undefined && !content.coursesById.has(operation.courseId)) {
        return respond({ error: 'Course not found' }, 404);
      }
      const body = z
        .object({ method: z.unknown().optional(), courseId: z.unknown().optional() })
        .safeParse(operation.body);
      if (!body.success || body.data.method !== 'beginning') {
        return respond({ error: 'Invalid course start method' }, 400);
      }
      const input = await courseInput(request);
      if (operation.courseId === undefined) {
        const start = await startActiveCourseFromBeginning(
          store,
          input,
          typeof body.data.courseId === 'string' ? body.data.courseId : undefined,
        );
        return start ? respond(start) : respond({ error: 'No active course' }, 404);
      }
      return respond(await startCourseFromBeginning(store, input, operation.courseId));
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
      return replanSessionOperation(request, operation.sessionId, operation.body);
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
      const body =
        operation.body && typeof operation.body === 'object'
          ? (operation.body as { courseId?: unknown })
          : null;
      const result = await startPlacement(
        store,
        placementCommand(request),
        typeof body?.courseId === 'string' ? body.courseId : undefined,
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
    case 'startTimedQuiz': {
      const body = z
        .object({ sessionId: z.string(), activityId: z.string() })
        .safeParse(operation.body);
      if (!body.success) return respond({ error: 'Invalid quiz activity' }, 400);
      return quizResponse(await startQuiz(store, quizContext(request), body.data));
    }
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
      const grade = async (...args: Parameters<typeof request.grade>) =>
        (await request.grade(...args)) as GradeResult;
      return quizResponse(
        await answerQuiz(store, quizContext(request), operation.quizId, body.data, grade),
      );
    }
    case 'finalizeTimedQuiz':
      return quizResponse(await finalizeQuiz(store, quizContext(request), operation.quizId));
    case 'retakeTimedQuiz':
      return quizResponse(await startQuizRetake(store, quizContext(request), operation.quizId));
    case 'timedQuizFollowUps':
      return quizResponse(await startQuizFollowUps(store, quizContext(request), operation.quizId));
    case 'projects':
      return projectsOperation(request);
    case 'project':
      return projectOperation(request, operation.id);
    case 'submitProjectResults':
      return submitProjectResults(request, operation.id, operation.body);
    case 'papers':
      return papers(request);
    case 'paper':
      return paper(request, operation.id);
    case 'savePaperProgress':
      return savePaperProgress(request, operation.id, operation.body);
    case 'submitPaperSummary':
      return submitPaperSummary(request, operation.id, operation.body);
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
