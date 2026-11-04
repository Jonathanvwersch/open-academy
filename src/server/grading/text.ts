import type { Exercise } from '../content/schemas.js';
import { graded, normalizeText } from './shared.js';
import type { GradeResult, TextExercise } from './types.js';

type TextLikeExercise = TextExercise | Extract<Exercise, { type: 'code_read'; accept: string[] }>;

export function gradeText(exercise: TextLikeExercise, answer: unknown): GradeResult {
  if (typeof answer !== 'string') {
    return graded(0, 'Enter a text response.');
  }
  const normalizedAnswer = normalizeText(answer);
  if (exercise.accept.some((accepted) => normalizeText(accepted) === normalizedAnswer)) {
    return graded(1, 'Correct.');
  }
  if (exercise.regex) {
    try {
      if (new RegExp(exercise.regex, 'i').test(answer)) {
        return graded(1, 'Correct.');
      }
    } catch {
      return graded(0, 'The authored answer pattern is invalid.');
    }
  }
  return graded(0, 'That response does not match an accepted answer.');
}
