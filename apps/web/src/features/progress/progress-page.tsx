import { useSuspenseQuery } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card.js';
import { Progress } from '../../components/ui/progress.js';
import { masteryStateLabels } from './mastery-labels.js';
import { progressQueryOptions } from './queries.js';

const masteryStateOrder = ['retained', 'independent', 'assisted', 'introduced', 'not_assessed'];

const masteryStateColors: Record<string, string> = {
  not_assessed: 'bg-muted',
  introduced: 'bg-neutral-300',
  assisted: 'bg-amber-300',
  independent: 'bg-sky-400',
  retained: 'bg-emerald-500',
};

export function ProgressPage() {
  const { data } = useSuspenseQuery(progressQueryOptions());
  const domains = data.domains.filter((domain) =>
    Object.values(domain.counts).some((count) => count > 0),
  );
  return (
    <section className="space-y-6">
      <h1 className="sr-only">Progress</h1>
      <Card>
        <CardHeader className="gap-0">
          <div className="grid grid-cols-3 divide-x">
            <div className="min-w-0 px-3 first:pl-0">
              <p className="min-h-8 text-xs leading-4 text-muted-foreground sm:min-h-4">
                Concepts mastered
              </p>
              <p className="mt-1 whitespace-nowrap text-xl leading-8 font-semibold tabular-nums max-[360px]:text-lg sm:text-2xl">
                {data.goal.mastered} / {data.goal.total}
              </p>
              <div className="mt-1 flex h-5 items-center">
                <Progress
                  aria-label="Concepts mastered"
                  className="h-1.5"
                  value={data.goal.total ? (data.goal.mastered / data.goal.total) * 100 : 0}
                />
              </div>
            </div>
            <div className="min-w-0 px-3">
              <p className="min-h-8 text-xs leading-4 text-muted-foreground sm:min-h-4">
                Study time
              </p>
              <p className="mt-1 whitespace-nowrap text-xl leading-8 font-semibold tabular-nums max-[360px]:text-lg sm:text-2xl">
                {data.hours.toFixed(1)} h
              </p>
              <p className="mt-1 text-sm leading-5 text-muted-foreground">of {data.planHours} h</p>
            </div>
            <div className="min-w-0 px-3 last:pr-0">
              <p className="min-h-8 text-xs leading-4 text-muted-foreground sm:min-h-4">Streak</p>
              <p className="mt-1 whitespace-nowrap text-xl leading-8 font-semibold tabular-nums max-[360px]:text-lg sm:text-2xl">
                {data.streakDays}
              </p>
              <p className="mt-1 text-sm leading-5 text-muted-foreground">days</p>
            </div>
          </div>
        </CardHeader>
      </Card>
      {domains.length ? (
        <Card>
          <CardHeader>
            <CardTitle>Mastery by domain</CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            {domains.map((domain) => {
              const total = Object.values(domain.counts).reduce((sum, count) => sum + count, 0);
              const counts = masteryStateOrder
                .map(
                  (state) => [state, domain.counts[state as keyof typeof domain.counts]] as const,
                )
                .filter(([, count]) => count > 0);
              return (
                <div className="space-y-2" key={domain.id}>
                  <h3 className="font-medium">{domain.title}</h3>
                  <div
                    aria-label={counts
                      .map(([state, count]) => `${count} ${masteryStateLabels[state]}`)
                      .join(' · ')}
                    className="flex h-2 overflow-hidden rounded-full"
                    role="img"
                  >
                    {counts.map(([state, count]) => (
                      <span
                        key={state}
                        className={masteryStateColors[state]}
                        style={{ width: `${(count / total) * 100}%` }}
                      />
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {counts
                      .map(([state, count]) => `${count} ${masteryStateLabels[state]}`)
                      .join(' · ')}
                  </p>
                </div>
              );
            })}
          </CardContent>
        </Card>
      ) : null}
    </section>
  );
}
