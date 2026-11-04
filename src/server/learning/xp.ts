export const DAILY_XP_GOAL = {
  weekday: 60,
  saturday: 300,
  sunday: 60,
} as const;

const XP_PER_REMAINING_TOPIC = 40;
const DEFAULT_AVERAGE_DAILY_XP = (6 * DAILY_XP_GOAL.weekday + DAILY_XP_GOAL.saturday) / 7;
const DAY_MS = 86_400_000;

export interface XpEventDate {
  amount: number;
  localDate: string;
}

export interface LessonXpState {
  points: Array<{ status: string }>;
}

export function xpGoalFor(localDate: string): number {
  const weekday = new Date(`${localDate}T00:00:00.000Z`).getUTCDay();
  if (weekday === 6) return DAILY_XP_GOAL.saturday;
  if (weekday === 0) return DAILY_XP_GOAL.sunday;
  return DAILY_XP_GOAL.weekday;
}

export function estimateTaskXp(
  activity: { kind: string; plannedMinutes: number },
  lessonState?: LessonXpState,
): number {
  if (activity.kind === 'learn' && lessonState) {
    return lessonState.points.filter((point) => point.status !== 'passed').length * 10;
  }
  return activity.plannedMinutes;
}

export function weekXp(events: readonly XpEventDate[], todayLocal: string) {
  const monday = new Date(`${todayLocal}T00:00:00.000Z`);
  const daysSinceMonday = (monday.getUTCDay() + 6) % 7;
  monday.setUTCDate(monday.getUTCDate() - daysSinceMonday);
  const totals = new Map<string, number>();
  for (const event of events) {
    totals.set(event.localDate, (totals.get(event.localDate) ?? 0) + event.amount);
  }
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(monday);
    date.setUTCDate(monday.getUTCDate() + index);
    const localDate = date.toISOString().slice(0, 10);
    return { date: localDate, xp: totals.get(localDate) ?? 0, goal: xpGoalFor(localDate) };
  });
}

export function coursePercent(topicsDone: number, topicsTotal: number): number {
  return topicsTotal > 0 ? Math.round((topicsDone / topicsTotal) * 100) : 0;
}

export function averageDailyXp(events: readonly XpEventDate[], todayLocal: string): number {
  const firstDate = addLocalDays(todayLocal, -13);
  const total = events.reduce(
    (sum, event) =>
      event.localDate >= firstDate && event.localDate <= todayLocal ? sum + event.amount : sum,
    0,
  );
  return total / 14;
}

export function estimatedFinishDate(
  remainingTopics: number,
  avgDailyXp: number,
  today: string,
): string {
  const dailyXp = avgDailyXp > 0 ? avgDailyXp : DEFAULT_AVERAGE_DAILY_XP;
  const days = Math.ceil((Math.max(0, remainingTopics) * XP_PER_REMAINING_TOPIC) / dailyXp);
  return addLocalDays(today, days);
}

export function localDateKey(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function addLocalDays(localDate: string, days: number): string {
  const date = new Date(`${localDate}T00:00:00.000Z`);
  date.setTime(date.getTime() + days * DAY_MS);
  return date.toISOString().slice(0, 10);
}
