import { useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { diagnosticResultsQueryOptions, latestDiagnosticQueryOptions } from '../queries.js';
import { RouteLoadError } from '../route-error.js';

export const Route = createFileRoute('/diagnostic/results')({
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
    <section className="mx-auto max-w-3xl space-y-6">
      <div>
        <p className="text-sm text-neutral-500">Diagnostic complete</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">Your starting point</h1>
      </div>
      <div className="space-y-5 rounded-xl border border-neutral-200 bg-white p-6">
        <p className="text-sm leading-6 text-neutral-700">
          Results are provisional; independent practice will refine your mastery.
        </p>
        {result.domains.map((domain) => (
          <article key={domain.id} className="border-t border-neutral-100 pt-4">
            <div className="flex justify-between gap-4">
              <h2 className="font-semibold">{domain.title}</h2>
              <span className="text-sm text-neutral-500">
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
      </div>
      <section className="space-y-4 rounded-xl border border-neutral-200 bg-white p-6">
        <h2 className="text-xl font-semibold">Your plan</h2>
        <div>
          <h3 className="font-medium">
            First week: {result.plan.firstWeek?.title ?? 'No plan available'}
          </h3>
          <p className="mt-1 text-sm text-neutral-600">
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
                <span className="block text-neutral-600">{activity.reason.summary}</span>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h3 className="font-medium">90-day path</h3>
          <ol className="mt-2 list-inside list-decimal space-y-1 text-sm text-neutral-600">
            {result.plan.ninetyDayPath.map((week) => (
              <li key={week.week}>
                Week {week.week}: {week.title}
              </li>
            ))}
          </ol>
        </div>
      </section>
      <a
        href="/"
        className="inline-flex rounded-md bg-blue-700 px-4 py-2 text-sm font-medium text-white"
      >
        View Today
      </a>
    </section>
  );
}
