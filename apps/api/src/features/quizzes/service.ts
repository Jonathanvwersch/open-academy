import {
  answerQuiz as answer,
  finalizeQuiz as finalize,
  getQuiz as get,
  startQuiz as start,
  startQuizFollowUps as startFollowUps,
  startQuizRetake as startRetake,
} from '@academy/aesop/quizzes/quiz-commands';
import { z } from 'zod';
import { drizzleLearnerStore } from '../../db/learner-store.js';
import { fsrsFuzzEnabled } from '../../learning/fsrs-fuzz.js';
import { type FeatureRequest, type FeatureServices, serviceResult } from '../../service-context.js';

const quizId = (request: FeatureRequest) => {
  const result = z.uuid().safeParse(request.params.id);
  return result.success ? result.data : undefined;
};

async function quizContext(deps: FeatureServices, request: FeatureRequest) {
  return {
    learnerId: request.userId,
    timeZone: request.timeZone,
    now: request.now(),
    content: await deps.content(),
    random: () => Math.random(),
    newId: () => crypto.randomUUID(),
    enableFsrsFuzz: fsrsFuzzEnabled(),
  };
}

type QuizResult<T> =
  | { kind: 'ok' | 'created'; body: T }
  | { kind: 'not_found' | 'conflict' | 'invalid'; error: string };

function respond<T>(result: QuizResult<T>) {
  return 'error' in result
    ? serviceResult(
        { error: result.error },
        ({ not_found: 404, conflict: 409, invalid: 422 } as const)[result.kind],
      )
    : serviceResult(result.body, result.kind === 'created' ? 201 : 200);
}

export async function startQuiz(deps: FeatureServices, request: FeatureRequest) {
  const body = z.object({ sessionId: z.uuid(), activityId: z.uuid() }).safeParse(request.body);
  if (!body.success) return serviceResult({ error: 'Invalid quiz activity' }, 400);
  return respond(
    await start(drizzleLearnerStore(request.repo.db), await quizContext(deps, request), body.data),
  );
}

export async function getQuiz(deps: FeatureServices, request: FeatureRequest) {
  return respond(
    await get(
      drizzleLearnerStore(request.repo.db),
      request.userId,
      quizId(request),
      deps.content,
      request.now,
    ),
  );
}

export async function answerQuiz(deps: FeatureServices, request: FeatureRequest) {
  const body = z
    .object({ position: z.number().int().nonnegative(), answer: z.unknown() })
    .safeParse(request.body);
  if (!body.success) return serviceResult({ error: 'Invalid quiz answer' }, 400);
  return respond(
    await answer(
      drizzleLearnerStore(request.repo.db),
      await quizContext(deps, request),
      quizId(request),
      body.data,
    ),
  );
}

export async function finalizeQuiz(deps: FeatureServices, request: FeatureRequest) {
  return respond(
    await finalize(
      drizzleLearnerStore(request.repo.db),
      await quizContext(deps, request),
      quizId(request),
    ),
  );
}

export async function startQuizRetake(deps: FeatureServices, request: FeatureRequest) {
  return respond(
    await startRetake(
      drizzleLearnerStore(request.repo.db),
      await quizContext(deps, request),
      quizId(request),
    ),
  );
}

export async function startQuizFollowUps(deps: FeatureServices, request: FeatureRequest) {
  return respond(
    await startFollowUps(
      drizzleLearnerStore(request.repo.db),
      await quizContext(deps, request),
      quizId(request),
    ),
  );
}
