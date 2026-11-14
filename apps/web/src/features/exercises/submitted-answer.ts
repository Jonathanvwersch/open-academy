export interface PrefilledExerciseAnswer {
  value?: string;
  line?: string;
  selected?: string[];
}

export function prefillExerciseAnswer(
  exerciseType: string,
  answer: unknown,
): PrefilledExerciseAnswer {
  if (exerciseType === 'mc') {
    return {
      selected: Array.isArray(answer)
        ? answer.filter((value): value is string => typeof value === 'string')
        : typeof answer === 'string'
          ? [answer]
          : [],
    };
  }
  if (typeof answer === 'string' || typeof answer === 'number') {
    return { value: String(answer) };
  }
  if (typeof answer !== 'object' || answer === null || Array.isArray(answer)) {
    return {};
  }
  const savedAnswer = answer as { fixId?: unknown; line?: unknown; text?: unknown };
  return {
    ...(typeof savedAnswer.line === 'number' || typeof savedAnswer.line === 'string'
      ? { line: String(savedAnswer.line) }
      : {}),
    ...(typeof savedAnswer.text === 'string'
      ? { value: savedAnswer.text }
      : typeof savedAnswer.fixId === 'string'
        ? { value: savedAnswer.fixId }
        : {}),
  };
}
