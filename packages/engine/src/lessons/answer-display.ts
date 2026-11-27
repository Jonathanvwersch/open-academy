import { formatTemplateNumber } from '../course/templates.js';
import type { IndexedExercise } from '../course/types.js';

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

export function correctAnswerDisplay(exercise: IndexedExercise): string {
  if (exercise.type === 'mc') {
    return exercise.options
      .filter((option) => option.correct)
      .map((option) => option.text)
      .join('\n');
  }
  if (exercise.type === 'numeric') {
    return 'answer' in exercise ? formatTemplateNumber(exercise.answer) : '';
  }
  if ('answer' in exercise) return answerText(exercise.answer);
  if ('accept' in exercise) return exercise.accept.join(', ');
  if (exercise.type === 'explain') return exercise.exemplar;
  if (exercise.type === 'debug') {
    return exercise.fix_options
      .filter((option) => option.correct)
      .map((option) => option.text)
      .join('\n');
  }
  return '';
}
