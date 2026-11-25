import { serializedOptionOrder, serializeExercise } from '@academy/aesop/course/serialize';
import { isTemplate } from '@academy/aesop/course/templates';
import type { IndexedExercise } from '@academy/aesop/course/types';
import { answerOptionsFor } from '@academy/aesop/lessons/answer-options';
import { gradeExercise } from '@academy/aesop/lessons/grading/index';
import { rubricFeedbackWithScoredFlags } from '@academy/aesop/lessons/grading/rubric-score';
import {
  prepareExerciseAttempt,
  recordExerciseAttempt,
} from '@academy/aesop/memory/exercise-attempts';
import { hintsSincePreviousAttempt } from '@academy/aesop/memory/hint-evidence';
import { attemptAllowsRetry } from '@academy/aesop/memory/retry';
import type { AttemptResponse } from '@academy/contracts/exercises';
import { emptyAnswerMessage } from '@academy/shared/answer-validation';
import { onScreenOptions } from '@academy/shared/shuffle';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { drizzleLearnerStore } from '../../db/learner-store.js';
import { sessionActivities } from '../../db/schema.js';
import { fsrsFuzzEnabled } from '../../learning/fsrs-fuzz.js';
import { type FeatureRequest, type FeatureServices, serviceResult } from '../../service-context.js';
import {
  formatGraderFeedback,
  graderVerdictFor,
  tutorAnswerFor,
  tutorAnswerKeyFor,
  tutorSolutionFor,
} from '../tutor/feedback-context.js';
import { scoreRubric } from '../tutor/scoring.js';

type TutorGradeResult = {
  status: 'graded';
  correct: number;
  feedback: string;
  graded_by: 'llm';
  mistake_category?: string;
  rubric: Array<{
    id: string;
    criterion: string;
    judgement: 'met' | 'partial' | 'missing';
    required: boolean;
  }>;
  exemplar: string;
};

export async function getExercisesById(deps: FeatureServices, request: FeatureRequest) {
  const { content } = deps;
  const exercise = (await content()).exercisesById.get(request.params.id);
  if (exercise && isTemplate(exercise)) {
    return serviceResult(
      { error: 'Template exercises are only available through a lesson run.' },
      400,
    );
  }
  return exercise
    ? serviceResult(serializeExercise(exercise, request.userId))
    : serviceResult({ error: 'Exercise not found' }, 404);
}

export async function postHints(deps: FeatureServices, request: FeatureRequest) {
  const { db, content, tutorProvider } = deps;
  const body = z
    .object({
      exerciseId: z.string(),
      activityId: z.string().uuid().optional(),
      mode: z.enum(['practice', 'review', 'assessment', 'diagnostic']).default('practice'),
      stuck: z.boolean().default(false),
      revealSolution: z.boolean().default(false),
    })
    .safeParse(request.body);
  if (!body.success) {
    return serviceResult({ error: 'Invalid hint request' }, 400);
  }
  if (body.data.mode === 'assessment' || body.data.mode === 'diagnostic') {
    return serviceResult({ error: 'Hints are unavailable in assessment mode.' }, 403);
  }
  if (body.data.mode === 'review' && !body.data.stuck) {
    return serviceResult(
      { error: 'Confirm that you are stuck before requesting review help.' },
      400,
    );
  }
  const exercise = (await content()).exercisesById.get(body.data.exerciseId);
  if (!exercise) {
    return serviceResult({ error: 'Exercise not found' }, 404);
  }
  const solution = exercise.solution ?? (exercise.type === 'explain' ? exercise.exemplar : '');
  if (exercise.role === 'diagnostic') {
    return serviceResult({ error: 'Placement check exercises do not allow hints.' }, 403);
  }
  if (body.data.activityId) {
    const [activityRow] = await db
      .select()
      .from(sessionActivities)
      .where(eq(sessionActivities.id, body.data.activityId))
      .limit(1);
    const session = activityRow ? await request.repo.session(activityRow.sessionId) : undefined;
    const activity = session?.activities.find((item) => item.id === body.data.activityId);
    if (!activity?.exerciseIds.includes(exercise.id)) {
      return serviceResult({ error: 'Activity or exercise not found' }, 404);
    }
    if (activity.kind === 'quick_check') {
      return serviceResult({ error: 'Assessment activities do not allow hints.' }, 403);
    }
    if (
      (activity.kind === 'review' && body.data.mode !== 'review') ||
      (activity.kind !== 'review' && body.data.mode !== 'practice')
    ) {
      return serviceResult({ error: 'Hint mode does not match this activity.' }, 400);
    }
  }
  const hintsUsed = await hintsSincePreviousAttempt(
    drizzleLearnerStore(db),
    request.userId,
    exercise.id,
    body.data.activityId,
  );
  const hints = (exercise as IndexedExercise & { hints?: string[] }).hints ?? [];
  if (body.data.revealSolution) {
    if (hintsUsed >= 5)
      return serviceResult({ error: 'The solution has already been revealed.' }, 409);
    const [event] = await request.repo.saveHintEvent({
      activityId: body.data.activityId,
      exerciseId: exercise.id,
      level: 5,
      text: solution,
      createdAt: request.now(),
    });
    return serviceResult({
      level: 5,
      text: solution,
      revealedSolution: true,
      hintEventId: event?.id,
    });
  }
  const level = hintsUsed + 1;
  let text = hints[level - 1];
  let generated = false;
  if (!text && level <= 4 && tutorProvider) {
    const index = await content();
    const concept = index.conceptsById.get(exercise.concept);
    const lesson = index.lessonsByConcept.get(exercise.concept);
    const recentAttempts = await request.repo.recentAttempts(100);
    const recentMistakes = recentAttempts
      .filter((attempt) => attempt.conceptId === exercise.concept && attempt.mistakeCategory)
      .slice(0, 5)
      .map((attempt) => attempt.mistakeCategory ?? '');
    const priorAttempt = recentAttempts.find((attempt) => attempt.exerciseId === exercise.id);
    const retrying = priorAttempt ? attemptAllowsRetry(priorAttempt) : false;
    const problemStatus = !priorAttempt ? 'unanswered' : retrying ? 'retrying' : 'answered';
    const tutorService = request.tutor;
    if (!tutorService) {
      return serviceResult({
        level,
        hasMore: level < hints.length,
        revealedSolution: false,
      });
    }
    const optionTexts =
      exercise.type === 'mc'
        ? onScreenOptions(
            serializedOptionOrder(exercise.options, request.userId, exercise.id),
            exercise.id,
          )
        : exercise.type === 'debug'
          ? onScreenOptions(exercise.fix_options, exercise.id)
          : [];
    const generatedHint = await tutorService.respond(
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
    if (generatedHint.status === 'ok' && generatedHint.value) {
      text = generatedHint.value.message_md;
      generated = true;
    } else {
      return serviceResult({
        level,
        hasMore: false,
        revealedSolution: false,
        tutorUnavailable: true,
      });
    }
  }
  if (!text && !tutorProvider) {
    return serviceResult({
      level,
      hasMore: level < hints.length,
      revealedSolution: false,
    });
  }
  if (!text || level > 4) {
    return serviceResult({ level, hasMore: false, revealedSolution: false });
  }
  const [event] = await request.repo.saveHintEvent({
    activityId: body.data.activityId,
    exerciseId: exercise.id,
    level,
    text,
    source: generated ? 'llm' : 'authored',
    createdAt: request.now(),
  });
  return serviceResult({
    level,
    text,
    hasMore: tutorProvider ? level < Math.max(hints.length, 4) : level < hints.length,
    revealedSolution: false,
    hintEventId: event?.id,
  });
}

export async function postAttempts(deps: FeatureServices, request: FeatureRequest) {
  const { db, content, tutorProvider } = deps;
  const body = z
    .object({
      exerciseId: z.string(),
      activityId: z.string().uuid().optional(),
      answer: z.unknown(),
      mode: z.enum(['practice', 'assessment', 'diagnostic', 'review']).default('practice'),
      durationMs: z.number().int().nonnegative().optional(),
    })
    .safeParse(request.body);
  if (!body.success) {
    return serviceResult({ error: 'Invalid attempt' }, 400);
  }
  const index = await content();
  const exercise = index.exercisesById.get(body.data.exerciseId);
  if (!exercise) {
    return serviceResult({ error: 'Exercise not found' }, 404);
  }
  const emptyMessage = emptyAnswerMessage(exercise.type, body.data.answer);
  if (emptyMessage) return serviceResult({ error: emptyMessage }, 422);
  if (isTemplate(exercise)) {
    return serviceResult(
      { error: 'Template exercises must be answered through a lesson run.' },
      400,
    );
  }
  const { repo, userId, timeZone } = request;
  const store = drizzleLearnerStore(db);
  const prepared = await prepareExerciseAttempt(store, userId, index, exercise, body.data, (id) =>
    repo.session(id),
  );
  if (prepared.kind !== 'ready') {
    return serviceResult(
      prepared.body,
      prepared.kind === 'not_found' ? 404 : prepared.kind === 'conflict' ? 409 : 400,
    );
  }
  const random = () => Math.random();
  let result: Awaited<ReturnType<typeof gradeExercise>> | TutorGradeResult;
  if (
    exercise.type === 'explain' &&
    tutorProvider &&
    typeof body.data.answer === 'object' &&
    body.data.answer !== null &&
    'text' in body.data.answer &&
    typeof body.data.answer.text === 'string'
  ) {
    const tutorService = request.tutor;
    const judged = tutorService
      ? await tutorService.gradeExplanation({
          question: exercise.prompt,
          rubric: exercise.rubric,
          exemplar: exercise.exemplar,
          answer: body.data.answer.text,
        })
      : { status: 'fallback' as const };
    if (judged.status === 'ok' && judged.value) {
      const score = scoreRubric(exercise.rubric, judged.value);
      result = {
        status: 'graded' as const,
        correct: score.score,
        feedback: score.feedback,
        graded_by: 'llm' as const,
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
    } else {
      result = await gradeExercise(exercise, body.data.answer, { random });
    }
  } else {
    result = await gradeExercise(exercise, body.data.answer, { random });
  }
  const rubricForFeedback =
    exercise.type === 'explain' && 'rubric' in result && Array.isArray(result.rubric)
      ? rubricFeedbackWithScoredFlags(exercise.rubric, result.rubric)
      : undefined;
  if (result.status !== 'graded') {
    return serviceResult(
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
      newId: () => crypto.randomUUID(),
      enableFsrsFuzz: fsrsFuzzEnabled(),
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
    timeZone,
  );
  const answerWithheld = attempt.retryAllowed;
  const answerOptions = answerOptionsFor(exercise, body.data.answer, !answerWithheld);
  const resultForResponse: Record<string, unknown> = { ...result };
  if (answerWithheld) {
    delete resultForResponse.exemplar;
    delete resultForResponse.solution;
  }
  return serviceResult({
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
  } satisfies AttemptResponse);
}
