import type { StreakPayload } from '@open-academy/engine/api';
import { Check } from 'lucide-react';
import { AcademyMascot } from '../../components/academy-mascot.js';
import { Card, CardContent } from '../../components/ui/card.js';

export function StreakCard({ streak }: { streak: StreakPayload }) {
  const message = streak.todayComplete
    ? "Today's streak is complete."
    : streak.current > 0
      ? 'Earn XP today to keep your streak going.'
      : 'Earn your first XP today to start a streak.';
  return (
    <Card data-testid="streak-card">
      <CardContent className="flex flex-col gap-4 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:gap-5">
        <div className="flex min-w-0 items-center gap-3">
          <AcademyMascot celebrating={streak.todayComplete} className="size-14 shrink-0" />
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <h2 className="text-base font-semibold">{streak.current}-day streak</h2>
              <span className="text-xs text-muted-foreground">Best: {streak.longest}</span>
            </div>
            <p className="text-sm text-muted-foreground">{message}</p>
          </div>
        </div>
        <ol
          aria-label="Streak activity over the last seven days"
          className="grid shrink-0 grid-cols-7 gap-2 sm:gap-2.5"
        >
          {streak.days.map((day, index) => {
            const today = index === streak.days.length - 1;
            const label = new Date(`${day.date}T12:00:00Z`).toLocaleDateString('en-US', {
              weekday: 'short',
              timeZone: 'UTC',
            });
            return (
              <li
                key={day.date}
                aria-current={today ? 'date' : undefined}
                className="flex flex-col items-center gap-1.5"
                aria-label={`${day.date}${today ? ', today' : ''}: ${day.complete ? 'XP earned' : 'no XP earned'}`}
              >
                <span className="text-xs text-muted-foreground">{label}</span>
                <span
                  className={`flex size-7 items-center justify-center rounded-full border ${day.complete ? 'border-companion/40 bg-companion/10 text-[#515d3d] dark:text-[#b9bf91]' : today ? 'border-companion border-dashed' : 'border-border bg-muted'}`}
                >
                  {day.complete ? (
                    <Check className="size-3.5" aria-hidden="true" />
                  ) : (
                    <span
                      aria-hidden="true"
                      className="size-1 rounded-full bg-muted-foreground/40"
                    />
                  )}
                </span>
              </li>
            );
          })}
        </ol>
      </CardContent>
    </Card>
  );
}
