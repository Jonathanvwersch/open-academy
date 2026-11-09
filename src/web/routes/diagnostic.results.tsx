import { useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { Button } from '@/ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from '@/ui/card.js';
import { diagnosticResultsQueryOptions, latestDiagnosticQueryOptions } from '../queries.js';
import { RouteLoadError } from '../route-error.js';
import { DiagnosticResultsSkeleton } from '../skeletons.js';

export const Route = createFileRoute('/diagnostic/results')({
  pendingComponent: DiagnosticResultsSkeleton,
  validateSearch: (search: Record<string, unknown>) => ({
    id: typeof search.id === 'string' ? search.id : undefined,
  }),
  loaderDeps: ({ search }) => ({ id: search.id }),
  loader: async ({ context, deps }) => {
    const candidateId = deps.id ?? window.sessionStorage.getItem('diagnosticRunId');
    if (candidateId) {
      try {
        await context.queryClient.ensureQueryData(diagnosticResultsQueryOptions(candidateId));
        return candidateId;
      } catch {
        // Resolve stale ids through the latest completed run.
      }
    }
    const latest = await context.queryClient.ensureQueryData(latestDiagnosticQueryOptions());
    await context.queryClient.ensureQueryData(diagnosticResultsQueryOptions(latest.id));
    return latest.id;
  },
  errorComponent: () => (
    <RouteLoadError message="Diagnostic results are unavailable." role="alert" />
  ),
  component: DiagnosticResultsPage,
});

function DiagnosticResultsPage() {
  const id = Route.useLoaderData();
  const { data: result } = useSuspenseQuery(diagnosticResultsQueryOptions(id));
  return (
    <section className="space-y-6">
      <div>
        <p className="text-sm text-muted-foreground">Diagnostic complete</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">Your starting point</h1>
      </div>
      <Card>
        <CardContent className="space-y-5">
          <p className="text-sm leading-6 text-muted-foreground">
            Results are provisional; independent practice will refine your mastery.
          </p>
          {result.domains.map((domain) => (
            <article key={domain.id} className="border-t pt-4">
              <div className="flex justify-between gap-4">
                <h2 className="font-semibold">{domain.title}</h2>
                <span className="text-sm text-muted-foreground">
                  {domain.outcome} · {domain.answers} answers
                </span>
              </div>
              <p className="mt-2 text-sm">
                <strong>Known provisionally:</strong>{' '}
                {domain.knownConcepts.length ? domain.knownConcepts.join(', ') : 'None identified'}
              </p>
              <p className="mt-1 text-sm">
                <strong>Gaps:</strong>{' '}
                {domain.gaps.length ? domain.gaps.join(', ') : 'None identified'}
              </p>
            </article>
          ))}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Your plan</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <h3 className="font-medium">
              First week: {result.plan.firstWeek?.title ?? 'No plan available'}
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Focus: {result.plan.firstWeekConcepts.join(', ')}
            </p>
          </div>
          <div>
            <h3 className="font-medium">First session</h3>
            <ul className="mt-2 space-y-2 text-sm">
              {result.plan.firstSession.map((activity) => (
                <li key={`${activity.kind}-${activity.conceptTitle ?? activity.reason.summary}`}>
                  <strong>{activity.kind.replace('_', ' ')}</strong>
                  {activity.conceptTitle ? ` · ${activity.conceptTitle}` : ''} ·{' '}
                  {activity.plannedMinutes} min
                  <span className="block text-muted-foreground">{activity.reason.summary}</span>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h3 className="font-medium">90-day path</h3>
            <ol className="mt-2 list-inside list-decimal space-y-1 text-sm text-muted-foreground">
              {result.plan.ninetyDayPath.map((week) => (
                <li key={week.week}>
                  Week {week.week}: {week.title}
                </li>
              ))}
            </ol>
          </div>
        </CardContent>
      </Card>
      <Button asChild>
        <a href="/">View Learn</a>
      </Button>
    </section>
  );
}
