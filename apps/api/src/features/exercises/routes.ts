import { onScreenOptions } from '@academy/shared/shuffle';
import { serializedOptionOrder } from '@open-academy/engine/course/serialize';
import type {
  EngineGrade,
  EngineHintContext,
  EngineResult,
} from '@open-academy/engine/engine/create-engine';
import { gradeExercise } from '@open-academy/engine/lessons/grading/index';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import type { ApiEnv, ApiServices } from '../../http/context.js';
import {
  formatGraderFeedback,
  graderVerdictFor,
  tutorAnswerFor,
  tutorAnswerKeyFor,
  tutorSolutionFor,
} from '../tutor/feedback-context.js';
import { scoreRubric } from '../tutor/scoring.js';

const send = (context: Context<ApiEnv>, result: EngineResult) =>
  context.json(result.body, result.status);

export function registerExercisesRoutes(api: Hono<ApiEnv>, deps: ApiServices) {
  api.get('/exercises/:id', async (context) => {
    return send(context, await deps.learner(context).exercise({ id: context.req.param('id') }));
  });
  api.post('/hints', async (context) => {
    const body = await context.req.json().catch(() => ({}));
    const id =
      body &&
      typeof body === 'object' &&
      'exerciseId' in body &&
      typeof body.exerciseId === 'string'
        ? body.exerciseId
        : '';
    const generateHint = async (input: EngineHintContext) => {
      const tutor = deps.tutor(context);
      if (!tutor) return { kind: 'disabled' as const };
      const { exercise, level, hints, recentMistakes, priorAttempt, retrying, problemStatus } =
        input;
      const index = await deps.content();
      const concept = index.conceptsById.get(exercise.concept);
      const lesson = index.lessonsByConcept.get(exercise.concept);
      const optionTexts =
        exercise.type === 'mc'
          ? onScreenOptions(
              serializedOptionOrder(exercise.options, input.userId, exercise.id),
              exercise.id,
            )
          : exercise.type === 'debug'
            ? onScreenOptions(exercise.fix_options, exercise.id)
            : [];
      const generated = await tutor.respond(
        {
          conceptTitle: concept?.title ?? exercise.concept,
          objectives: concept?.objectives.map((objective) => objective.text) ?? [],
          lessonSummary:
            lesson?.blocks
              .filter((block) => block.kind === 'summary')
              .map((block) => block.md)
              .join('\n') ?? '',
          exercisePrompt: exercise.prompt,
          exerciseLabel: 'Current question',
          exerciseOptions: optionTexts.map(
            ({ text }, index) => `${String.fromCharCode(65 + index)}. ${text}`,
          ),
          answerKey: tutorAnswerKeyFor(exercise, optionTexts),
          learnerAnswer: priorAttempt ? tutorAnswerFor(exercise, priorAttempt.answer) : '',
          graderVerdict: priorAttempt ? graderVerdictFor(priorAttempt.correct) : 'No prior answer.',
          graderFeedback: priorAttempt ? formatGraderFeedback(priorAttempt.feedback, retrying) : '',
          hintLevel: level,
          authoredHints: hints,
          solution: problemStatus === 'answered' ? tutorSolutionFor(exercise) : '',
          recentMistakes,
          history: [],
          problem_status: problemStatus,
          page: 'none',
          page_content: '',
        },
        level === 1 ? 'nudge' : level === 2 ? 'hint' : 'worked_step',
        index,
      );
      return generated.status === 'ok' && generated.value
        ? { kind: 'ok' as const, text: generated.value.message_md }
        : { kind: 'unavailable' as const };
    };
    return send(
      context,
      await deps.learner(context, undefined, undefined, generateHint).hint({ id, body }),
    );
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
