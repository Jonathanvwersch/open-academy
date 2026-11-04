import { graded, numericEqual, parseNumeric } from './shared.js';
import type { GradeResult, NumericExercise } from './types.js';

export function gradeNumeric(exercise: NumericExercise, answer: unknown): GradeResult {
  const parsed = parseNumeric(answer);
  if (parsed === undefined) {
    return graded(0, 'Enter a valid number, fraction, or scientific-notation value.');
  }
  for (const commonWrong of exercise.common_wrong ?? []) {
    if (numericEqual(parsed, commonWrong.answer, commonWrong.tolerance ?? exercise.tolerance)) {
      return graded(0, commonWrong.feedback, { mistake_category: commonWrong.category });
    }
  }
  return numericEqual(parsed, exercise.answer, exercise.tolerance)
    ? graded(1, 'Correct.')
    : graded(0, 'Not quite. Review the quantities and try again.');
}
