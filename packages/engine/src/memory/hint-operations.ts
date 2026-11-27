import { z } from 'zod';
import type { EngineRequest, EngineResult } from '../engine/types.js';
import { respond } from '../engine/types.js';
import { hintsSincePreviousAttempt } from './hint-evidence.js';
import { attemptAllowsRetry } from './retry.js';

const hintRequest = z.object({
  exerciseId: z.string(),
  activityId: z.string().uuid().optional(),
  mode: z.enum(['practice', 'review', 'assessment', 'diagnostic']).default('practice'),
  stuck: z.boolean().default(false),
  revealSolution: z.boolean().default(false),
});

export async function hintOperation(request: EngineRequest, input: unknown): Promise<EngineResult> {
  const body = hintRequest.safeParse(input);
  if (!body.success) return respond({ error: 'Invalid hint request' }, 400);
  const id = body.data.exerciseId;
  if (body.data.mode === 'assessment' || body.data.mode === 'diagnostic') {
    return respond({ error: 'Hints are unavailable in assessment mode.' }, 403);
  }
  if (body.data.mode === 'review' && !body.data.stuck) {
    return respond({ error: 'Confirm that you are stuck before requesting review help.' }, 400);
  }
  const exercise = request.content.exercisesById.get(id);
  if (!exercise) return respond({ error: 'Exercise not found' }, 404);
  const solution = exercise.solution ?? (exercise.type === 'explain' ? exercise.exemplar : '');
  if (exercise.role === 'diagnostic') {
    return respond({ error: 'Placement check exercises do not allow hints.' }, 403);
  }
  if (body.data.activityId) {
    const [activity] = await request.store.listActivities(request.userId, {
      ids: [body.data.activityId],
    });
    const session = activity ? await request.repo.session(activity.sessionId) : undefined;
    const active = session?.activities.find((item) => item.id === body.data.activityId);
    if (!active?.exerciseIds.includes(exercise.id)) {
      return respond({ error: 'Activity or exercise not found' }, 404);
    }
    if (active.kind === 'quick_check') {
      return respond({ error: 'Assessment activities do not allow hints.' }, 403);
    }
    if (
      (active.kind === 'review' && body.data.mode !== 'review') ||
      (active.kind !== 'review' && body.data.mode !== 'practice')
    ) {
      return respond({ error: 'Hint mode does not match this activity.' }, 400);
    }
  }
  const hintsUsed = await hintsSincePreviousAttempt(
    request.store,
    request.userId,
    exercise.id,
    body.data.activityId,
  );
  const authoredHints = exercise.hints;
  if (body.data.revealSolution) {
    if (hintsUsed >= 5) return respond({ error: 'The solution has already been revealed.' }, 409);
    const event = await request.store.insertHintEvent(request.userId, {
      activityId: body.data.activityId ?? null,
      exerciseId: exercise.id,
      level: 5,
      text: solution,
      source: 'authored',
      createdAt: request.now(),
    });
    return respond({
      level: 5,
      text: solution,
      revealedSolution: true,
      hintEventId: event.id,
    });
  }
  const level = hintsUsed + 1;
  let text = authoredHints[level - 1];
  let generated = false;
  let generationDisabled = !request.tutorEnabled;
  if (!text && level <= 4 && request.tutorEnabled) {
    const recentAttempts = await request.store.listAttempts(request.userId, {
      order: 'recent',
      limit: 100,
    });
    recentAttempts.sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
    const recentMistakes = recentAttempts
      .filter((attempt) => attempt.conceptId === exercise.concept && attempt.mistakeCategory)
      .slice(0, 5)
      .map((attempt) => attempt.mistakeCategory ?? '');
    const priorAttempt = recentAttempts.find((attempt) => attempt.exerciseId === exercise.id);
    const retrying = priorAttempt ? attemptAllowsRetry(priorAttempt) : false;
    const problemStatus = !priorAttempt ? 'unanswered' : retrying ? 'retrying' : 'answered';
    const result = request.generateHint
      ? await request.generateHint({
          userId: request.userId,
          exercise,
          level,
          hints: authoredHints,
          recentMistakes,
          priorAttempt,
          retrying,
          problemStatus,
        })
      : { kind: 'disabled' as const };
    if (result.kind === 'disabled') generationDisabled = true;
    else if (result.kind === 'ok') {
      text = result.text;
      generated = true;
    } else {
      return respond({
        level,
        hasMore: false,
        revealedSolution: false,
        tutorUnavailable: true,
      });
    }
  }
  if (!text && generationDisabled) {
    return respond({
      level,
      hasMore: level < authoredHints.length,
      revealedSolution: false,
    });
  }
  if (!text || level > 4) return respond({ level, hasMore: false, revealedSolution: false });
  const event = await request.store.insertHintEvent(request.userId, {
    activityId: body.data.activityId ?? null,
    exerciseId: exercise.id,
    level,
    text,
    source: generated ? 'llm' : 'authored',
    createdAt: request.now(),
  });
  return respond({
    level,
    text,
    hasMore: request.tutorEnabled
      ? level < Math.max(authoredHints.length, 4)
      : level < authoredHints.length,
    revealedSolution: false,
    hintEventId: event.id,
  });
}
