import type { Exercise } from '../../content/schemas.js';
import { gradeCodeComplete } from './code-complete.js';
import { gradeCodeRead } from './code-read.js';
import { gradeDebug } from './debug.js';
import { SelfCheckExplanationGrader } from './explain.js';
import { gradeExpression } from './expression.js';
import { gradeMultipleChoice } from './multiple-choice.js';
import { gradeNumeric } from './numeric.js';
import { gradeText } from './text.js';
import type { GradeResult, GraderOptions } from './types.js';

const selfCheckExplanationGrader = new SelfCheckExplanationGrader();

export async function gradeExercise(
  exercise: Exercise,
  answer: unknown,
  options: GraderOptions = {},
): Promise<GradeResult> {
  switch (exercise.type) {
    case 'mc':
      return gradeMultipleChoice(exercise, answer);
    case 'numeric':
      return 'answer' in exercise && typeof exercise.answer === 'number'
        ? gradeNumeric(exercise, answer)
        : {
            status: 'invalid',
            feedback: 'This problem must be instantiated before grading.',
            graded_by: 'deterministic',
          };
    case 'expression':
      return gradeExpression(exercise, answer, options);
    case 'text':
      return gradeText(exercise, answer);
    case 'code_read':
      return gradeCodeRead(exercise, answer);
    case 'code_complete':
      return gradeCodeComplete(exercise, answer);
    case 'debug':
      return gradeDebug(exercise, answer);
    case 'explain':
      return (options.explanationGrader ?? selfCheckExplanationGrader).grade(exercise, answer);
  }
}
