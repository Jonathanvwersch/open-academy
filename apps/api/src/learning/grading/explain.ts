import { type RubricJudgementValue, scoreRubricCriteria } from './rubric-score.js';
import { graded } from './shared.js';
import type { ExplainExercise, ExplanationGrader, GradeResult } from './types.js';

export class SelfCheckExplanationGrader implements ExplanationGrader {
  async grade(exercise: ExplainExercise, answer: unknown): Promise<GradeResult> {
    const answerRecord = isRecord(answer) ? answer : {};
    const metCriteria = Array.isArray(answerRecord.metCriteria)
      ? answerRecord.metCriteria.filter((entry): entry is string => typeof entry === 'string')
      : undefined;
    if (!metCriteria) {
      return {
        status: 'self_check_required',
        feedback: 'Review the model answer, then check which ideas your answer included.',
        graded_by: 'self',
        rubric: exercise.rubric.map(({ id, criterion, required }) => ({
          id,
          criterion,
          required,
        })),
      };
    }

    const selected = new Set(metCriteria);
    const score = scoreRubricCriteria(
      exercise.rubric,
      new Map<string, RubricJudgementValue>(
        exercise.rubric.map((criterion) => [
          criterion.id,
          selected.has(criterion.id) ? 'met' : 'missing',
        ]),
      ),
    );
    const correctness = score === 1 ? 1 : score > 0 ? 0.5 : 0;
    return graded(
      correctness,
      correctness === 1
        ? 'Your self-check selected every rubric criterion.'
        : 'Compare your explanation with the criteria you did not select.',
      {
        graded_by: 'self',
        credit: Math.min(0.5, correctness),
      },
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
