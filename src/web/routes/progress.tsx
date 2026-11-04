import { useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { Button } from '@/ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from '@/ui/card.js';
import { Progress } from '@/ui/progress.js';
import { progressQueryOptions } from '../queries.js';
import { RouteLoadError } from '../route-error.js';

export const Route = createFileRoute('/progress')({
  loader: ({ context }) => context.queryClient.ensureQueryData(progressQueryOptions()),
  errorComponent: () => <RouteLoadError message="Progress is unavailable." role="alert" />,
  component: ProgressPage,
});

const masteryStateLabels: Record<string, string> = {
  not_assessed: 'Not assessed',
  introduced: 'Introduced',
  assisted: 'Assisted',
  independent: 'Independent',
  retained: 'Retained',
};

function ProgressPage() {
  const { data } = useSuspenseQuery(progressQueryOptions());
  return (
    <section className="mx-auto max-w-3xl space-y-6">
      <div>
        <p className="text-sm text-neutral-500">Learning overview</p>
        <h1 className="mt-1 text-3xl font-semibold">Progress</h1>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>90-day goals</CardTitle>
        </CardHeader>
        <CardContent>
          <p>
            {data.goal.mastered} of {data.goal.total} concepts independent or retained
          </p>
          <Progress
            className="mt-3"
            value={data.goal.total ? (data.goal.mastered / data.goal.total) * 100 : 0}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Mastery by domain</CardTitle>
        </CardHeader>
        <CardContent>
          {data.domains.map((domain) => (
            <div className="mt-4 border-t pt-3" key={domain.id}>
              <h3 className="font-medium">{domain.title}</h3>
              {Object.values(domain.counts).every((count) => count === 0) ? (
                <p className="text-sm text-muted-foreground">No lessons authored yet</p>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {Object.entries(domain.counts)
                    .map(([state, count]) => `${masteryStateLabels[state] ?? state}: ${count}`)
                    .join(' · ')}
                </p>
              )}
            </div>
          ))}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Learning debt</CardTitle>
        </CardHeader>
        <CardContent>
          {data.debt.length ? (
            <ul className="mt-3 space-y-3">
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
          ) : (
            <p className="mt-2 text-sm text-muted-foreground">No learning debt identified.</p>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Study time</CardTitle>
        </CardHeader>
        <CardContent>
          <p>
            {data.hours.toFixed(1)} of {data.planHours} hours · {data.streakDays}-day current streak
          </p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Recent evidence</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="space-y-2 text-sm">
            {data.evidence.map((item) => (
              <li key={item.id}>
                Attempt {item.exerciseId} ({item.conceptTitle}) → {item.correct} credit ·{' '}
                {new Date(item.createdAt).toLocaleDateString()} ·{' '}
                {item.event ?? 'no mastery-state change'}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </section>
  );
}
