import { serializeExercise } from '@academy/aesop/course/serialize';
import { gradeExercise } from '@academy/aesop/lessons/grading/index';
import {
  answerPlacement,
  getPlacementRun,
  placementNext,
  placementResults,
  preparePlacementAnswer,
  startPlacement,
} from '@academy/aesop/placement/diagnostic-commands';
import { emptyAnswerMessage } from '@academy/shared/answer-validation';
import { z } from 'zod';
import { drizzleLearnerStore } from '../../db/learner-store.js';
import { fsrsFuzzEnabled } from '../../learning/fsrs-fuzz.js';
import { type FeatureRequest, type FeatureServices, serviceResult } from '../../service-context.js';

const durationMs = z.number().int().nonnegative().optional();
const answerBody = z.union([
  z.object({ exerciseId: z.string(), dontKnow: z.literal(true), durationMs }),
  z.object({ exerciseId: z.string(), answer: z.unknown(), durationMs }),
]);

function command(request: FeatureRequest) {
  return {
    userId: request.userId,
    timeZone: request.timeZone,
    now: request.now,
    newId: () => crypto.randomUUID(),
    enableFsrsFuzz: fsrsFuzzEnabled(),
  };
}

export async function postPlacement(deps: FeatureServices, request: FeatureRequest) {
  const body = request.body as { courseId?: unknown } | null;
  const result = await startPlacement(
    drizzleLearnerStore(deps.db),
    command(request),
    typeof body?.courseId === 'string' ? body.courseId : undefined,
    deps.content,
  );
  if (result.kind === 'no_course') return serviceResult({ error: 'No active course' }, 404);
  return serviceResult({ id: result.id }, result.kind === 'created' ? 201 : 200);
}

export async function getPlacementNext(deps: FeatureServices, request: FeatureRequest) {
  const { userId } = request;
  const store = drizzleLearnerStore(deps.db);
  const run = z.string().uuid().safeParse(request.params.id).success
    ? await getPlacementRun(store, userId, request.params.id)
    : undefined;
  if (!run) return serviceResult({ error: 'Placement not found' }, 404);
  const next = await placementNext(store, userId, run, await deps.content());
  return serviceResult(
    next.complete ? next : { ...next, exercise: serializeExercise(next.exercise, userId) },
  );
}

export async function postPlacementAnswer(deps: FeatureServices, request: FeatureRequest) {
  if (!z.string().uuid().safeParse(request.params.id).success)
    return serviceResult({ error: 'Placement not found' }, 404);
  return drizzleLearnerStore(deps.db).transaction(async (tx) => {
    const prepared = await preparePlacementAnswer(
      tx,
      request.userId,
      request.params.id,
      answerBody.safeParse(request.body).data,
      deps.content,
    );
    if (prepared.kind === 'invalid')
      return serviceResult({ error: 'Invalid placement answer' }, 400);
    if (prepared.kind === 'not_found') return serviceResult({ error: 'Placement not found' }, 404);
    if (prepared.kind === 'inactive')
      return serviceResult({ error: 'Placement is not active' }, 409);
    if (prepared.kind === 'stale')
      return serviceResult({ error: 'This is not the current placement item.' }, 409);
    const { exercise, answer } = prepared;
    let grade: Awaited<ReturnType<typeof gradeExercise>>;
    if ('answer' in answer) {
      const emptyMessage = emptyAnswerMessage(exercise.type, answer.answer);
      if (emptyMessage) return serviceResult({ error: emptyMessage }, 422);
      grade = await gradeExercise(exercise, answer.answer, { random: () => Math.random() });
    } else {
      grade = { status: 'graded', correct: 0, credit: 0, feedback: '', graded_by: 'self' };
    }
    if (grade.status !== 'graded')
      return serviceResult({ error: 'Answer could not be graded' }, 422);
    return serviceResult(await answerPlacement(tx, command(request), prepared, grade));
  });
}

export async function getPlacementResults(deps: FeatureServices, request: FeatureRequest) {
  const store = drizzleLearnerStore(deps.db, { schedulerTimezone: request.timeZone });
  const run = z.string().uuid().safeParse(request.params.id).success
    ? await getPlacementRun(store, request.userId, request.params.id)
    : undefined;
  if (!run) return serviceResult({ error: 'Placement not found' }, 404);
  if (run.status !== 'completed') return serviceResult({ error: 'Placement is not complete' }, 409);
  const result = await placementResults(store, command(request), run, await deps.content());
  return result
    ? serviceResult(result)
    : serviceResult({ error: 'Placement course not found' }, 404);
}
