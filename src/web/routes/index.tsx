import { useMutation, useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { Button } from '@/ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from '@/ui/card.js';
import { todayQueryOptions } from '../queries.js';
import { RouteLoadError } from '../route-error.js';

export const Route = createFileRoute('/')({
  loader: ({ context }) => context.queryClient.ensureQueryData(todayQueryOptions()),
  errorComponent: () => (
    <RouteLoadError message="Your plan is unavailable." className="text-sm text-destructive" />
  ),
  component: TodayPage,
});

function TodayPage() {
  const { data: plan } = useSuspenseQuery(todayQueryOptions());
  const startSession = useMutation({
    mutationFn: async () => {
      const response = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          budgetMinutes: plan.budgetMinutes,
          kind: plan.sessionKind,
        }),
      });
      if (!response.ok) throw new Error('Could not start session');
      return response.json() as Promise<{ id: string }>;
    },
    onSuccess: ({ id }) => {
      window.location.href = `/session/${id}`;
    },
  });

  if (plan.needsDiagnostic) {
    return (
      <section className="mx-auto max-w-3xl space-y-8">
        <div>
          <p className="text-sm text-neutral-500">Week {plan.week}</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">Today</h1>
        </div>
        <Card>
          <CardHeader>
            <CardTitle>Welcome to Academy</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="max-w-[70ch] text-sm leading-6 text-muted-foreground">
              Begin with a short diagnostic so your first sessions start at the right level.
            </p>
            <Button asChild>
              <a
                href={
                  plan.diagnosticActive && plan.diagnosticRunId
                    ? `/diagnostic?runId=${plan.diagnosticRunId}`
                    : '/diagnostic'
                }
              >
                {plan.diagnosticActive ? 'Resume diagnostic' : 'Start diagnostic'}
              </a>
            </Button>
          </CardContent>
        </Card>
      </section>
    );
  }
  return (
    <section className="mx-auto max-w-3xl space-y-8">
      <div className="flex items-end justify-between">
        <div>
          <p className="text-sm text-neutral-500">
            Week {plan.week} · {plan.weekTitle}
          </p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">Today</h1>
        </div>
        <p className="text-sm text-neutral-600">
          {plan.dueReviews} review{plan.dueReviews === 1 ? '' : 's'} due
        </p>
      </div>
      {plan.dueReviews > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Reviews due</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-1 text-sm text-muted-foreground">
              {plan.plan.activities
                .filter((activity) => activity.kind === 'review')
                .map((activity) => (
                  <li
                    key={`${activity.kind}-${activity.conceptId ?? 'review'}-${activity.reason.summary}`}
                  >
                    Review · {activity.conceptTitle ?? activity.conceptId ?? 'saved material'} ·{' '}
                    {activity.plannedMinutes} min
                  </li>
                ))}
              {!plan.plan.activities.some((activity) => activity.kind === 'review') ? (
                <li>
                  {plan.dueReviews} review{plan.dueReviews === 1 ? '' : 's'} ready to schedule.
                </li>
              ) : null}
            </ul>
          </CardContent>
        </Card>
      ) : null}
      {plan.activeSessionId ? (
        <Button asChild>
          <a href={`/session/${plan.activeSessionId}`}>Resume session</a>
        </Button>
      ) : (
        <div className="space-y-4">
          <div>
            <h2 className="text-lg font-semibold">
              Planned session · {plan.budgetMinutes} minutes
            </h2>
            <Card className="mt-3 p-0">
              <ul className="divide-y">
                {plan.plan.activities.map((activity, index) => (
                  <li
                    key={`${activity.kind}-${activity.conceptId ?? index}`}
                    className="flex items-start justify-between gap-4 p-4"
                  >
                    <div>
                      <p className="font-medium capitalize">
                        {activity.kind.replace('_', ' ')}
                        {activity.conceptId
                          ? ` · ${activity.conceptTitle ?? activity.conceptId}`
                          : ''}
                      </p>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {activity.reason.summary}
                      </p>
                    </div>
                    <span className="shrink-0 text-sm text-muted-foreground">
                      {activity.plannedMinutes} min
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          </div>
          <Button
            type="button"
            onClick={() => startSession.mutate()}
            disabled={startSession.isPending}
          >
            {startSession.isPending ? 'Starting…' : 'Start session'}
          </Button>
        </div>
      )}
    </section>
  );
}
