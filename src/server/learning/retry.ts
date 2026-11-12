export function attemptAllowsRetry(attempt: {
  mode: string;
  attemptNo: number;
  correct: number;
  feedback: unknown;
}): boolean {
  const feedback = attempt.feedback as { followUp?: unknown } | null;
  return (
    attempt.mode === 'practice' &&
    attempt.attemptNo < 2 &&
    (attempt.correct === 0 || feedback?.followUp === true)
  );
}
