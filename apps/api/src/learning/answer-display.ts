import { formatTemplateNumber } from '../content/templates.js';
import type { IndexedExercise } from '../content/types.js';

export function answerText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return formatTemplateNumber(value);
  if (Array.isArray(value)) return value.map(answerText).join(', ');
  if (value && typeof value === 'object') return JSON.stringify(value);
  return '';
}

export function answerDisplay(exercise: IndexedExercise, answer: unknown): string {
  if (exercise.type === 'mc') {
    const ids = Array.isArray(answer) ? answer : [answer];
    return ids
      .map((id) => exercise.options.find((option) => option.id === id)?.text ?? answerText(id))
      .join('\n');
  }
  if (exercise.type === 'numeric') {
    const numeric = typeof answer === 'number' ? answer : Number(answer);
    return Number.isFinite(numeric) ? formatTemplateNumber(numeric) : answerText(answer);
  }
  return answerText(answer);
}
