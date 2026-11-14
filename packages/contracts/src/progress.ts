export interface StreakPayload {
  current: number;
  longest: number;
  todayComplete: boolean;
  days: Array<{ date: string; complete: boolean }>;
}

export interface ProgressPayload {
  domains: Array<{ id: string; title: string; counts: Record<string, number> }>;
  goal: { mastered: number; total: number };
  hours: number;
  planHours: number;
  streakDays: number;
  streak: StreakPayload;
}
