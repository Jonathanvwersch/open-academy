export function isLessonRetryReady(
  retryAfter: Date | string | null | undefined,
  hasOpenFlags: boolean,
  now: Date,
): boolean {
  if (hasOpenFlags) return false;
  if (retryAfter === null || retryAfter === undefined) return true;
  const retryDate = typeof retryAfter === 'string' ? new Date(retryAfter) : retryAfter;
  return retryDate <= now;
}
