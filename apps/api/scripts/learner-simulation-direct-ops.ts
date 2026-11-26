import {
  getCourseCatalog,
  getCourseDetail,
  setActiveCourse,
  startCourseFromBeginning,
} from '@academy/aesop/course/course-reads';
import { getLearnHome } from '@academy/aesop/course/learn-home';
import { replanSessionActivities as replanCourseSession } from '@academy/aesop/course/progress-commands';
import { serializeExercise } from '@academy/aesop/course/serialize';
import { isTemplate } from '@academy/aesop/course/templates';
import { sessionActivityIsInContent } from '@academy/aesop/graph/content-filters';
import { labActivityReady, masteryKey } from '@academy/aesop/graph/prerequisites';
import { answerDisplay } from '@academy/aesop/lessons/answer-display';
import { answerOptionsFor } from '@academy/aesop/lessons/answer-options';
import { gradeExercise } from '@academy/aesop/lessons/grading/index';
import { rubricFeedbackWithScoredFlags } from '@academy/aesop/lessons/grading/rubric-score';
import { initialLearnProgress } from '@academy/aesop/lessons/initial-learn-progress';
import {
  prepareExerciseAttempt,
  recordExerciseAttempt,
} from '@academy/aesop/memory/exercise-attempts';
import { attemptAllowsRetry } from '@academy/aesop/memory/retry';
import {
  answerPlacement,
  getPlacementRun,
  placementNext,
  placementResults,
  preparePlacementAnswer,
  startPlacement,
} from '@academy/aesop/placement/diagnostic-commands';
import { loadHomePlan, withReviewTopics } from '@academy/aesop/planner/home-plan';
import { attemptedExerciseIdsByActivity } from '@academy/aesop/planner/review-topics';
import type { SessionPreferences } from '@academy/aesop/planner/scheduler';
import {
  createSession,
  endSession,
  replacePlannedActivities,
} from '@academy/aesop/planner/session-commands';
import { updateSessionProgress } from '@academy/aesop/planner/session-progress';
import { localDateKey, xpGoalFor } from '@academy/aesop/progress/xp';
import {
  answerQuiz,
  finalizeQuiz,
  getQuiz,
  startQuiz,
  startQuizFollowUps,
  startQuizRetake,
} from '@academy/aesop/quizzes/quiz-commands';
import { emptyAnswerMessage } from '@academy/shared/answer-validation';
import { z } from 'zod';
import {
  type DirectRequest,
  type DirectResponse,
  lessonOperation,
  respond,
} from './learner-simulation-direct-lessons.js';
import type { DirectLearnerRepository } from './learner-simulation-direct-repo.js';
import type { SimulatorOperation } from './learner-simulation-driver.js';

const fsrsFuzz = () => process.env.NODE_ENV !== 'test';

export type PaperProgressRow = {
  userId: string;
  paperId: string;
  lastPage: number;
  notes: Record<string, string>;
  summary: string | null;
  summaryJudgement: unknown;
  completedAt: Date | null;
  updatedAt: Date;
};

/** Answers one simulator operation from the memory store, as the matching API handler does. */
export async function directOperation(
  request: DirectRequest,
  operation: SimulatorOperation,
  papers: Map<string, PaperProgressRow>,
): Promise<DirectResponse> {
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
          false,
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
      return store.transaction(async (tx) => {
        await tx.lockLearner(userId, 'no_key_update');
        return createSessionRequest(
          { ...request, store: tx, repo: request.freshRepo(tx, false) },
          operation.body,
        );
      });
    case 'session':
      return sessionById(request, operation.sessionId);
    case 'activityProgress':
      return store.transaction(async (tx) => {
        const session = await tx.lockSession(userId, operation.sessionId);
        const locked = session && { ...session, userId };
        return activityProgress(
          { ...request, store: tx, repo: request.freshRepo(tx, true) },
          operation.sessionId,
          operation.activityId,
          operation.body,
          locked,
        );
      });
    case 'replanSession':
      return store.transaction(async (tx) => {
        const session = await tx.lockSession(userId, operation.sessionId);
        const locked = session && { ...session, userId };
        return replanSession(
          { ...request, store: tx, repo: request.freshRepo(tx, true) },
          operation.sessionId,
          {},
          locked,
        );
      });
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
        .object({ position: z.number().int().nonnegative(), answer: z.unknown() })
        .safeParse(operation.body);
      if (!body.success) return respond({ error: 'Invalid quiz answer' }, 400);
      return quizResponse(
        await answerQuiz(store, quizContext(request), operation.quizId, body.data),
      );
    }
    case 'finalizeTimedQuiz':
      return quizResponse(await finalizeQuiz(store, quizContext(request), operation.quizId));
    case 'retakeTimedQuiz':
      return quizResponse(await startQuizRetake(store, quizContext(request), operation.quizId));
    case 'timedQuizFollowUps':
      return quizResponse(await startQuizFollowUps(store, quizContext(request), operation.quizId));
    case 'paperProgress':
      return paperProgress(request, operation.paperId, operation.body, papers);
  }
}

function homeReads(repo: DirectLearnerRepository) {
  return {
    schedulerState: (now: Date, index: DirectRequest['content']) => repo.schedulerState(now, index),
    user: () => repo.user(),
    activeSession: (now: Date) => repo.activeSession(now),
    courseEnrollments: () => repo.courseEnrollments(),
    session: (id: string) => repo.session(id),
    attemptedExerciseIdsByActivity: (ids: readonly string[]) =>
      repo.attemptedExerciseIdsByActivity(ids),
    completeCourses: (ids: readonly string[], now: Date) => repo.completeCourses(ids, now),
  };
}

async function courseInput(request: DirectRequest) {
  return {
    userId: request.userId,
    content: request.content,
    timeZone: request.timeZone,
    settings: (await request.repo.settings()) ?? null,
    now: request.now,
    enableFsrsFuzz: fsrsFuzz(),
  };
}

async function createSessionRequest(request: DirectRequest, input: Record<string, unknown>) {
  const body = z
    .object({
      kind: z.enum(['weekday', 'saturday', 'sunday', 'custom']).optional(),
      budgetMinutes: z.number().int().positive().max(600).optional(),
      focusConceptId: z.string().optional(),
    })
    .safeParse(input);
  if (!body.success) {
    return respond({ error: 'Invalid session request', issues: body.error.issues }, 400);
  }
  const { store, userId, repo } = request;
  const outcome = await createSession(
    store,
    userId,
    request.content,
    request.now(),
    request.timeZone,
    body.data,
    {
      schedulerState: (date, course) => repo.schedulerState(date, course),
      preferences: async () => ((await repo.user())?.prefs ?? {}) as SessionPreferences,
      initialProgress: (activity, lesson) => initialLearnProgress(store, userId, activity, lesson),
    },
  );
  return outcome.kind === 'created'
    ? respond(outcome.session, 201)
    : respond({ error: outcome.error }, outcome.kind === 'not_found' ? 404 : 409);
}

async function sessionById(request: DirectRequest, sessionId: string) {
  const { store, userId, repo } = request;
  const index = request.content;
  const session = await repo.session(sessionId);
  const [masteryRows, runRows] = await Promise.all([
    store.listMastery(userId),
    store.listLessonRuns(userId),
  ]);
  const masteryByKey = new Map(
    masteryRows.map((record) => [
      masteryKey(record.conceptId, record.dimension),
      { state: record.state, inferred: record.inferred },
    ]),
  );
  const runs = runRows.map(({ conceptId, status }) => ({ conceptId, status }));
  const activities =
    session?.activities.filter(
      (activity) =>
        sessionActivityIsInContent(index, activity) &&
        ((activity.status !== 'planned' && activity.status !== 'in_progress') ||
          labActivityReady(activity, masteryByKey, runs, index)),
    ) ?? [];
  const activityIds = activities.map((activity) => activity.id);
  const activityAttempts = activityIds.length
    ? (await store.listAttempts(userId, { activityIds })).sort(
        (left, right) =>
          right.createdAt.getTime() - left.createdAt.getTime() || right.attemptNo - left.attemptNo,
      )
    : [];
  const attemptedByActivity = attemptedExerciseIdsByActivity(activityAttempts);
  const xp = session
    ? await (async () => {
        const now = request.now();
        const todayLocal = localDateKey(now, request.timeZone);
        const sessionStartedAt = session.startedAt ?? now;
        const sessionEndedAt = session.endedAt ?? now;
        const [user, allEvents, todayEvents] = await Promise.all([
          repo.user(),
          store.listXpEvents(userId, {}),
          store.listXpEvents(userId, { localDate: todayLocal }),
        ]);
        const sessionEvents = allEvents.filter(
          (event) => event.earnedAt >= sessionStartedAt && event.earnedAt <= sessionEndedAt,
        );
        return {
          session: sessionEvents.reduce((total, event) => total + event.amount, 0),
          today: todayEvents.reduce((total, event) => total + event.amount, 0),
          goal: xpGoalFor(todayLocal, (user?.prefs ?? {}) as SessionPreferences),
        };
      })()
    : undefined;
  if (!session) return respond({ error: 'Session not found' }, 404);
  return respond({
    ...session,
    quizFollowUp: (session.plan as { quizFollowUp?: string }).quizFollowUp,
    xp,
    activities: activities.map((activity) => ({
      ...withReviewTopics(
        {
          ...activity,
          conceptTitle: activity.conceptId
            ? index.conceptsById.get(activity.conceptId)?.title
            : undefined,
        },
        index,
        attemptedByActivity.get(activity.id),
      ),
      lessonAvailable: activity.conceptId ? index.lessonsByConcept.has(activity.conceptId) : false,
      lastAttempt: activityAttempts
        .filter(
          (attempt) =>
            attempt.activityId === activity.id && activity.exerciseIds.includes(attempt.exerciseId),
        )
        .map((attempt) => {
          const feedback = attempt.feedback as Record<string, unknown>;
          const answer = attempt.answer;
          const followUp = feedback.followUp === true;
          const retryAllowed = attemptAllowsRetry(attempt);
          const answerWithheld = retryAllowed;
          const exercise = index.exercisesById.get(attempt.exerciseId);
          const answerOptions = exercise
            ? answerOptionsFor(exercise, answer, !answerWithheld)
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
            ...(!answerWithheld
              ? { exemplar: feedback.exemplar, solution: feedback.solution }
              : {}),
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
    tutorEnabled: false,
  });
}

type LockedSession = Parameters<typeof updateSessionProgress>[8] extends {
  session: (id: string) => Promise<infer S>;
}
  ? S
  : never;

async function activityProgress(
  request: DirectRequest,
  sessionId: string,
  activityId: string,
  body: Record<string, unknown>,
  locked: Parameters<DirectLearnerRepository['session']>[1],
) {
  const { store, userId, repo } = request;
  let loaded = locked;
  const result = await updateSessionProgress(
    store,
    userId,
    sessionId,
    activityId,
    body,
    request.now,
    request.timeZone,
    fsrsFuzz(),
    {
      content: async () => request.content,
      session: (id) => {
        const session = id === sessionId ? loaded : undefined;
        loaded = undefined;
        return repo.session(id, session) as Promise<LockedSession>;
      },
      schedulerState: (date, index) => repo.schedulerState(date, index),
      attemptedExerciseIdsByActivity: (ids) => repo.attemptedExerciseIdsByActivity(ids),
      replanBlocked: async (index, date, session, state, blocked, activate) =>
        replanCourseSession(store, {
          userId,
          content: index,
          now: date,
          session,
          skipActivityIds: blocked,
          activatePlannedActivityId: activate,
          schedulerState: state ?? (await repo.schedulerState(date, index)),
        }),
    },
  );
  return respond(
    result.body,
    result.kind === 'not_found' ? 404 : result.kind === 'conflict' ? 409 : 200,
  );
}

async function replanSession(
  request: DirectRequest,
  sessionId: string,
  input: Record<string, unknown>,
  locked: Parameters<DirectLearnerRepository['session']>[1],
) {
  const { store, userId, repo } = request;
  const session = await repo.session(sessionId, locked);
  if (!session) return respond({ error: 'Session not found' }, 404);
  const now = request.now();
  const body = z
    .object({ remainingBudgetMinutes: z.number().int().min(0).max(600).optional() })
    .safeParse(input);
  if (!body.success) return respond({ error: 'Invalid replan request' }, 400);
  return respond(
    await replacePlannedActivities(
      store,
      userId,
      session,
      request.content,
      now,
      body.data.remainingBudgetMinutes,
      {
        schedulerState: (date, course) => repo.schedulerState(date, course),
        attemptedExerciseIdsByActivity: (ids) => repo.attemptedExerciseIdsByActivity(ids),
        initialProgress: (activity, lesson) =>
          initialLearnProgress(store, userId, activity, lesson),
      },
    ),
  );
}

async function exerciseAttempt(request: DirectRequest, input: Record<string, unknown>) {
  const body = z
    .object({
      exerciseId: z.string(),
      activityId: z.string().optional(),
      answer: z.unknown(),
      mode: z.enum(['practice', 'assessment', 'diagnostic', 'review']).default('practice'),
      durationMs: z.number().int().nonnegative().optional(),
    })
    .safeParse(input);
  if (!body.success) return respond({ error: 'Invalid attempt' }, 400);
  const index = request.content;
  const exercise = index.exercisesById.get(body.data.exerciseId);
  if (!exercise) return respond({ error: 'Exercise not found' }, 404);
  const emptyMessage = emptyAnswerMessage(exercise.type, body.data.answer);
  if (emptyMessage) return respond({ error: emptyMessage }, 422);
  if (isTemplate(exercise)) {
    return respond({ error: 'Template exercises must be answered through a lesson run.' }, 400);
  }
  const { store, userId, repo } = request;
  const prepared = await prepareExerciseAttempt(store, userId, index, exercise, body.data, (id) =>
    repo.session(id),
  );
  if (prepared.kind !== 'ready') {
    return respond(
      prepared.body,
      prepared.kind === 'not_found' ? 404 : prepared.kind === 'conflict' ? 409 : 400,
    );
  }
  const result = await gradeExercise(exercise, body.data.answer, { random: request.random });
  const rubricForFeedback =
    exercise.type === 'explain' && 'rubric' in result && Array.isArray(result.rubric)
      ? rubricFeedbackWithScoredFlags(exercise.rubric, result.rubric)
      : undefined;
  if (result.status !== 'graded') {
    return respond(
      exercise.type === 'explain' && result.status === 'self_check_required'
        ? {
            ...result,
            ...(rubricForFeedback ? { rubric: rubricForFeedback } : {}),
            ...(typeof body.data.answer === 'object' &&
            body.data.answer !== null &&
            'text' in body.data.answer &&
            typeof body.data.answer.text === 'string'
              ? { yourAnswer: body.data.answer.text }
              : {}),
            exemplar: exercise.exemplar,
            ...(exercise.solution ? { solution: exercise.solution } : {}),
          }
        : result,
      result.status === 'invalid' ? 422 : 200,
    );
  }
  const { step, followUp, ...attempt } = await recordExerciseAttempt(
    store,
    {
      now: request.now,
      newId: request.newId,
      enableFsrsFuzz: fsrsFuzz(),
      schedulerState: (now, content) => repo.schedulerState(now, content),
      session: (id) => repo.session(id),
    },
    prepared,
    {
      correct: result.correct,
      feedback: result.feedback,
      gradedBy: result.graded_by,
      mistakeCategory: result.mistake_category,
      ...('yourAnswer' in result ? { yourAnswer: result.yourAnswer } : {}),
      ...('rubric' in result ? { rubric: rubricForFeedback ?? result.rubric } : {}),
    },
    request.timeZone,
  );
  const answerWithheld = attempt.retryAllowed;
  const answerOptions = answerOptionsFor(exercise, body.data.answer, !answerWithheld);
  const resultForResponse: Record<string, unknown> = { ...result };
  if (answerWithheld) {
    delete resultForResponse.exemplar;
    delete resultForResponse.solution;
  }
  return respond({
    ...resultForResponse,
    ...attempt,
    ...(step ? { step } : {}),
    ...(followUp ? { followUp: true } : {}),
    ...(answerOptions ? { answerOptions } : {}),
    ...(!answerWithheld && exercise.type !== 'explain' && exercise.solution
      ? { solution: exercise.solution }
      : {}),
    ...(exercise.type === 'explain'
      ? {
          ...(!answerWithheld
            ? {
                exemplar: exercise.exemplar,
                ...(exercise.solution ? { solution: exercise.solution } : {}),
              }
            : {}),
          ...('rubric' in result ? { rubric: rubricForFeedback ?? result.rubric } : {}),
        }
      : {}),
  });
}

function placementCommand(request: DirectRequest) {
  return {
    userId: request.userId,
    timeZone: request.timeZone,
    now: request.now,
    newId: request.newId,
    enableFsrsFuzz: fsrsFuzz(),
  };
}

const durationMs = z.number().int().nonnegative().optional();
const placementAnswerBody = z.union([
  z.object({ exerciseId: z.string(), dontKnow: z.literal(true), durationMs }),
  z.object({ exerciseId: z.string(), answer: z.unknown(), durationMs }),
]);

async function placementAnswer(
  request: DirectRequest,
  placementId: string,
  body: Record<string, unknown>,
) {
  return request.store.transaction(async (tx) => {
    const prepared = await preparePlacementAnswer(
      tx,
      request.userId,
      placementId,
      placementAnswerBody.safeParse(body).data,
      async () => request.content,
    );
    if (prepared.kind === 'invalid') return respond({ error: 'Invalid placement answer' }, 400);
    if (prepared.kind === 'not_found') return respond({ error: 'Placement not found' }, 404);
    if (prepared.kind === 'inactive') return respond({ error: 'Placement is not active' }, 409);
    if (prepared.kind === 'stale') {
      return respond({ error: 'This is not the current placement item.' }, 409);
    }
    const { exercise, answer } = prepared;
    let grade: Awaited<ReturnType<typeof gradeExercise>>;
    if ('answer' in answer) {
      const emptyMessage = emptyAnswerMessage(exercise.type, answer.answer);
      if (emptyMessage) return respond({ error: emptyMessage }, 422);
      grade = await gradeExercise(exercise, answer.answer, { random: request.random });
    } else {
      grade = { status: 'graded', correct: 0, credit: 0, feedback: '', graded_by: 'self' };
    }
    if (grade.status !== 'graded') return respond({ error: 'Answer could not be graded' }, 422);
    return respond(await answerPlacement(tx, placementCommand(request), prepared, grade));
  });
}

function quizContext(request: DirectRequest) {
  return {
    learnerId: request.userId,
    timeZone: request.timeZone,
    now: request.now(),
    content: request.content,
    random: request.random,
    newId: request.newId,
    enableFsrsFuzz: fsrsFuzz(),
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

function paperProgress(
  request: DirectRequest,
  paperId: string,
  input: Record<string, unknown>,
  papers: Map<string, PaperProgressRow>,
) {
  const paper = request.content.papersById.get(paperId);
  if (!paper) return respond({ error: 'Paper not found' }, 404);
  const body = z
    .object({
      lastPage: z.number().int().min(1).optional(),
      notes: z.record(z.string(), z.string().max(4000)).optional(),
    })
    .strict()
    .safeParse(input);
  if (!body.success) return respond({ error: 'Invalid paper progress' }, 400);
  const allowed = new Set(paper.questions.map((question) => question.id));
  if (Object.keys(body.data.notes ?? {}).some((id) => !allowed.has(id))) {
    return respond({ error: 'Unknown question id in notes' }, 400);
  }
  const existing = papers.get(paper.id);
  const saved: PaperProgressRow = {
    userId: request.userId,
    paperId: paper.id,
    lastPage: body.data.lastPage ?? existing?.lastPage ?? 1,
    notes: { ...(existing?.notes ?? {}), ...(body.data.notes ?? {}) },
    summary: existing?.summary ?? null,
    summaryJudgement: existing?.summaryJudgement ?? null,
    completedAt: existing?.completedAt ?? null,
    updatedAt: request.now(),
  };
  papers.set(paper.id, saved);
  return respond(saved);
}
