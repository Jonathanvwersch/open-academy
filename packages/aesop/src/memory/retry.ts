export function attemptAllowsRetry(attempt: {
  mode: string;
  attemptNo: number;
  correct: number;
  feedback: unknown;
}): boolean {
  const feedback = attempt.feedback as { followUp?: unknown } | null;
  if (attempt.attemptNo >= 2) return false;
  return (
    (attempt.mode === 'practice' && attempt.correct === 0) ||
    ((attempt.mode === 'practice' || attempt.mode === 'review') && feedback?.followUp === true)
  );
}
