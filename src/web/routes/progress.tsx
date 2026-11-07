import { useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { Button } from '@/ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from '@/ui/card.js';
import { Progress } from '@/ui/progress.js';
import { masteryStateLabels } from '../mastery-labels.js';
import { progressQueryOptions } from '../queries.js';
import { RouteLoadError } from '../route-error.js';
import { PageSkeleton } from '../skeletons.js';

export const Route = createFileRoute('/progress')({
  pendingComponent: PageSkeleton,
  loader: ({ context }) => context.queryClient.ensureQueryData(progressQueryOptions()),
  errorComponent: () => <RouteLoadError message="Progress is unavailable." role="alert" />,
  component: ProgressPage,
});

const masteryStateOrder = ['retained', 'independent', 'assisted', 'introduced', 'not_assessed'];
const masteryStateColors: Record<string, string> = {
  not_assessed: 'bg-muted',
  introduced: 'bg-neutral-300',
  assisted: 'bg-amber-300',
  independent: 'bg-sky-400',
  retained: 'bg-emerald-500',
};

function ProgressPage() {
  const { data } = useSuspenseQuery(progressQueryOptions());
  const domains = data.domains.filter((domain) =>
    Object.values(domain.counts).some((count) => count > 0),
  );
  const recentAnswers = data.evidence.slice(0, 10);
  return (
    <section className="space-y-6">
      <h1 className="sr-only">Progress</h1>
      <Card>
        <CardHeader className="gap-0">
          <div className="grid grid-cols-3 divide-x">
            <div className="min-w-0 px-3 first:pl-0">
              <p className="text-xs text-muted-foreground">Concepts mastered</p>
              <p className="text-2xl font-semibold tabular-nums">
                {data.goal.mastered} / {data.goal.total}
              </p>
              <Progress
                aria-label="Concepts mastered"
                className="mt-2 h-1.5"
                value={data.goal.total ? (data.goal.mastered / data.goal.total) * 100 : 0}
              />
            </div>
            <div className="min-w-0 px-3">
              <p className="text-xs text-muted-foreground">Study time</p>
              <p className="text-2xl font-semibold tabular-nums">{data.hours.toFixed(1)} h</p>
              <p className="text-sm text-muted-foreground">of {data.planHours} h</p>
            </div>
            <div className="min-w-0 px-3 last:pr-0">
              <p className="text-xs text-muted-foreground">Streak</p>
              <p className="text-2xl font-semibold tabular-nums">{data.streakDays}</p>
              <p className="text-sm text-muted-foreground">days</p>
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
      {data.debt.length ? (
        <Card>
          <CardHeader>
            <CardTitle>Learning debt</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-3">
              {data.debt.map((item) => (
                <li key={`${item.conceptId}-${item.dimension}-${item.reason}`}>
                  <Button asChild variant="link" className="px-0">
                    <a href={item.studyUrl}>Study {item.title} now</a>
                  </Button>
                  <p className="text-sm text-muted-foreground">
                    {item.reason.replaceAll('_', ' ')} · {item.dimension}: {item.remediationAction}
                  </p>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle>Recent answers</CardTitle>
        </CardHeader>
        <CardContent>
          {recentAnswers.length ? (
            <ul className="divide-y">
              {recentAnswers.map((item) => {
                const correct = item.correct >= 1;
                const result = correct
                  ? 'Correct'
                  : item.correct === 0
                    ? 'Incorrect'
                    : 'Partly correct';
                return (
                  <li
                    key={item.id}
                    className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0"
                  >
                    <p className="min-w-0 font-medium">{item.conceptTitle}</p>
                    <div className="flex shrink-0 flex-col items-end text-right text-sm text-muted-foreground">
                      <span className={correct ? 'text-emerald-700 dark:text-emerald-300' : ''}>
                        {result}
                      </span>
                      <span>
                        {new Date(item.createdAt).toLocaleDateString(undefined, {
                          month: 'short',
                          day: 'numeric',
                        })}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No answers yet.</p>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
