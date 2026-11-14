export const studyDays = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
] as const;

export type StudyDay = (typeof studyDays)[number];
export type DailyStudyMinutes = Record<StudyDay, number>;

export interface SettingsPayload {
  dailyMinutes: DailyStudyMinutes;
}
