import type { Exercise } from '../../content/schemas.js';
import { scoreRubricCriteria } from '../../learning/grading/rubric-score.js';
import type { RubricJudgement } from './schemas.js';

type ExplainExercise = Extract<Exercise, { type: 'explain' }>;

export function scoreRubric(
  rubric: ExplainExercise['rubric'],
  judgement: RubricJudgement,
): { score: number; feedback: string } {
  const score = scoreRubricCriteria(
    rubric,
    new Map(judgement.criteria.map((entry) => [entry.id, entry.judgement])),
  );
  return { score, feedback: judgement.feedback_md };
}
