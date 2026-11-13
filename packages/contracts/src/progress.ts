export interface ProgressPayload {
  domains: Array<{ id: string; title: string; counts: Record<string, number> }>;
  goal: { mastered: number; total: number };
  hours: number;
  planHours: number;
  streakDays: number;
}
