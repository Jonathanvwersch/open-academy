import { emptyAnswerMessage } from '@academy/shared/answer-validation';
import { z } from 'zod';
import { isTemplate } from '../course/templates.js';
import { answerOptionsFor } from '../lessons/answer-options.js';
import { rubricFeedbackWithScoredFlags } from '../lessons/grading/rubric-score.js';
import type { GradeResult } from '../lessons/grading/types.js';
import { prepareExerciseAttempt, recordExerciseAttempt } from '../memory/exercise-attempts.js';
import { answerPlacement, preparePlacementAnswer } from '../placement/diagnostic-commands.js';
import { type EngineRequest, type EngineResult, respond } from './types.js';

export async function exerciseAttempt(
  request: EngineRequest,
  input: Record<string, unknown>,
): Promise<EngineResult> {
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
  const result = await request.grade(exercise, body.data.answer, { random: request.random });
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
      enableFsrsFuzz: request.fsrsFuzz,
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

export function placementCommand(request: EngineRequest) {
  return {
    userId: request.userId,
    timeZone: request.timeZone,
    now: request.now,
    newId: request.newId,
    enableFsrsFuzz: request.fsrsFuzz,
  };
}

const durationMs = z.number().int().nonnegative().optional();
const placementAnswerBody = z.union([
  z.object({ exerciseId: z.string(), dontKnow: z.literal(true), durationMs }),
  z.object({ exerciseId: z.string(), answer: z.unknown(), durationMs }),
]);

export async function placementAnswer(
  request: EngineRequest,
  placementId: string,
  input: Record<string, unknown>,
): Promise<EngineResult> {
  return request.store.transaction(async (tx) => {
    const prepared = await preparePlacementAnswer(
      tx,
      request.userId,
      placementId,
      placementAnswerBody.safeParse(input).data,
      async () => request.content,
    );
    if (prepared.kind === 'invalid') return respond({ error: 'Invalid placement answer' }, 400);
    if (prepared.kind === 'not_found') return respond({ error: 'Placement not found' }, 404);
    if (prepared.kind === 'inactive') return respond({ error: 'Placement is not active' }, 409);
    if (prepared.kind === 'stale') {
      return respond({ error: 'This is not the current placement item.' }, 409);
    }
    const { exercise, answer } = prepared;
    let grade: GradeResult;
    if ('answer' in answer) {
      const emptyMessage = emptyAnswerMessage(exercise.type, answer.answer);
      if (emptyMessage) return respond({ error: emptyMessage }, 422);
      grade = await request.grade(exercise, answer.answer, { random: request.random });
    } else {
      grade = { status: 'graded', correct: 0, credit: 0, feedback: '', graded_by: 'self' };
    }
    if (grade.status !== 'graded') return respond({ error: 'Answer could not be graded' }, 422);
    return respond(await answerPlacement(tx, placementCommand(request), prepared, grade));
  });
}
