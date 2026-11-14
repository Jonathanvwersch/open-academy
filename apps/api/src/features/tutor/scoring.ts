import type { Exercise } from '../../content/schemas.js';
import type { RubricJudgement } from './schemas.js';

type ExplainExercise = Extract<Exercise, { type: 'explain' }>;

export function scoreRubric(
  rubric: ExplainExercise['rubric'],
  judgement: RubricJudgement,
): { score: number; feedback: string } {
  const byId = new Map(judgement.criteria.map((entry) => [entry.id, entry]));
  if (
    rubric.some(
      (criterion) =>
        criterion.required && (byId.get(criterion.id)?.judgement ?? 'missing') === 'missing',
    )
  ) {
    return { score: 0, feedback: judgement.feedback_md };
  }
  const total = rubric.reduce((sum, criterion) => sum + criterion.weight, 0);
  const earned = rubric.reduce((sum, criterion) => {
    const value = byId.get(criterion.id)?.judgement;
    return sum + criterion.weight * (value === 'met' ? 1 : value === 'partial' ? 0.5 : 0);
  }, 0);
  return { score: total === 0 ? 0 : earned / total, feedback: judgement.feedback_md };
}
