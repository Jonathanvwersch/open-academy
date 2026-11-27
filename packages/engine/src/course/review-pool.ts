import type { Exercise, ExerciseRole } from './schemas.js';
import { isTemplate } from './templates.js';

const REVIEW_POOL_ROLES = new Set<ExerciseRole>([
  'review',
  'core',
  'practice',
  'transfer',
  'basics',
]);

export const MIN_REVIEW_POOL = 5;

export function isReviewPoolExercise(exercise: Exercise): boolean {
  return REVIEW_POOL_ROLES.has(exercise.role) && !exercise.lesson_only && !isTemplate(exercise);
}
