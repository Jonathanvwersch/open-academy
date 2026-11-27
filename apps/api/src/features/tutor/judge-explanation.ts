import type { EngineJudgeExplanation } from '@open-academy/engine/engine/create-engine';
import type { TutorService } from './service.js';

export function judgeExplanation(tutor: TutorService | null): EngineJudgeExplanation {
  return async (input) => {
    if (!tutor) return { reason: 'Tutor grading is disabled.' };
    try {
      const result = await tutor.gradeExplanation(input);
      if (result.status === 'ok' && result.value) return { judgement: result.value };
      return {
        reason:
          result.status === 'budget_exceeded'
            ? 'Tutor grading limit reached.'
            : 'Tutor grading failed.',
      };
    } catch {
      return { reason: 'Tutor grading failed.' };
    }
  };
}
