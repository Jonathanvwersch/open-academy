import type { Exercise } from '../../course/schemas.js';
import { graded, normalizeText } from './shared.js';
import type { GradeResult, TextExercise } from './types.js';

type TextLikeExercise = TextExercise | Extract<Exercise, { type: 'code_read'; accept: string[] }>;

export function gradeText(exercise: TextLikeExercise, answer: unknown): GradeResult {
  if (typeof answer !== 'string') {
    return graded(0, 'Enter a text response.');
  }
  const candidates = [answer];
  const withoutTrailingPunctuation = answer.replace(/[\s.!。]+$/u, '');
  if (withoutTrailingPunctuation !== answer) {
    candidates.push(withoutTrailingPunctuation);
  }
  if (
    candidates.some((candidate) =>
      exercise.accept.some((accepted) => normalizeText(accepted) === normalizeText(candidate)),
    )
  ) {
    return graded(1, 'Correct.');
  }
  if (exercise.regex) {
    try {
      const pattern = new RegExp(exercise.regex, 'i');
      if (candidates.some((candidate) => pattern.test(candidate))) {
        return graded(1, 'Correct.');
      }
    } catch {
      return graded(0, 'The authored answer pattern is invalid.');
    }
  }
  return graded(0, 'That response does not match an accepted answer.');
}
