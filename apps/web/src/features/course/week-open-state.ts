export type WeekOpenOverrides = Record<number, boolean>;

export const COURSE_WEEK_OPEN_STORAGE_KEY = 'course:weeks-open';

export function isWeekOpen(
  week: number,
  currentWeek: number,
  overrides: WeekOpenOverrides,
): boolean {
  return overrides[week] ?? week === currentWeek;
}

export function readCourseWeekOpenOverrides(): WeekOpenOverrides {
  if (typeof window === 'undefined') return {};
  try {
    const stored = window.localStorage.getItem(COURSE_WEEK_OPEN_STORAGE_KEY);
    if (!stored) return {};
    const parsed: unknown = JSON.parse(stored);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).flatMap(([week, open]) =>
        /^\d+$/.test(week) && typeof open === 'boolean' ? [[Number(week), open]] : [],
      ),
    );
  } catch {
    return {};
  }
}

export function writeCourseWeekOpenOverrides(overrides: WeekOpenOverrides): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(COURSE_WEEK_OPEN_STORAGE_KEY, JSON.stringify(overrides));
  } catch {
    return;
  }
}
