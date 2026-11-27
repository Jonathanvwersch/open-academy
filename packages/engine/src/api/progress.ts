export interface StreakPayload {
  current: number;
  longest: number;
  todayComplete: boolean;
  days: Array<{ date: string; complete: boolean }>;
}

export type ProgressMasteryState =
  | 'not_assessed'
  | 'introduced'
  | 'assisted'
  | 'independent'
  | 'retained';

export interface ProgressCoursePayload {
  id: string;
  title: string;
  topicsDone: number;
  topicsTotal: number;
  masteryCounts: Record<ProgressMasteryState, number>;
  lessonsComingSoon: number;
}

export interface ProgressSubjectPayload {
  id: string;
  title: string;
  courses: ProgressCoursePayload[];
}

export interface ProgressPayload {
  topicsDone: number;
  topicsTotal: number;
  studyTimeHours: number;
  subjects: ProgressSubjectPayload[];
  streakDays: number;
  streak: StreakPayload;
}
