import type { Exercise } from '@open-academy/engine/course/schemas';
import { scoreRubricCriteria } from '@open-academy/engine/lessons/grading/rubric-score';
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
