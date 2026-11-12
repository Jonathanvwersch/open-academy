import type { Exercise } from '../content/schemas.js';
import { graded } from './shared.js';
import type { GradeResult } from './types.js';

type MultipleChoiceExercise = Extract<Exercise, { type: 'mc' }>;

export const MULTIPLE_CHOICE_FALLBACK_FEEDBACK = 'Review the options and try again.';

export function gradeMultipleChoice(
  exercise: MultipleChoiceExercise,
  answer: unknown,
): GradeResult {
  const selectedIds = selectedOptionIds(answer);
  const correctIds = exercise.options
    .filter((option) => option.correct)
    .map((option) => option.id)
    .sort();
  const isCorrect =
    selectedIds.length === correctIds.length &&
    selectedIds.every((optionId, index) => optionId === correctIds[index]);
  if (isCorrect) {
    const feedback = selectedIds
      .map((optionId) => exercise.options.find((option) => option.id === optionId)?.feedback)
      .filter((entry): entry is string => Boolean(entry));
    return graded(1, feedback.join(' ') || 'Correct.');
  }
  const selectedWrong = selectedIds
    .map((optionId) => exercise.options.find((option) => option.id === optionId))
    .filter((option) => option && !option.correct);
  const feedback = selectedWrong
    .map((option) => option?.feedback)
    .filter((entry): entry is string => Boolean(entry));
  if (exercise.multi) {
    const missedCount = correctIds.filter((id) => !selectedIds.includes(id)).length;
    if (missedCount > 0) {
      feedback.push(`You missed ${missedCount} correct option${missedCount === 1 ? '' : 's'}.`);
    }
  }
  return graded(0, feedback.join(' ') || MULTIPLE_CHOICE_FALLBACK_FEEDBACK, {
    mistake_category: selectedWrong[0]?.category,
  });
}

function selectedOptionIds(answer: unknown): string[] {
  if (typeof answer === 'string') {
    return [answer];
  }
  if (Array.isArray(answer)) {
    return [
      ...new Set(answer.filter((entry): entry is string => typeof entry === 'string')),
    ].sort();
  }
  return [];
}
