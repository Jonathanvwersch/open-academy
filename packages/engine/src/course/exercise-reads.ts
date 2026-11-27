import type { EngineRequest, EngineResult } from '../engine/types.js';
import { respond } from '../engine/types.js';
import { serializeExercise } from './serialize.js';
import { isTemplate } from './templates.js';

export function readExercise(request: EngineRequest, id: string): EngineResult {
  const exercise = request.content.exercisesById.get(id);
  if (exercise && isTemplate(exercise)) {
    return respond({ error: 'Template exercises are only available through a lesson run.' }, 400);
  }
  return exercise
    ? respond(serializeExercise(exercise, request.userId))
    : respond({ error: 'Exercise not found' }, 404);
}
