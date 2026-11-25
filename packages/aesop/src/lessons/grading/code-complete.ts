import { graded } from './shared.js';
import type { CodeCompleteExercise, GradeResult } from './types.js';

export function normalizeCode(value: string): string {
  return value.replace(/['"]/g, '"').replace(/\s+/g, '');
}

export function gradeCodeComplete(exercise: CodeCompleteExercise, answer: unknown): GradeResult {
  if (typeof answer !== 'string') {
    return graded(0, 'Enter code for the blank.');
  }
  const normalizedAnswer = normalizeCode(answer);
  return exercise.accept.some((accepted) => normalizeCode(accepted) === normalizedAnswer)
    ? graded(1, 'Correct.')
    : graded(0, 'That code does not match an accepted variant.');
}
