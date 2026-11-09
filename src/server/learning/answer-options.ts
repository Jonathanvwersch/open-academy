import type { IndexedExercise } from '../content/types.js';

export interface AnswerOptions {
  selected: string[];
  correct?: string[];
}

export function answerOptionsFor(
  exercise: IndexedExercise,
  answer: unknown,
  revealCorrect: boolean,
): AnswerOptions | undefined {
  if (exercise.type === 'mc') {
    const submitted = Array.isArray(answer) ? answer : [answer];
    const selected = submitted.filter((id): id is string => typeof id === 'string');
    return revealCorrect
      ? {
          selected,
          correct: exercise.options.filter((option) => option.correct).map(({ id }) => id),
        }
      : { selected };
  }

  if (exercise.type === 'debug') {
    const submitted =
      typeof answer === 'object' && answer !== null
        ? (answer as { line?: unknown; fixId?: unknown })
        : {};
    const selected = [
      typeof submitted.line === 'number' || typeof submitted.line === 'string'
        ? `line:${submitted.line}`
        : undefined,
      typeof submitted.fixId === 'string' ? `fix:${submitted.fixId}` : undefined,
    ].filter((option): option is string => option !== undefined);
    if (!revealCorrect) return { selected };
    return {
      selected,
      correct: [
        `line:${exercise.buggy_line}`,
        ...exercise.fix_options.filter((option) => option.correct).map(({ id }) => `fix:${id}`),
      ],
    };
  }

  return undefined;
}
