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
        feedback: 'Read your explanation, then select the criteria it meets.',
        graded_by: 'self',
        rubric: exercise.rubric.map(({ id, criterion, required }) => ({
          id,
          criterion,
          required,
        })),
      };
    }

    const selected = new Set(metCriteria);
    const totalWeight = exercise.rubric.reduce((total, criterion) => total + criterion.weight, 0);
    const earnedWeight = exercise.rubric.reduce(
      (total, criterion) => total + (selected.has(criterion.id) ? criterion.weight : 0),
      0,
    );
    const requiredMet = exercise.rubric
      .filter((criterion) => criterion.required)
      .every((criterion) => selected.has(criterion.id));
    const score = totalWeight === 0 ? 0 : earnedWeight / totalWeight;
    const correctness = requiredMet && score === 1 ? 1 : score > 0 ? 0.5 : 0;
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
