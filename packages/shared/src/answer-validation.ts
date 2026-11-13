export function emptyAnswerMessage(type: string, answer: unknown): string | null {
  if (type === 'mc') {
    const selections = Array.isArray(answer) ? answer : [answer];
    return selections.some((selection) => typeof selection === 'string' && selection.trim())
      ? null
      : 'Choose an answer first.';
  }

  if (type === 'debug') {
    if (typeof answer !== 'object' || answer === null) return 'Write an answer first.';
    const fields = answer as { line?: unknown; fixId?: unknown };
    const hasLine =
      (typeof fields.line === 'number' && Number.isInteger(fields.line) && fields.line > 0) ||
      (typeof fields.line === 'string' && Boolean(fields.line.trim()));
    const hasFix = typeof fields.fixId === 'string' && Boolean(fields.fixId.trim());
    return hasLine && hasFix ? null : 'Write an answer first.';
  }

  if (type === 'explain') {
    const text =
      typeof answer === 'object' && answer !== null && 'text' in answer ? answer.text : answer;
    return typeof text === 'string' && text.trim() ? null : 'Write an answer first.';
  }

  if (typeof answer === 'string') {
    return answer.trim() ? null : 'Write an answer first.';
  }
  if (typeof answer === 'number') {
    return Number.isFinite(answer) ? null : 'Write an answer first.';
  }
  return 'Write an answer first.';
}
