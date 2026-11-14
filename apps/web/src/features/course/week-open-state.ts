export type UnitOpenOverrides = Record<string, boolean>;

export const COURSE_UNIT_OPEN_STORAGE_KEY = 'course:units-open';

export function isUnitOpen(
  courseId: string,
  unit: number,
  currentUnit: number,
  overrides: UnitOpenOverrides,
): boolean {
  return overrides[`${courseId}:${unit}`] ?? unit === currentUnit;
}

export function readCourseUnitOpenOverrides(): UnitOpenOverrides {
  if (typeof window === 'undefined') return {};
  try {
    const stored = window.localStorage.getItem(COURSE_UNIT_OPEN_STORAGE_KEY);
    if (!stored) return {};
    const parsed: unknown = JSON.parse(stored);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).flatMap(([courseUnit, open]) =>
        /^.+:\d+$/.test(courseUnit) && typeof open === 'boolean' ? [[courseUnit, open]] : [],
      ),
    );
  } catch {
    return {};
  }
}

export function writeCourseUnitOpenOverrides(overrides: UnitOpenOverrides): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(COURSE_UNIT_OPEN_STORAGE_KEY, JSON.stringify(overrides));
  } catch {
    return;
  }
}
