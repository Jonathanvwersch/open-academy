import type { IndexedExercise } from '../../content/types.js';
import { answerDisplay } from '../../learning/answer-display.js';

export function graderVerdictFor(correct: number | null | undefined): string {
  if (correct === null || correct === undefined) return '';
  if (correct >= 1) return 'correct';
  if (correct === 0) return 'incorrect';
  return 'partly correct';
}

export function formatGraderFeedback(feedback: unknown, retrying: boolean): string {
  const value =
    feedback && typeof feedback === 'object' ? (feedback as Record<string, unknown>) : {};
  const lines: string[] = [];
  if (typeof value.message === 'string') lines.push(value.message);
  if (Array.isArray(value.rubric)) {
    for (const entry of value.rubric) {
      if (!entry || typeof entry !== 'object') continue;
      const judgement = (entry as Record<string, unknown>).judgement;
      const criterion = (entry as Record<string, unknown>).criterion;
      const marker =
        judgement === 'met'
          ? '✓'
          : judgement === 'partial'
            ? '½'
            : judgement === 'missing'
              ? '✗'
              : '';
      if (marker && typeof criterion === 'string') lines.push(`${marker} ${criterion}`);
    }
  }
  if (retrying) lines.push('The learner has one more try.');
  return lines.join('\n');
}

export function tutorAnswerFor(exercise: IndexedExercise, answer: unknown): string {
  if (
    exercise.type === 'explain' &&
    answer !== null &&
    typeof answer === 'object' &&
    !Array.isArray(answer) &&
    'text' in answer &&
    typeof answer.text === 'string'
  ) {
    return answer.text;
  }
  return answerDisplay(exercise, answer);
}

export function tutorSolutionFor(exercise: IndexedExercise | undefined): string {
  if (!exercise) return '';
  return exercise.type === 'explain'
    ? (exercise.solution ?? exercise.exemplar)
    : (exercise.solution ?? '');
}
