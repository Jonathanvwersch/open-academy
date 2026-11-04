import type { Exercise } from '../content/schemas.js';
import { graded } from './shared.js';
import type { GradeResult } from './types.js';

type MultipleChoiceExercise = Extract<Exercise, { type: 'mc' }>;

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
  const feedback = selectedIds
    .map((optionId) => exercise.options.find((option) => option.id === optionId)?.feedback)
    .filter((entry): entry is string => Boolean(entry));
  if (isCorrect) {
    return graded(1, feedback.join(' ') || 'Correct.');
  }
  const selectedWrong = selectedIds
    .map((optionId) => exercise.options.find((option) => option.id === optionId))
    .find((option) => option && !option.correct);
  return graded(
    0,
    feedback.join(' ') || 'Select the option or set of options that answers the prompt.',
    {
      mistake_category: selectedWrong?.category,
    },
  );
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
