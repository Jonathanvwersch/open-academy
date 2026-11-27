import { serializedOptionOrder, serializeExercise } from '@academy/aesop/course/serialize';
import { isTemplate } from '@academy/aesop/course/templates';
import type { IndexedExercise } from '@academy/aesop/course/types';
import { hintsSincePreviousAttempt } from '@academy/aesop/memory/hint-evidence';
import { attemptAllowsRetry } from '@academy/aesop/memory/retry';
import { onScreenOptions } from '@academy/shared/shuffle';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { drizzleLearnerStore } from '../../db/learner-store.js';
import { attempts, hintEvents, sessionActivities } from '../../db/schema.js';
import { type FeatureRequest, type FeatureServices, serviceResult } from '../../service-context.js';
import {
  formatGraderFeedback,
  graderVerdictFor,
  tutorAnswerFor,
  tutorAnswerKeyFor,
  tutorSolutionFor,
} from '../tutor/feedback-context.js';

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
  const saveHintEvent = (input: {
    activityId?: string;
    exerciseId: string;
    level: number;
    text: string;
    source?: 'authored' | 'llm';
    createdAt: Date;
  }) =>
    db
      .insert(hintEvents)
      .values({
        userId: request.userId,
        activityId: input.activityId,
        exerciseId: input.exerciseId,
        level: input.level,
        source: input.source ?? 'authored',
        text: input.text,
        createdAt: input.createdAt,
      })
      .returning();
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
    const [event] = await saveHintEvent({
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
    const recentAttempts = await db
      .select()
      .from(attempts)
      .where(eq(attempts.userId, request.userId))
      .orderBy(desc(attempts.createdAt))
      .limit(100);
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
  const [event] = await saveHintEvent({
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
