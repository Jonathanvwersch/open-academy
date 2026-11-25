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
    const hasRequiredCriteria = exercise.rubric.some(({ required }) => required);
    const scoringCriteria = hasRequiredCriteria
      ? exercise.rubric.filter(({ required }) => required)
      : exercise.rubric;
    const everyScoredCriterionSelected =
      scoringCriteria.length > 0 && scoringCriteria.every(({ id }) => selected.has(id));
    const anyCriterionSelected = exercise.rubric.some(({ id }) => selected.has(id));
    const correctness = everyScoredCriterionSelected ? 1 : anyCriterionSelected ? 0.5 : 0;
    return graded(
      correctness,
      correctness === 1
        ? 'Your self-check selected every scored criterion.'
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
