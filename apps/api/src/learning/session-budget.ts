export type SessionKind = 'weekday' | 'saturday' | 'sunday' | 'custom';

export interface SessionPreferences {
  scheduleMinutes?: number;
  saturdayMinutes?: number;
  sundayMinutes?: number;
}

export function sessionBudget(kind: SessionKind, prefs: SessionPreferences = {}): number {
  const configured =
    kind === 'saturday'
      ? (prefs.saturdayMinutes ?? 300)
      : kind === 'sunday'
        ? (prefs.sundayMinutes ?? 60)
        : (prefs.scheduleMinutes ?? 60);
  const fallback = kind === 'saturday' ? 300 : 60;
  return Number.isFinite(configured) ? Math.max(5, Math.floor(configured)) : fallback;
}
