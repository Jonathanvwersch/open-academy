import type { EngineGrade, EngineResult } from '@open-academy/engine/engine/create-engine';
import { gradeExercise } from '@open-academy/engine/lessons/grading/index';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import type { ApiEnv, ApiServices } from '../../http/context.js';
import { featureRequest } from '../../http/feature-service.js';
import { scoreRubric } from '../tutor/scoring.js';
import { getExercisesById, postHints } from './service.js';

const send = (context: Context<ApiEnv>, result: EngineResult) =>
  context.json(result.body, result.status);

export function registerExercisesRoutes(api: Hono<ApiEnv>, deps: ApiServices) {
  api.get('/exercises/:id', async (context) => {
    const response = await getExercisesById(deps, featureRequest(context, deps));
    return context.json(response.body, response.status);
  });
  api.post('/hints', async (context) => {
    const response = await postHints(
      deps,
      featureRequest(context, deps, await context.req.json().catch(() => ({}))),
    );
    return context.json(response.body, response.status);
  });
  api.post('/attempts', async (context) => {
    const body = await context.req.json().catch(() => ({}));
    if (
      !z.object({ activityId: z.string().uuid().optional() }).passthrough().safeParse(body).success
    ) {
      return context.json({ error: 'Invalid attempt' }, 400);
    }
    const tutor = deps.tutor(context);
    const grade: EngineGrade = async (exercise, answer, { random }) => {
      if (
        exercise.type === 'explain' &&
        deps.tutorProvider &&
        typeof answer === 'object' &&
        answer !== null &&
        'text' in answer &&
        typeof answer.text === 'string'
      ) {
        const judged = tutor
          ? await tutor.gradeExplanation({
              question: exercise.prompt,
              rubric: exercise.rubric,
              exemplar: exercise.exemplar,
              answer: answer.text,
            })
          : { status: 'fallback' as const };
        if (judged.status === 'ok' && judged.value) {
          const score = scoreRubric(exercise.rubric, judged.value);
          return {
            status: 'graded',
            correct: score.score,
            feedback: score.feedback,
            graded_by: 'llm',
            rubric: exercise.rubric.map((criterion) => ({
              id: criterion.id,
              criterion: criterion.criterion,
              required: criterion.required,
              judgement:
                judged.value?.criteria.find((entry) => entry.id === criterion.id)?.judgement ??
                'missing',
            })),
            exemplar: exercise.exemplar,
          };
        }
      }
      return gradeExercise(exercise, answer, { random });
    };
    return send(
      context,
      await deps.learner(context, grade).exerciseAttempt({
        body,
      }),
    );
  });
}
