import { type DailyStudyMinutes, studyDays } from '@academy/aesop/api/settings';

export type SessionKind = 'weekday' | 'saturday' | 'sunday' | 'custom';

export interface SessionPreferences {
  dailyMinutes?: DailyStudyMinutes;
  scheduleMinutes?: number;
  saturdayMinutes?: number;
  sundayMinutes?: number;
}

export function sessionBudget(
  kind: SessionKind,
  prefs: SessionPreferences = {},
  localDate?: string,
): number {
  const dayIndex = localDate
    ? (new Date(`${localDate}T00:00:00.000Z`).getUTCDay() + 6) % 7
    : undefined;
  const day = dayIndex === undefined ? undefined : studyDays[dayIndex];
  const dailyMinutes = day && kind !== 'custom' ? prefs.dailyMinutes?.[day] : undefined;
  const configured =
    dailyMinutes ??
    (kind === 'saturday'
      ? (prefs.saturdayMinutes ?? 300)
      : kind === 'sunday'
        ? (prefs.sundayMinutes ?? 60)
        : (prefs.scheduleMinutes ?? 60));
  const fallback = kind === 'saturday' ? 300 : 60;
  return Number.isFinite(configured) ? Math.max(5, Math.floor(configured)) : fallback;
}

export function dailyStudyMinutes(prefs: SessionPreferences = {}): DailyStudyMinutes {
  return Object.fromEntries(
    studyDays.map((day) => [
      day,
      Math.max(
        5,
        Math.floor(
          prefs.dailyMinutes?.[day] ??
            sessionBudget(
              day === 'saturday' ? 'saturday' : day === 'sunday' ? 'sunday' : 'weekday',
              prefs,
            ),
        ),
      ),
    ]),
  ) as DailyStudyMinutes;
}
