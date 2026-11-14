import type { StreakPayload } from '@academy/contracts/progress';
import { Check, Flame } from 'lucide-react';
import { AcademyMascot } from '../../components/academy-mascot.js';
import { Card, CardContent } from '../../components/ui/card.js';

export function StreakCard({ streak }: { streak: StreakPayload }) {
  const message = streak.todayComplete
    ? 'You showed up today. See you tomorrow!'
    : streak.current > 0
      ? 'Earn XP today to keep your streak going.'
      : 'Earn your first XP today to start a streak.';
  return (
    <Card>
      <CardContent className="space-y-5 pt-5">
        <div className="flex items-center gap-3 sm:gap-5">
          <AcademyMascot
            celebrating={streak.todayComplete}
            className="size-24 shrink-0 sm:size-28"
          />
          <div className="min-w-0 space-y-1">
            <h2 className="flex items-center gap-2 text-xl font-semibold sm:text-2xl">
              <Flame className="size-5 shrink-0 text-amber-600" aria-hidden="true" />
              {streak.current}-day streak
            </h2>
            <p className="text-sm text-muted-foreground">{message}</p>
            <p className="text-xs text-muted-foreground">
              Best: {streak.longest} day{streak.longest === 1 ? '' : 's'}
            </p>
          </div>
        </div>
        <ol
          aria-label="Streak activity over the last seven days"
          className="grid grid-cols-7 gap-2"
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
                className="flex flex-col items-center gap-2"
                aria-label={`${day.date}${today ? ', today' : ''}: ${day.complete ? 'XP earned' : 'no XP earned'}`}
              >
                <span className="text-xs text-muted-foreground">{label}</span>
                <span
                  className={`flex size-8 items-center justify-center rounded-full border-2 sm:size-9 ${day.complete ? 'border-amber-500 bg-amber-100 text-amber-800' : today ? 'border-amber-500 border-dashed' : 'border-border bg-muted'}`}
                >
                  {day.complete ? (
                    <Check className="size-4" aria-hidden="true" />
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
        <p className="text-xs text-muted-foreground">
          Earn XP on consecutive days to build your streak. Each day follows your timezone in
          Settings.
        </p>
      </CardContent>
    </Card>
  );
}
