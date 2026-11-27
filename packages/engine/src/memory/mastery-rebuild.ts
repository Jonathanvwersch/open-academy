import type { Dimension } from '../course/schemas.js';
import { DefaultMasteryModel } from './mastery.js';
import { initialMastery, type MasteryAttemptEvidence, type MasteryRecord } from './types.js';

export function rebuildMasteryFromEvidence(
  conceptId: string,
  dimension: Dimension,
  evidence: readonly MasteryAttemptEvidence[],
): MasteryRecord {
  const model = new DefaultMasteryModel();
  let record = initialMastery(conceptId, dimension);
  for (const attempt of [...evidence].sort(
    (left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt),
  )) {
    record = model.applyAttempt(
      record,
      {
        conceptId,
        dimension,
        attemptId: attempt.attemptId,
        exerciseId: attempt.exerciseId,
        correct: attempt.correct,
        hintsUsed: attempt.hintsUsed,
        attemptNo: attempt.attemptNo,
        mode: attempt.mode,
        itemRole: attempt.itemRole,
        gradedBy: attempt.gradedBy,
        followUp: attempt.correct > 0 && attempt.credit === 0,
      },
      new Date(attempt.createdAt),
    ).mastery;
  }
  return record;
}
