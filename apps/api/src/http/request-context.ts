export function shiftLocalDate(localDate: string, days: number): string {
  const date = new Date(`${localDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function localDateDifference(from: string, to: string): number {
  if (from === to) return 0;
  const direction = from < to ? 1 : -1;
  let days = 0;
  let current = from;
  while (current !== to && Math.abs(days) < 36_600) {
    current = shiftLocalDate(current, direction);
    days += direction;
  }
  return days;
}

export function isValidTimeZone(value: string | undefined): value is string {
  if (!value || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export function requestNow(context: { req: { header(name: string): string | undefined } }): Date {
  if (process.env.NODE_ENV === 'test') {
    const override = context.req.header('X-Now') ?? process.env.NOW_OVERRIDE;
    if (override) {
      const parsed = new Date(override);
      if (Number.isFinite(parsed.getTime())) {
        return parsed;
      }
    }
  }
  return new Date();
}
