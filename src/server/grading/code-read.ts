import { gradeNumeric } from './numeric.js';
import { gradeText } from './text.js';
import type { CodeReadExercise, GradeResult } from './types.js';

export function gradeCodeRead(exercise: CodeReadExercise, answer: unknown): GradeResult {
  return 'answer' in exercise
    ? gradeNumeric(
        {
          id: exercise.id,
          type: 'numeric',
          dimension: exercise.dimension,
          role: exercise.role,
          difficulty: exercise.difficulty,
          est_minutes: exercise.est_minutes,
          prompt: exercise.prompt,
          hints: exercise.hints,
          solution: exercise.solution,
          answer: exercise.answer,
          tolerance: exercise.tolerance,
          ...(exercise.common_wrong ? { common_wrong: exercise.common_wrong } : {}),
        },
        answer,
      )
    : gradeText(exercise, answer);
}
