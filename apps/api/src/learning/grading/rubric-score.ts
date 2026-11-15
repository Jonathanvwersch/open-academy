export type RubricJudgementValue = 'met' | 'partial' | 'missing';

export interface ScoredRubricCriterion {
  id: string;
  weight: number;
  required: boolean;
}

export function scoreRubricCriteria(
  rubric: readonly ScoredRubricCriterion[],
  judgements: ReadonlyMap<string, RubricJudgementValue>,
): number {
  if (
    rubric.some((criterion) => criterion.required && judgements.get(criterion.id) === 'missing')
  ) {
    return 0;
  }
  const scoringCriteria = rubric.some((criterion) => criterion.required)
    ? rubric.filter((criterion) => criterion.required)
    : rubric;
  const total = scoringCriteria.reduce((sum, criterion) => sum + criterion.weight, 0);
  const earned = scoringCriteria.reduce((sum, criterion) => {
    const judgement = judgements.get(criterion.id);
    return sum + criterion.weight * (judgement === 'met' ? 1 : judgement === 'partial' ? 0.5 : 0);
  }, 0);
  return total === 0 ? 0 : earned / total;
}

export function rubricFeedbackWithScoredFlags<T extends { id: string; required?: boolean }>(
  authoredRubric: readonly { id: string; required: boolean }[],
  feedbackRubric: readonly T[],
): Array<T & { required: boolean }> {
  const anyRequired = authoredRubric.some((criterion) => criterion.required);
  const scoringFlags = new Map(
    authoredRubric.map((criterion) => [criterion.id, !anyRequired || criterion.required]),
  );
  return feedbackRubric.map((item) => ({
    ...item,
    required: scoringFlags.get(item.id) ?? item.required ?? false,
  }));
}
